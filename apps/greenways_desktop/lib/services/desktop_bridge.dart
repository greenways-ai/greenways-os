import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../model/connection_snapshot.dart';
import '../model/setup_snapshot.dart';

abstract interface class DesktopBridge {
  Future<DesktopConnectionSnapshot> connect();
  Future<DesktopConnectionSnapshot> refresh();
  Future<DesktopConnectionSnapshot> disconnect();
  Future<DesktopSetupSnapshot> performSetup(
    DesktopSetupOperation operation, {
    String? handle,
  });
  Future<void> close();
}

final class DesktopBridgeUnavailable implements Exception {
  const DesktopBridgeUnavailable(this.message);

  final String message;

  @override
  String toString() => message;
}

const _maximumBridgeResponseBytes = 256 * 1024;

final class ProcessDesktopBridge implements DesktopBridge {
  ProcessDesktopBridge({this._executableOverride});

  final String? _executableOverride;
  final Map<String, Completer<DesktopConnectionSnapshot>> _pendingConnections =
      {};
  final Map<String, Completer<DesktopSetupSnapshot>> _pendingSetup = {};
  Process? _process;
  StreamSubscription<String>? _stdoutSubscription;
  StreamSubscription<String>? _stderrSubscription;
  int _sequence = 0;
  bool _closing = false;

  @override
  Future<DesktopConnectionSnapshot> connect() => _sendConnection('connect');

  @override
  Future<DesktopConnectionSnapshot> refresh() => _sendConnection('refresh');

  @override
  Future<DesktopConnectionSnapshot> disconnect() =>
      _sendConnection('disconnect');

  @override
  Future<DesktopSetupSnapshot> performSetup(
    DesktopSetupOperation operation, {
    String? handle,
  }) => _sendSetup(operation.wireName, handle: handle);

  Future<DesktopConnectionSnapshot> _sendConnection(String command) async {
    await _ensureProcess();
    final process = _requireProcess();
    final requestId = _nextRequestId();
    final completer = Completer<DesktopConnectionSnapshot>();
    _pendingConnections[requestId] = completer;
    await _writeRequest(
      process,
      jsonEncode({
        'protocol': desktopBridgeProtocol,
        'requestId': requestId,
        'command': command,
      }),
      onFailure: () => _pendingConnections.remove(requestId),
    );
    return _awaitResponse(
      completer,
      onTimeout: () => _pendingConnections.remove(requestId),
    );
  }

  Future<DesktopSetupSnapshot> _sendSetup(
    String operation, {
    required String? handle,
  }) async {
    await _ensureProcess();
    final process = _requireProcess();
    final requestId = _nextRequestId();
    final completer = Completer<DesktopSetupSnapshot>();
    _pendingSetup[requestId] = completer;
    await _writeRequest(
      process,
      jsonEncode({
        'protocol': desktopSetupProtocol,
        'requestId': requestId,
        'operation': operation,
        'handle': handle,
      }),
      onFailure: () => _pendingSetup.remove(requestId),
    );
    return _awaitResponse(
      completer,
      onTimeout: () => _pendingSetup.remove(requestId),
    );
  }

  Process _requireProcess() {
    final process = _process;
    if (process == null) {
      throw const DesktopBridgeUnavailable(
        'The Greenways Desktop companion is unavailable.',
      );
    }
    return process;
  }

  Future<void> _writeRequest(
    Process process,
    String request, {
    required void Function() onFailure,
  }) async {
    try {
      process.stdin.writeln(request);
      await process.stdin.flush();
    } on Object {
      onFailure();
      await _resetProcess();
      throw const DesktopBridgeUnavailable(
        'The Greenways Desktop companion connection was interrupted.',
      );
    }
  }

  Future<T> _awaitResponse<T>(
    Completer<T> completer, {
    required void Function() onTimeout,
  }) async {
    try {
      return await completer.future.timeout(const Duration(seconds: 6));
    } on TimeoutException {
      onTimeout();
      await _resetProcess();
      throw const DesktopBridgeUnavailable(
        'The Greenways Desktop companion did not respond.',
      );
    }
  }

  Future<void> _ensureProcess() async {
    if (_process != null) return;
    if (_closing) {
      throw const DesktopBridgeUnavailable(
        'The Greenways Desktop companion is shutting down.',
      );
    }
    final executable = _resolveExecutable();
    if (executable == null) {
      throw const DesktopBridgeUnavailable(
        'The Greenways Desktop companion is not installed in this app bundle.',
      );
    }
    try {
      final process = await Process.start(
        executable,
        const [],
        mode: ProcessStartMode.normal,
        runInShell: false,
      );
      _process = process;
      _stdoutSubscription = process.stdout
          .transform(utf8.decoder)
          .transform(const LineSplitter())
          .listen(_handleLine, onError: _handleTransportError);
      _stderrSubscription = process.stderr
          .transform(utf8.decoder)
          .listen((_) {}, onError: (_) {});
      unawaited(process.exitCode.then((_) => _handleExit(process)));
    } on ProcessException {
      throw const DesktopBridgeUnavailable(
        'The Greenways Desktop companion could not be started.',
      );
    }
  }

  String? _resolveExecutable() {
    final override =
        _executableOverride ??
        (kDebugMode ? Platform.environment['GREENWAYS_DESKTOP_BRIDGE'] : null);
    if (override != null &&
        override.isNotEmpty &&
        File(override).existsSync()) {
      return override;
    }
    if (!Platform.isMacOS) return null;
    final executable = File(Platform.resolvedExecutable);
    final contents = executable.parent.parent;
    final bundled = File(
      '${contents.path}${Platform.pathSeparator}Resources'
      '${Platform.pathSeparator}greenways-desktop-bridge',
    );
    return bundled.existsSync() ? bundled.path : null;
  }

  String _nextRequestId() {
    _sequence = (_sequence + 1) & 0x7fffffff;
    final time = DateTime.now().microsecondsSinceEpoch.toRadixString(16);
    final sequence = _sequence.toRadixString(16).padLeft(8, '0');
    return 'desktop/request/$time$sequence';
  }

  void _handleLine(String line) {
    try {
      if (utf8.encode(line).length > _maximumBridgeResponseBytes) {
        throw const FormatException('Desktop bridge response is too large.');
      }
      final decoded = _asStringObject(jsonDecode(line));
      final protocol = decoded['protocol'];
      if (protocol == desktopBridgeResultProtocol) {
        final response = DesktopBridgeResponse.fromJson(decoded);
        final completer = _pendingConnections.remove(response.requestId);
        if (completer == null) {
          throw const FormatException(
            'Desktop connection response is unsolicited.',
          );
        }
        completer.complete(response.snapshot);
        return;
      }
      if (protocol == desktopSetupResultProtocol) {
        final response = DesktopSetupResponse.fromJson(decoded);
        final completer = _pendingSetup.remove(response.requestId);
        if (completer == null) {
          throw const FormatException('Desktop setup response is unsolicited.');
        }
        completer.complete(response.snapshot);
        return;
      }
      throw const FormatException(
        'Desktop bridge response protocol is unknown.',
      );
    } on Object {
      _failPending(
        const DesktopBridgeUnavailable(
          'The Greenways Desktop companion returned an invalid response.',
        ),
      );
      unawaited(_resetProcess());
    }
  }

  Map<String, Object?> _asStringObject(Object? value) {
    if (value is! Map) {
      throw const FormatException('Desktop bridge response must be an object.');
    }
    return value.map((key, entry) {
      if (key is! String) {
        throw const FormatException(
          'Desktop bridge response has a non-text key.',
        );
      }
      return MapEntry(key, entry);
    });
  }

  void _handleTransportError(Object _) {
    _failPending(
      const DesktopBridgeUnavailable(
        'The Greenways Desktop companion connection was interrupted.',
      ),
    );
    unawaited(_resetProcess());
  }

  void _handleExit(Process process) {
    if (!identical(_process, process)) return;
    _process = null;
    _failPending(
      const DesktopBridgeUnavailable(
        'The Greenways Desktop companion stopped.',
      ),
    );
  }

  void _failPending(Object error) {
    final pendingConnections = _pendingConnections.values.toList(
      growable: false,
    );
    final pendingSetup = _pendingSetup.values.toList(growable: false);
    _pendingConnections.clear();
    _pendingSetup.clear();
    for (final completer in pendingConnections) {
      if (!completer.isCompleted) completer.completeError(error);
    }
    for (final completer in pendingSetup) {
      if (!completer.isCompleted) completer.completeError(error);
    }
  }

  Future<void> _resetProcess() async {
    final process = _process;
    _process = null;
    await _stdoutSubscription?.cancel();
    await _stderrSubscription?.cancel();
    _stdoutSubscription = null;
    _stderrSubscription = null;
    process?.kill(ProcessSignal.sigterm);
  }

  @override
  Future<void> close() async {
    if (_closing) return;
    _closing = true;
    final process = _process;
    if (process != null) {
      try {
        final requestId = _nextRequestId();
        process.stdin.writeln(
          jsonEncode({
            'protocol': desktopBridgeProtocol,
            'requestId': requestId,
            'command': 'quit',
          }),
        );
        await process.stdin.flush();
      } on Object {
        // Process teardown remains best-effort and never changes daemon state.
      }
    }
    await _resetProcess();
    _failPending(
      const DesktopBridgeUnavailable(
        'The Greenways Desktop companion was closed.',
      ),
    );
  }
}

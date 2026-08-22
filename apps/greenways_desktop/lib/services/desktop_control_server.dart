import 'dart:async';
import 'dart:convert';
import 'dart:io';

import '../controller/connection_controller.dart';
import '../model/connection_snapshot.dart';

const desktopControlProtocol = 'greenways-desktop-control/0-alpha';
const desktopControlResultProtocol = 'greenways-desktop-control-result/0-alpha';
const desktopControlSocketName = 'greenways-desktop.sock';
const _maximumRequestBytes = 8 * 1024;
const _requestTimeout = Duration(seconds: 5);
const _probeTimeout = Duration(milliseconds: 150);

final _requestIdPattern = RegExp(r'^desktop/control/[A-Za-z0-9._:-]{8,160}$');

final class DesktopControlServer {
  factory DesktopControlServer(
    ConnectionController controller, {
    required Future<void> Function() showWindow,
    required Future<void> Function() quit,
    String? home,
  }) {
    final homeOverride = home == null || home.isEmpty ? null : home;
    return DesktopControlServer._(controller, showWindow, quit, homeOverride);
  }

  DesktopControlServer._(
    this.controller,
    this.showWindow,
    this.quit,
    this._home,
  );

  final ConnectionController controller;
  final Future<void> Function() showWindow;
  final Future<void> Function() quit;
  final String? _home;
  ServerSocket? _server;
  StreamSubscription<Socket>? _subscription;
  String? _socketPath;
  bool _commandActive = false;
  bool _closing = false;
  int _rejectionSequence = 0;

  String? get socketPath => _socketPath;

  Future<void> start() async {
    if (_server != null) return;
    final home = _resolveHome();
    final runDirectory = '$home/run';
    await _prepareRunDirectory(runDirectory);
    final socketPath = '$runDirectory/$desktopControlSocketName';
    await _prepareSocketPath(socketPath);
    final server = await ServerSocket.bind(
      InternetAddress(socketPath, type: InternetAddressType.unix),
      0,
      shared: false,
    );
    try {
      await _chmod(socketPath, '0600');
      final stat = await FileStat.stat(socketPath);
      if (stat.type != FileSystemEntityType.unixDomainSock ||
          _permissionBits(stat.mode) != 0x180) {
        throw const FileSystemException(
          'Greenways Desktop control socket permissions are unsafe.',
        );
      }
      _socketPath = socketPath;
      _server = server;
      _subscription = server.listen(
        (socket) => unawaited(_serve(socket)),
        cancelOnError: false,
      );
    } on Object {
      await server.close();
      await _removeOwnedSocket(socketPath);
      rethrow;
    }
  }

  Future<void> close() async {
    if (_closing) return;
    _closing = true;
    final subscription = _subscription;
    _subscription = null;
    if (subscription != null) await subscription.cancel();
    final server = _server;
    _server = null;
    if (server != null) await server.close();
    final path = _socketPath;
    _socketPath = null;
    if (path != null) await _removeOwnedSocket(path);
    _closing = false;
  }

  String _resolveHome() {
    final explicit = _home;
    if (explicit != null && explicit.isNotEmpty) return explicit;
    final configured = Platform.environment['GREENWAYS_HOME'];
    if (configured != null && configured.isNotEmpty) return configured;
    final home = Platform.environment['HOME'];
    if (home == null || home.isEmpty) {
      throw const FileSystemException(
        'HOME is unavailable; GREENWAYS_HOME must be configured.',
      );
    }
    return '$home/.greenways';
  }

  Future<void> _prepareRunDirectory(String path) async {
    final type = await FileSystemEntity.type(path, followLinks: false);
    switch (type) {
      case FileSystemEntityType.notFound:
        await Directory(path).create(recursive: true);
        break;
      case FileSystemEntityType.directory:
        break;
      default:
        throw const FileSystemException(
          'Greenways run path is not a private directory.',
        );
    }
    await _chmod(path, '0700');
    final stat = await FileStat.stat(path);
    if (stat.type != FileSystemEntityType.directory ||
        _permissionBits(stat.mode) != 0x1c0) {
      throw const FileSystemException(
        'Greenways run directory permissions are unsafe.',
      );
    }
  }

  Future<void> _prepareSocketPath(String path) async {
    final type = await FileSystemEntity.type(path, followLinks: false);
    if (type == FileSystemEntityType.notFound) return;
    if (type != FileSystemEntityType.unixDomainSock) {
      throw const FileSystemException(
        'Greenways Desktop control path is not a Unix socket.',
      );
    }
    final before = await FileStat.stat(path);
    if (_permissionBits(before.mode) != 0x180) {
      throw const FileSystemException(
        'Stale Greenways Desktop control socket permissions are unsafe.',
      );
    }
    try {
      final socket = await Socket.connect(
        InternetAddress(path, type: InternetAddressType.unix),
        0,
        timeout: _probeTimeout,
      );
      socket.destroy();
      throw const FileSystemException(
        'Another Greenways Desktop control server is already running.',
      );
    } on SocketException {
      final after = await FileStat.stat(path);
      if (after.type != FileSystemEntityType.unixDomainSock ||
          after.changed != before.changed ||
          after.modified != before.modified ||
          _permissionBits(after.mode) != 0x180) {
        throw const FileSystemException(
          'Greenways Desktop control socket changed during stale recovery.',
        );
      }
      await File(path).delete();
    }
  }

  Future<void> _serve(Socket socket) async {
    String requestId = _rejectionRequestId();
    _CommandResult? result;
    try {
      final frame = await _readFrame(socket);
      final request = _decodeRequest(frame);
      requestId = request.requestId;
      if (_commandActive || controller.busy) {
        await _writeError(
          socket,
          requestId,
          'desktop-busy',
          'Greenways Desktop is already processing a command.',
        );
        return;
      }
      _commandActive = true;
      try {
        result = await _dispatch(request.command);
      } finally {
        _commandActive = false;
      }
      await _writeSuccess(socket, requestId, result.snapshot);
    } on _DesktopControlException catch (error) {
      requestId = error.requestId ?? requestId;
      await _writeError(socket, requestId, error.code, error.message);
    } on TimeoutException {
      await _writeError(
        socket,
        requestId,
        'invalid-request',
        'Desktop control request timed out.',
      );
    } on FormatException {
      await _writeError(
        socket,
        requestId,
        'invalid-request',
        'Desktop control request was invalid.',
      );
    } on Object {
      await _writeError(
        socket,
        requestId,
        'desktop-internal',
        'Greenways Desktop could not complete the command.',
      );
    } finally {
      await socket.close();
    }
    final afterResponse = result?.afterResponse;
    if (afterResponse != null) await afterResponse();
  }

  Future<List<int>> _readFrame(Socket socket) async {
    final bytes = await socket
        .fold<List<int>>(<int>[], (buffer, data) {
          if (buffer.length + data.length > _maximumRequestBytes + 1) {
            throw const FormatException(
              'Desktop control request is too large.',
            );
          }
          buffer.addAll(data);
          return buffer;
        })
        .timeout(_requestTimeout);
    if (bytes.isEmpty || bytes.length > _maximumRequestBytes + 1) {
      throw const FormatException(
        'Desktop control request is empty or too large.',
      );
    }
    if (bytes.last != 0x0a || bytes.take(bytes.length - 1).contains(0x0a)) {
      throw const FormatException(
        'Desktop control accepts exactly one newline-delimited JSON frame.',
      );
    }
    return bytes.sublist(0, bytes.length - 1);
  }

  _DesktopControlRequest _decodeRequest(List<int> frame) {
    final Object? decoded = jsonDecode(
      utf8.decode(frame, allowMalformed: false),
    );
    final request = _object(decoded, 'request');
    final attributableRequestId = _attributableRequestId(request['requestId']);
    try {
      _requireExactKeys(request, const {'protocol', 'requestId', 'command'});
      final protocol = _text(request, 'protocol', maximum: 120);
      final requestId = _text(request, 'requestId', maximum: 180);
      final command = _text(request, 'command', maximum: 40);
      if (protocol != desktopControlProtocol ||
          !_requestIdPattern.hasMatch(requestId)) {
        throw const FormatException(
          'Desktop control request protocol is invalid.',
        );
      }
      if (!const {
        'status',
        'connect',
        'refresh',
        'disconnect',
        'show-window',
        'quit',
      }.contains(command)) {
        throw const FormatException('Desktop control command is unsupported.');
      }
      return _DesktopControlRequest(requestId: requestId, command: command);
    } on FormatException {
      throw _DesktopControlException(
        'invalid-request',
        'Desktop control request was invalid.',
        requestId: attributableRequestId,
      );
    }
  }

  Future<_CommandResult> _dispatch(String command) async {
    switch (command) {
      case 'status':
        break;
      case 'connect':
        await controller.connect();
        break;
      case 'refresh':
        await controller.refresh();
        break;
      case 'disconnect':
        await controller.disconnect();
        break;
      case 'show-window':
        await showWindow();
        break;
      case 'quit':
        return _CommandResult(
          snapshot: controller.snapshot,
          afterResponse: quit,
        );
      default:
        throw const _DesktopControlException(
          'invalid-request',
          'Desktop control command is unsupported.',
        );
    }
    return _CommandResult(snapshot: controller.snapshot);
  }

  Future<void> _writeSuccess(
    Socket socket,
    String requestId,
    DesktopConnectionSnapshot snapshot,
  ) => _write(socket, {
    'protocol': desktopControlResultProtocol,
    'requestId': requestId,
    'outcome': 'ok',
    'snapshot': snapshot.toJson(),
    'error': null,
  });

  Future<void> _writeError(
    Socket socket,
    String requestId,
    String code,
    String message,
  ) => _write(socket, {
    'protocol': desktopControlResultProtocol,
    'requestId': requestId,
    'outcome': 'error',
    'snapshot': null,
    'error': {'code': code, 'message': message},
  });

  Future<void> _write(Socket socket, Map<String, Object?> response) async {
    socket.add(utf8.encode('${jsonEncode(response)}\n'));
    await socket.flush();
  }

  String _rejectionRequestId() {
    _rejectionSequence += 1;
    return 'desktop/control/rejected-'
        '${DateTime.now().microsecondsSinceEpoch}-$_rejectionSequence';
  }

  Future<void> _removeOwnedSocket(String path) async {
    final type = await FileSystemEntity.type(path, followLinks: false);
    if (type == FileSystemEntityType.notFound) return;
    if (type != FileSystemEntityType.unixDomainSock) {
      throw const FileSystemException(
        'Refusing to remove a non-socket Desktop control path.',
      );
    }
    await File(path).delete();
  }

  Future<void> _chmod(String path, String mode) async {
    final result = await Process.run('/bin/chmod', [mode, path]);
    if (result.exitCode != 0) {
      throw const FileSystemException(
        'Could not enforce Greenways Desktop control permissions.',
      );
    }
  }
}

final class _DesktopControlRequest {
  const _DesktopControlRequest({
    required this.requestId,
    required this.command,
  });

  final String requestId;
  final String command;
}

final class _CommandResult {
  const _CommandResult({required this.snapshot, this.afterResponse});

  final DesktopConnectionSnapshot snapshot;
  final Future<void> Function()? afterResponse;
}

final class _DesktopControlException implements Exception {
  const _DesktopControlException(this.code, this.message, {this.requestId});

  final String code;
  final String message;
  final String? requestId;
}

String? _attributableRequestId(Object? value) {
  if (value is! String || value.length > 180) return null;
  return _requestIdPattern.hasMatch(value) ? value : null;
}

Map<String, Object?> _object(Object? value, String field) {
  if (value is! Map) {
    throw FormatException('$field must be an object.');
  }
  return value.map((key, entry) {
    if (key is! String) {
      throw FormatException('$field contains a non-text key.');
    }
    return MapEntry(key, entry);
  });
}

void _requireExactKeys(Map<String, Object?> value, Set<String> expected) {
  final actual = value.keys.toSet();
  if (actual.length != expected.length || !actual.containsAll(expected)) {
    throw const FormatException(
      'Desktop control request contains missing or unknown fields.',
    );
  }
}

String _text(Map<String, Object?> value, String field, {required int maximum}) {
  final text = value[field];
  if (text is! String ||
      text.isEmpty ||
      text.length > maximum ||
      text.runes.any((rune) => rune < 0x20 || rune == 0x7f)) {
    throw FormatException('$field must be bounded public text.');
  }
  return text;
}

int _permissionBits(int mode) => mode & 0x1ff;

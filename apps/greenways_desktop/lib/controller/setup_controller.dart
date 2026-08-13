import 'dart:async';

import 'package:flutter/foundation.dart';

import '../model/setup_snapshot.dart';
import '../services/desktop_bridge.dart';

final class SetupController extends ChangeNotifier {
  SetupController(this._bridge)
    : _snapshot = DesktopSetupSnapshot.notInspected();

  final DesktopBridge _bridge;
  DesktopSetupSnapshot _snapshot;
  bool _busy = false;
  bool _disposed = false;

  DesktopSetupSnapshot get snapshot => _snapshot;
  bool get busy => _busy;

  Future<void> inspect() async {
    if (_busy || _disposed) return;
    _busy = true;
    _snapshot = DesktopSetupSnapshot.inspecting();
    _notify();
    try {
      _snapshot = await _bridge.inspectSetup();
    } on DesktopBridgeUnavailable catch (error) {
      _snapshot = DesktopSetupSnapshot.failed(error.message);
    } on Object {
      _snapshot = DesktopSetupSnapshot.failed(
        'The Greenways Desktop setup inspection could not be completed.',
      );
    } finally {
      _busy = false;
      _notify();
    }
  }

  String diagnosticsJson() => _snapshot.diagnosticsJson();

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> shutdown() async {
    if (_disposed) return;
    await _bridge.close();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    unawaited(_bridge.close());
    super.dispose();
  }
}

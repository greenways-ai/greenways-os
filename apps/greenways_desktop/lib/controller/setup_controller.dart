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

  Future<void> inspect() => perform(DesktopSetupOperation.inspect);

  Future<void> installDaemon() => perform(DesktopSetupOperation.installDaemon);

  Future<void> issueDesktopClient() =>
      perform(DesktopSetupOperation.issueDesktopClient);

  Future<void> createIdentity(String handle) {
    final normalized = normalizeDesktopIdentityHandle(handle);
    if (normalized == null) return Future.value();
    return perform(DesktopSetupOperation.createIdentity, handle: normalized);
  }

  Future<void> repairPermissions() =>
      perform(DesktopSetupOperation.repairPermissions);

  Future<void> perform(
    DesktopSetupOperation operation, {
    String? handle,
  }) async {
    if (_busy || _disposed) return;
    if (operation == DesktopSetupOperation.createIdentity) {
      if (handle == null || normalizeDesktopIdentityHandle(handle) != handle) {
        return;
      }
    } else if (handle != null) {
      return;
    }
    if (!_snapshot.permittedActions.contains(operation)) return;
    _busy = true;
    _snapshot = DesktopSetupSnapshot.inspecting();
    _notify();
    try {
      _snapshot = await _bridge.performSetup(operation, handle: handle);
    } on DesktopBridgeUnavailable catch (error) {
      _snapshot = DesktopSetupSnapshot.failed(error.message);
    } on Object {
      _snapshot = DesktopSetupSnapshot.failed(
        'The Greenways Desktop setup operation could not be completed.',
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

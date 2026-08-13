import 'dart:async';

import 'package:flutter/foundation.dart';

import '../model/connection_snapshot.dart';
import '../services/desktop_bridge.dart';

final class ConnectionController extends ChangeNotifier {
  ConnectionController(
    this._bridge, {
    this._refreshInterval = const Duration(seconds: 30),
    this._autoRefresh = true,
  }) : _snapshot = DesktopConnectionSnapshot.disconnected();

  final DesktopBridge _bridge;
  final Duration _refreshInterval;
  final bool _autoRefresh;
  DesktopConnectionSnapshot _snapshot;
  Timer? _refreshTimer;
  bool _busy = false;
  bool _disposed = false;

  DesktopConnectionSnapshot get snapshot => _snapshot;
  bool get busy => _busy;

  Future<void> connect() =>
      _perform(operation: _bridge.connect, showConnecting: true);

  Future<void> reconnect() async {
    if (_busy || _disposed) return;
    await _perform(operation: _bridge.disconnect);
    await connect();
  }

  Future<void> refresh() => _perform(operation: _bridge.refresh);

  Future<void> disconnect() => _perform(operation: _bridge.disconnect);

  Future<void> _perform({
    required Future<DesktopConnectionSnapshot> Function() operation,
    bool showConnecting = false,
  }) async {
    if (_busy || _disposed) return;
    _busy = true;
    _refreshTimer?.cancel();
    if (showConnecting) {
      _snapshot = DesktopConnectionSnapshot.connecting();
    }
    _notify();
    try {
      _snapshot = await operation();
    } on DesktopBridgeUnavailable catch (error) {
      _snapshot = DesktopConnectionSnapshot.bridgeUnavailable(error.message);
    } on Object {
      _snapshot = DesktopConnectionSnapshot.bridgeUnavailable(
        'The Greenways Desktop connection could not be completed.',
      );
    } finally {
      _busy = false;
      _scheduleRefresh();
      _notify();
    }
  }

  void _scheduleRefresh() {
    _refreshTimer?.cancel();
    if (_autoRefresh && _snapshot.isConnected && !_disposed) {
      _refreshTimer = Timer(_refreshInterval, refresh);
    }
  }

  String diagnosticsJson() => _snapshot.diagnosticsJson();

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> shutdown() async {
    if (_disposed) return;
    _refreshTimer?.cancel();
    await _bridge.close();
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _refreshTimer?.cancel();
    unawaited(_bridge.close());
    super.dispose();
  }
}

import 'dart:async';

import 'package:flutter/services.dart';

import '../controller/connection_controller.dart';

const _desktopWindowChannelName = 'ai.greenways.desktop/window';

final class DesktopPlatformShell {
  DesktopPlatformShell(this.controller, {MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(_desktopWindowChannelName);

  final ConnectionController controller;
  final MethodChannel _channel;
  bool _prepared = false;
  bool _quitting = false;

  Future<void> prepare() async {
    if (_prepared) return;
    _prepared = true;
    _channel.setMethodCallHandler(_handleNativeCall);
    controller.addListener(_onControllerChanged);
    await _invoke('configure', {
      'state': controller.snapshot.state.wireName,
      'busy': controller.busy,
      'identityConfigured': controller.snapshot.identity != null,
    });
  }

  Future<void> showInitialWindow() => _invoke('showWindow');

  Future<void> initializeTray() => _syncNativeShell();

  Future<void> showWindow() => _invoke('showWindow');

  Future<void> quit() async {
    if (_quitting) return;
    _quitting = true;
    await controller.shutdown();
    await _invoke('quit');
  }

  Future<Object?> _handleNativeCall(MethodCall call) async {
    switch (call.method) {
      case 'connect':
        await controller.connect();
        return null;
      case 'refresh':
        await controller.refresh();
        return null;
      case 'disconnect':
        await controller.disconnect();
        return null;
      case 'showWindow':
        await showWindow();
        return null;
      case 'quit':
        await _shutdownForNativeQuit();
        return null;
      default:
        throw MissingPluginException(
          'Unsupported Greenways Desktop window command: ${call.method}',
        );
    }
  }

  void _onControllerChanged() {
    unawaited(_syncNativeShell());
  }

  Future<void> _syncNativeShell() => _invoke('setConnectionState', {
    'state': controller.snapshot.state.wireName,
    'busy': controller.busy,
    'identityConfigured': controller.snapshot.identity != null,
  });

  Future<void> _shutdownForNativeQuit() async {
    if (_quitting) return;
    _quitting = true;
    await controller.shutdown();
  }

  Future<void> _invoke(String method, [Object? arguments]) async {
    try {
      await _channel.invokeMethod<void>(method, arguments);
    } on MissingPluginException {
      // Widget tests and unsupported development hosts have no native shell.
    } on PlatformException {
      // Native menu-bar visibility is non-authoritative and best effort.
    }
  }

  void dispose() {
    if (!_prepared) return;
    _prepared = false;
    controller.removeListener(_onControllerChanged);
    _channel.setMethodCallHandler(null);
  }
}

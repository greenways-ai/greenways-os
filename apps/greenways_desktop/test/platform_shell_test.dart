import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/controller/connection_controller.dart';
import 'package:greenways_desktop/services/platform_shell.dart';

import 'support/fakes.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('native shell receives only redacted semantic state', () async {
    final channel = RecordingMethodChannel();
    final controller = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final shell = DesktopPlatformShell(controller, channel: channel);

    await shell.prepare();
    expect(channel.outbound.single.method, 'configure');
    expect(channel.outbound.single.arguments, {
      'state': 'disconnected',
      'busy': false,
      'identityConfigured': false,
    });

    await channel.sendFromNative('connect');
    expect(controller.snapshot.isConnected, isTrue);
    final update = channel.outbound.last;
    expect(update.method, 'setConnectionState');
    expect(update.arguments, {
      'state': 'connected',
      'busy': false,
      'identityConfigured': true,
    });
    expect(update.arguments.toString(), isNot(contains('local/client/')));
    expect(update.arguments.toString(), isNot(contains('local/session/')));

    shell.dispose();
    controller.dispose();
  });

  test(
    'native quit closes the companion without a re-entrant quit call',
    () async {
      final channel = RecordingMethodChannel();
      final bridge = FakeDesktopBridge();
      final controller = ConnectionController(bridge, autoRefresh: false);
      final shell = DesktopPlatformShell(controller, channel: channel);
      await shell.prepare();
      channel.outbound.clear();

      await channel.sendFromNative('quit');

      expect(bridge.closed, isTrue);
      expect(channel.outbound.where((call) => call.method == 'quit'), isEmpty);
      shell.dispose();
      controller.dispose();
    },
  );

  test('unknown native window commands fail closed', () async {
    final channel = RecordingMethodChannel();
    final controller = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final shell = DesktopPlatformShell(controller, channel: channel);
    await shell.prepare();

    await expectLater(
      channel.sendFromNative('provider.invoke'),
      throwsA(isA<MissingPluginException>()),
    );
    shell.dispose();
    controller.dispose();
  });
}

final class RecordingMethodChannel extends MethodChannel {
  RecordingMethodChannel() : super('ai.greenways.desktop/test-window');

  final List<MethodCall> outbound = [];
  Future<Object?> Function(MethodCall call)? _handler;

  @override
  Future<T?> invokeMethod<T>(String method, [Object? arguments]) async {
    outbound.add(MethodCall(method, arguments));
    return null;
  }

  @override
  void setMethodCallHandler(
    Future<Object?> Function(MethodCall call)? handler,
  ) {
    _handler = handler;
  }

  Future<Object?> sendFromNative(String method, [Object? arguments]) {
    final handler = _handler;
    if (handler == null) {
      throw StateError('No native command handler is installed.');
    }
    return handler(MethodCall(method, arguments));
  }
}

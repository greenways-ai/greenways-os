import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/controller/connection_controller.dart';
import 'package:greenways_desktop/model/connection_snapshot.dart';
import 'package:greenways_desktop/ui/greenways_app.dart';

import 'support/fakes.dart';

void main() {
  testWidgets('wide window shows the persistent Desktop rail', (tester) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    await controller.connect();

    await tester.pumpWidget(GreenwaysDesktopApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('desktop-rail')), findsOneWidget);
    expect(find.byKey(const Key('desktop-navigation-bar')), findsNothing);
    expect(find.text('Generation 4'), findsOneWidget);
    expect(find.text('Rooms'), findsOneWidget);

    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rooms-view')), findsOneWidget);
    expect(find.byKey(const Key('hestia-import-ready')), findsOneWidget);
    expect(find.textContaining('64707d7a3821'), findsOneWidget);
    expect(find.text('12 reviewed artifacts'), findsOneWidget);
    expect(find.text('No room projections admitted'), findsOneWidget);
    expect(tester.takeException(), isNull);
    controller.dispose();
  });

  testWidgets('narrow window uses the compact navigation bar', (tester) async {
    tester.view.physicalSize = const Size(520, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );

    await tester.pumpWidget(GreenwaysDesktopApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('desktop-navigation-bar')), findsOneWidget);
    expect(find.text('Disconnected'), findsWidgets);
    expect(find.text('Rooms'), findsOneWidget);

    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rooms-view')), findsOneWidget);
    expect(find.text('Connection required'), findsOneWidget);
    expect(find.textContaining('infers no room'), findsOneWidget);
    expect(find.byKey(const Key('hestia-import-ready')), findsNothing);
    expect(tester.takeException(), isNull);
    controller.dispose();
  });

  testWidgets('identity-less daemon connection is visibly degraded', (
    tester,
  ) async {
    final bridge = FakeDesktopBridge(
      connectResult: connectedSnapshot(withIdentity: false),
    );
    final controller = ConnectionController(bridge, autoRefresh: false);
    await controller.connect();

    await tester.pumpWidget(GreenwaysDesktopApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.text('Not configured'), findsOneWidget);
    expect(
      find.textContaining('Public profile identity still needs'),
      findsOneWidget,
    );
    controller.dispose();
  });

  testWidgets('session expiry presents a direct reconnect action', (
    tester,
  ) async {
    final bridge = FakeDesktopBridge(
      connectResult: failedSnapshot(DesktopConnectionState.sessionExpired),
    );
    final controller = ConnectionController(bridge, autoRefresh: false);
    await controller.connect();

    await tester.pumpWidget(GreenwaysDesktopApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.text('Session expired'), findsWidgets);
    expect(find.widgetWithText(FilledButton, 'Reconnect'), findsOneWidget);
    controller.dispose();
  });

  testWidgets('protocol mismatch never offers compatibility authority', (
    tester,
  ) async {
    final bridge = FakeDesktopBridge(
      connectResult: failedSnapshot(
        DesktopConnectionState.protocolUpgradeRequired,
      ),
    );
    final controller = ConnectionController(bridge, autoRefresh: false);
    await controller.connect();

    await tester.pumpWidget(GreenwaysDesktopApp(controller: controller));
    await tester.pumpAndSettle();

    expect(find.text('Upgrade required'), findsWidgets);
    await tester.tap(find.text('Connections').last);
    await tester.pumpAndSettle();
    expect(
      find.textContaining('No compatibility authority fallback'),
      findsOneWidget,
    );
    controller.dispose();
  });

  testWidgets('Rooms readiness is explicit and non-actionable', (tester) async {
    tester.view.physicalSize = const Size(900, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    await controller.connect();

    await tester.pumpWidget(GreenwaysDesktopApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rooms-empty-state')), findsOneWidget);
    expect(find.byKey(const Key('rooms-authority-stages')), findsOneWidget);
    expect(find.text('Hestia package pinned'), findsOneWidget);
    expect(find.text('Room projection admitted'), findsOneWidget);
    expect(find.text('Membership active'), findsOneWidget);
    expect(find.text('Source mandated'), findsOneWidget);
    expect(find.text('Room application granted'), findsOneWidget);
    expect(find.text('Source available'), findsOneWidget);
    for (final label in ['Create', 'Join', 'Approve', 'Install', 'Invoke']) {
      expect(find.text(label), findsNothing);
    }
    expect(tester.takeException(), isNull);
    controller.dispose();
  });

  testWidgets('compact connected Rooms readiness does not overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(520, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final controller = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    await controller.connect();

    await tester.pumpWidget(GreenwaysDesktopApp(controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('hestia-import-ready')), findsOneWidget);
    expect(find.text('12 reviewed artifacts'), findsOneWidget);
    expect(find.text('No room projections admitted'), findsOneWidget);
    expect(find.byKey(const Key('rooms-authority-stages')), findsOneWidget);
    expect(tester.takeException(), isNull);
    controller.dispose();
  });
}

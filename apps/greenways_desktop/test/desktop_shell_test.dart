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
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/controller/connection_controller.dart';
import 'package:greenways_desktop/controller/setup_controller.dart';
import 'package:greenways_desktop/model/connection_snapshot.dart';
import 'package:greenways_desktop/model/setup_snapshot.dart';
import 'package:greenways_desktop/ui/greenways_app.dart';

import 'support/fakes.dart';

void main() {
  testWidgets('wide window starts on the setup inspection surface', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('desktop-rail')), findsOneWidget);
    expect(find.byKey(const Key('desktop-navigation-bar')), findsNothing);
    expect(find.byKey(const Key('setup-view')), findsOneWidget);
    expect(find.text('Check local components'), findsOneWidget);
    expect(find.text('Setup'), findsOneWidget);
    expect(tester.takeException(), isNull);
    connection.dispose();
    setup.dispose();
  });

  testWidgets('setup inspection renders the exact fixed component set', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1000, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final setupBridge = FakeDesktopBridge();
    final setup = SetupController(setupBridge);

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Check local components'));
    await tester.pumpAndSettle();

    expect(setupBridge.inspections, 1);
    expect(find.text('Identity setup is optional'), findsWidgets);
    for (final kind in DesktopSetupComponentKind.values) {
      expect(
        find.byKey(Key('setup-component-${kind.wireName}')),
        findsOneWidget,
      );
    }
    expect(find.text('Greenways home'), findsOneWidget);
    expect(find.text('Local daemon'), findsOneWidget);
    expect(find.text('Desktop access'), findsOneWidget);
    expect(find.text('Public identity'), findsOneWidget);
    expect(find.text('Browser companion'), findsOneWidget);
    expect(find.text('Open Overview'), findsOneWidget);
    expect(tester.takeException(), isNull);
    connection.dispose();
    setup.dispose();
  });

  testWidgets('compact setup inspection does not overflow', (tester) async {
    tester.view.physicalSize = const Size(520, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final setupBridge = FakeDesktopBridge(
      setupResult: inspectedSetupSnapshot(
        homeState: DesktopSetupState.installRequired,
        daemonState: DesktopSetupState.installRequired,
        desktopClientState: DesktopSetupState.credentialRequired,
      ),
    );
    final setup = SetupController(setupBridge);
    await setup.inspect();
    setupBridge.setupResult = inspectedSetupSnapshot(
      desktopClientState: DesktopSetupState.credentialRequired,
    );

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('desktop-navigation-bar')), findsOneWidget);
    expect(find.byKey(const Key('setup-view')), findsOneWidget);
    expect(find.text('Installation required'), findsWidgets);
    expect(find.text('Install daemon service'), findsOneWidget);
    await tester.tap(find.text('Install daemon service'));
    await tester.pumpAndSettle();
    expect(setupBridge.daemonInstalls, 1);
    expect(find.text('Desktop access required'), findsWidgets);
    expect(tester.takeException(), isNull);
    connection.dispose();
    setup.dispose();
  });

  testWidgets('wide rail opens Overview and Rooms after setup', (tester) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());
    await connection.connect();
    await setup.inspect();

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Overview'));
    await tester.pumpAndSettle();

    expect(find.text('Generation 4'), findsOneWidget);

    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rooms-view')), findsOneWidget);
    expect(find.byKey(const Key('hestia-import-ready')), findsOneWidget);
    expect(find.textContaining('64707d7a3821'), findsOneWidget);
    expect(find.text('12 reviewed artifacts'), findsOneWidget);
    expect(find.text('No room projections admitted'), findsOneWidget);
    expect(tester.takeException(), isNull);
    connection.dispose();
    setup.dispose();
  });

  testWidgets('narrow navigation preserves disconnected Rooms semantics', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(520, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('desktop-navigation-bar')), findsOneWidget);
    expect(
      find.bySemanticsLabel('Daemon status: Disconnected'),
      findsOneWidget,
    );
    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('rooms-view')), findsOneWidget);
    expect(find.text('Connection required'), findsOneWidget);
    expect(find.textContaining('infers no room'), findsOneWidget);
    expect(find.byKey(const Key('hestia-import-ready')), findsNothing);
    expect(tester.takeException(), isNull);
    connection.dispose();
    setup.dispose();
  });

  testWidgets('identity-less daemon connection is visibly degraded', (
    tester,
  ) async {
    final connectionBridge = FakeDesktopBridge(
      connectResult: connectedSnapshot(withIdentity: false),
    );
    final connection = ConnectionController(
      connectionBridge,
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());
    await connection.connect();

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Overview'));
    await tester.pumpAndSettle();

    expect(find.text('Not configured'), findsOneWidget);
    expect(
      find.textContaining('Public profile identity still needs'),
      findsOneWidget,
    );
    connection.dispose();
    setup.dispose();
  });

  testWidgets('session expiry presents a direct reconnect action', (
    tester,
  ) async {
    final connectionBridge = FakeDesktopBridge(
      connectResult: failedSnapshot(DesktopConnectionState.sessionExpired),
    );
    final connection = ConnectionController(
      connectionBridge,
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());
    await connection.connect();

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Overview'));
    await tester.pumpAndSettle();

    expect(find.text('Session expired'), findsWidgets);
    expect(find.widgetWithText(FilledButton, 'Reconnect'), findsOneWidget);
    connection.dispose();
    setup.dispose();
  });

  testWidgets('protocol mismatch never offers compatibility authority', (
    tester,
  ) async {
    final connectionBridge = FakeDesktopBridge(
      connectResult: failedSnapshot(
        DesktopConnectionState.protocolUpgradeRequired,
      ),
    );
    final connection = ConnectionController(
      connectionBridge,
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());
    await connection.connect();

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Connections'));
    await tester.pumpAndSettle();

    expect(find.text('Upgrade required'), findsWidgets);
    expect(
      find.textContaining('No compatibility authority fallback'),
      findsOneWidget,
    );
    connection.dispose();
    setup.dispose();
  });

  testWidgets('Rooms readiness remains explicit and non-actionable', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(900, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());
    await connection.connect();

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
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
    connection.dispose();
    setup.dispose();
  });

  testWidgets('compact connected Rooms readiness does not overflow', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(520, 760);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final connection = ConnectionController(
      FakeDesktopBridge(),
      autoRefresh: false,
    );
    final setup = SetupController(FakeDesktopBridge());
    await connection.connect();

    await tester.pumpWidget(
      GreenwaysDesktopApp(
        connectionController: connection,
        setupController: setup,
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('Rooms'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('hestia-import-ready')), findsOneWidget);
    expect(find.text('12 reviewed artifacts'), findsOneWidget);
    expect(find.text('No room projections admitted'), findsOneWidget);
    expect(find.byKey(const Key('rooms-authority-stages')), findsOneWidget);
    expect(tester.takeException(), isNull);
    connection.dispose();
    setup.dispose();
  });
}

import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/controller/setup_controller.dart';
import 'package:greenways_desktop/model/setup_snapshot.dart';
import 'package:greenways_desktop/services/desktop_bridge.dart';

import 'support/fakes.dart';

void main() {
  test(
    'inspection retains only the closed semantic setup projection',
    () async {
      final bridge = FakeDesktopBridge();
      final controller = SetupController(bridge);

      expect(controller.snapshot.state, DesktopSetupState.notInspected);
      await controller.inspect();

      expect(bridge.inspections, 1);
      expect(controller.snapshot.state, DesktopSetupState.identityOptional);
      expect(controller.snapshot.mandatoryReady, isTrue);
      expect(controller.diagnosticsJson(), contains('greenways-home'));
      expect(controller.diagnosticsJson(), isNot(contains('desktop.json')));
      controller.dispose();
    },
  );

  test(
    'daemon installation runs only when the closed state permits it',
    () async {
      final bridge = FakeDesktopBridge(
        setupResult: inspectedSetupSnapshot(
          homeState: DesktopSetupState.installRequired,
          daemonState: DesktopSetupState.installRequired,
          desktopClientState: DesktopSetupState.credentialRequired,
        ),
      );
      final controller = SetupController(bridge);

      await controller.inspect();
      expect(controller.snapshot.state, DesktopSetupState.installRequired);
      bridge.setupResult = inspectedSetupSnapshot(
        desktopClientState: DesktopSetupState.credentialRequired,
      );
      await controller.installDaemon();

      expect(bridge.daemonInstalls, 1);
      expect(controller.snapshot.state, DesktopSetupState.credentialRequired);
      controller.dispose();
    },
  );

  test(
    'Desktop access enrollment follows the closed credential state',
    () async {
      final bridge = FakeDesktopBridge(
        setupResult: inspectedSetupSnapshot(
          desktopClientState: DesktopSetupState.credentialRequired,
        ),
      );
      final controller = SetupController(bridge);

      await controller.inspect();
      expect(controller.snapshot.state, DesktopSetupState.credentialRequired);
      bridge.setupResult = inspectedSetupSnapshot();
      await controller.issueDesktopClient();

      expect(bridge.desktopClientIssues, 1);
      expect(controller.snapshot.state, DesktopSetupState.identityOptional);
      controller.dispose();
    },
  );

  test('missing companion becomes a bounded setup failure', () async {
    final bridge = FakeDesktopBridge(
      setupError: const DesktopBridgeUnavailable('Companion unavailable.'),
    );
    final controller = SetupController(bridge);

    await controller.inspect();

    expect(controller.snapshot.state, DesktopSetupState.failed);
    expect(controller.snapshot.error?.code, 'setup-bridge-unavailable');
    expect(controller.snapshot.components, isEmpty);
    controller.dispose();
  });
}

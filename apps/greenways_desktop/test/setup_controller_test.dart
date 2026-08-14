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

  test(
    'public identity creation normalizes and forwards only the handle',
    () async {
      final bridge = FakeDesktopBridge();
      final controller = SetupController(bridge);

      await controller.inspect();
      expect(controller.snapshot.state, DesktopSetupState.identityOptional);
      bridge.setupResult = inspectedSetupSnapshot(
        identityState: DesktopSetupState.ready,
      );
      await controller.createIdentity('@River.Studio');

      expect(bridge.identityCreations, 1);
      expect(bridge.identityHandles, const ['river.studio']);
      expect(
        controller.snapshot.state,
        DesktopSetupState.browserCompanionOptional,
      );
      controller.dispose();
    },
  );

  test(
    'identity recovery crosses only the closed no-argument operation',
    () async {
      final bridge = FakeDesktopBridge();
      final controller = SetupController(bridge);

      await controller.inspect();
      expect(controller.snapshot.permittedActions, const [
        DesktopSetupOperation.createIdentity,
        DesktopSetupOperation.recoverIdentity,
        DesktopSetupOperation.inspect,
      ]);
      bridge.setupResult = inspectedSetupSnapshot(
        identityState: DesktopSetupState.ready,
      );
      await controller.recoverIdentity();

      expect(bridge.identityRecoveries, 1);
      expect(
        bridge.setupOperations.last,
        DesktopSetupOperation.recoverIdentity,
      );
      expect(bridge.setupHandles.last, isNull);
      expect(
        controller.snapshot.state,
        DesktopSetupState.browserCompanionOptional,
      );
      controller.dispose();
    },
  );

  test('invalid identity handles never cross the bridge', () async {
    final bridge = FakeDesktopBridge();
    final controller = SetupController(bridge);

    await controller.inspect();
    await controller.createIdentity('river/studio');

    expect(bridge.identityCreations, 0);
    expect(controller.snapshot.state, DesktopSetupState.identityOptional);
    controller.dispose();
  });

  test('Chrome companion installation crosses only the closed no-argument operation', () async {
    final bridge = FakeDesktopBridge(
      setupResult: inspectedSetupSnapshot(
        identityState: DesktopSetupState.ready,
      ),
    );
    final controller = SetupController(bridge);

    await controller.inspect();
    expect(
      controller.snapshot.state,
      DesktopSetupState.browserCompanionOptional,
    );
    expect(controller.snapshot.permittedActions, const [
      DesktopSetupOperation.installBrowserBridge,
      DesktopSetupOperation.inspect,
    ]);

    bridge.setupResult = inspectedSetupSnapshot(
      identityState: DesktopSetupState.ready,
      browserState: DesktopSetupState.ready,
    );
    await controller.installBrowserBridge();

    expect(bridge.browserBridgeInstalls, 1);
    expect(
      bridge.setupOperations.last,
      DesktopSetupOperation.installBrowserBridge,
    );
    expect(bridge.setupHandles.last, isNull);
    expect(controller.snapshot.state, DesktopSetupState.verificationRequired);
    final browser = controller.snapshot.component(
      DesktopSetupComponentKind.browserCompanion,
    );
    expect(browser?.publicId, 'ai.greenways.browser_bridge');
    expect(browser?.version, '0.1.0');
    expect(browser?.digest, startsWith('sha256:'));
    final diagnostics = controller.diagnosticsJson();
    expect(diagnostics, contains('ai.greenways.browser_bridge'));
    for (final confidential in [
      'chrome-extension://',
      '/.greenways/',
      'gwc_',
      'local/session/',
      'greenways-browser-bridge-host',
    ]) {
      expect(diagnostics, isNot(contains(confidential)));
    }
    controller.dispose();
  });

  test(
    'Chrome companion operation is unavailable outside its exact state',
    () async {
      final bridge = FakeDesktopBridge();
      final controller = SetupController(bridge);

      await controller.inspect();
      await controller.installBrowserBridge();

      expect(bridge.browserBridgeInstalls, 0);
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

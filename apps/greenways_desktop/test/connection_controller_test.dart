import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/controller/connection_controller.dart';
import 'package:greenways_desktop/model/connection_snapshot.dart';
import 'package:greenways_desktop/services/desktop_bridge.dart';

import 'support/fakes.dart';

void main() {
  test('connect, refresh and disconnect retain semantic state only', () async {
    final bridge = FakeDesktopBridge();
    final controller = ConnectionController(bridge, autoRefresh: false);

    await controller.connect();
    expect(controller.snapshot.state, DesktopConnectionState.connected);
    expect(bridge.connects, 1);

    await controller.refresh();
    expect(bridge.refreshes, 1);

    await controller.disconnect();
    expect(controller.snapshot.state, DesktopConnectionState.disconnected);
    expect(bridge.disconnects, 1);

    controller.dispose();
  });

  test('missing companion becomes a bounded bridge state', () async {
    final bridge = FakeDesktopBridge(
      connectError: const DesktopBridgeUnavailable('Companion missing.'),
    );
    final controller = ConnectionController(bridge, autoRefresh: false);

    await controller.connect();

    expect(controller.snapshot.state, DesktopConnectionState.bridgeUnavailable);
    expect(controller.snapshot.daemon, isNull);
    expect(controller.snapshot.actor, isNull);
    expect(controller.snapshot.session, isNull);
    controller.dispose();
  });
}

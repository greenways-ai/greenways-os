import 'dart:async';

import 'package:flutter/material.dart';

import 'controller/connection_controller.dart';
import 'controller/setup_controller.dart';
import 'services/desktop_bridge.dart';
import 'services/desktop_control_server.dart';
import 'services/platform_shell.dart';
import 'ui/greenways_app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final connectionController = ConnectionController(ProcessDesktopBridge());
  final setupController = SetupController(ProcessDesktopBridge());
  late final DesktopControlServer controlServer;
  final platform = DesktopPlatformShell(
    connectionController,
    setupController: setupController,
    beforeQuit: () => controlServer.close(),
  );
  controlServer = DesktopControlServer(
    connectionController,
    showWindow: platform.showWindow,
    quit: platform.quit,
  );
  await platform.prepare();
  await controlServer.start();
  runApp(
    GreenwaysDesktopApp(
      connectionController: connectionController,
      setupController: setupController,
    ),
  );
  await platform.showInitialWindow();
  await platform.initializeTray();
  unawaited(setupController.inspect());
  unawaited(connectionController.connect());
}

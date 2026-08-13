import 'dart:async';

import 'package:flutter/material.dart';

import 'controller/connection_controller.dart';
import 'services/desktop_bridge.dart';
import 'services/platform_shell.dart';
import 'ui/greenways_app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final controller = ConnectionController(ProcessDesktopBridge());
  final platform = DesktopPlatformShell(controller);
  await platform.prepare();
  runApp(GreenwaysDesktopApp(controller: controller));
  await platform.showInitialWindow();
  await platform.initializeTray();
  unawaited(controller.connect());
}

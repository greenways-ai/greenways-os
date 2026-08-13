import 'package:flutter/material.dart';

import '../controller/connection_controller.dart';
import '../controller/setup_controller.dart';
import 'shell.dart';

final class GreenwaysDesktopApp extends StatelessWidget {
  const GreenwaysDesktopApp({
    super.key,
    required this.connectionController,
    required this.setupController,
  });

  final ConnectionController connectionController;
  final SetupController setupController;

  @override
  Widget build(BuildContext context) {
    const green = Color(0xFF153F32);
    const teal = Color(0xFF26796A);
    const stone = Color(0xFFF5F1E8);
    const paper = Color(0xFFFFFDF8);
    final scheme =
        ColorScheme.fromSeed(
          seedColor: green,
          brightness: Brightness.light,
          surface: paper,
        ).copyWith(
          primary: green,
          secondary: teal,
          surface: paper,
          surfaceContainerLowest: stone,
          outline: const Color(0xFFB9B1A3),
        );
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'Greenways Desktop',
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: scheme,
        scaffoldBackgroundColor: stone,
        fontFamily: '.AppleSystemUIFont',
        cardTheme: const CardThemeData(
          margin: EdgeInsets.zero,
          elevation: 0,
          color: paper,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.all(Radius.circular(22)),
            side: BorderSide(color: Color(0x1F153F32)),
          ),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
          ),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 15),
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(14),
            ),
          ),
        ),
      ),
      home: DesktopShell(
        connectionController: connectionController,
        setupController: setupController,
      ),
    );
  }
}

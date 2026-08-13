import 'package:flutter/material.dart';

import '../model/connection_snapshot.dart';

extension DesktopConnectionPresentation on DesktopConnectionState {
  String get title => switch (this) {
    DesktopConnectionState.connecting => 'Connecting',
    DesktopConnectionState.connected => 'Connected',
    DesktopConnectionState.daemonUnavailable => 'Daemon unavailable',
    DesktopConnectionState.credentialUnavailable => 'Setup required',
    DesktopConnectionState.authenticationRejected => 'Authentication rejected',
    DesktopConnectionState.sessionExpired => 'Session expired',
    DesktopConnectionState.protocolUpgradeRequired => 'Upgrade required',
    DesktopConnectionState.bridgeUnavailable => 'Companion unavailable',
    DesktopConnectionState.disconnected => 'Disconnected',
  };

  IconData get icon => switch (this) {
    DesktopConnectionState.connecting => Icons.sync,
    DesktopConnectionState.connected => Icons.check_circle,
    DesktopConnectionState.daemonUnavailable => Icons.cloud_off,
    DesktopConnectionState.credentialUnavailable => Icons.badge_outlined,
    DesktopConnectionState.authenticationRejected => Icons.gpp_bad_outlined,
    DesktopConnectionState.sessionExpired => Icons.timer_off_outlined,
    DesktopConnectionState.protocolUpgradeRequired => Icons.system_update_alt,
    DesktopConnectionState.bridgeUnavailable => Icons.desktop_access_disabled,
    DesktopConnectionState.disconnected => Icons.link_off,
  };
}

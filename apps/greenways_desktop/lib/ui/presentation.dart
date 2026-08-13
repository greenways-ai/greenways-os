import 'package:flutter/material.dart';

import '../model/connection_snapshot.dart';
import '../model/setup_snapshot.dart';

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

extension DesktopSetupStatePresentation on DesktopSetupState {
  String get title => switch (this) {
    DesktopSetupState.notInspected => 'Local components not checked',
    DesktopSetupState.inspecting => 'Checking local components',
    DesktopSetupState.ready => 'Core components ready',
    DesktopSetupState.installRequired => 'Installation required',
    DesktopSetupState.upgradeRequired => 'Upgrade required',
    DesktopSetupState.permissionRepairRequired => 'Permission repair required',
    DesktopSetupState.credentialRequired => 'Desktop access required',
    DesktopSetupState.credentialRoleMismatch =>
      'Desktop access has the wrong role',
    DesktopSetupState.identityOptional => 'Identity setup is optional',
    DesktopSetupState.browserCompanionOptional =>
      'Browser connection is optional',
    DesktopSetupState.verifying => 'Verifying installation',
    DesktopSetupState.complete => 'Installation verified',
    DesktopSetupState.restartRequired => 'Daemon restart required',
    DesktopSetupState.manualRecoveryRequired => 'Manual recovery required',
    DesktopSetupState.failed => 'Setup inspection failed',
  };

  IconData get icon => switch (this) {
    DesktopSetupState.notInspected => Icons.search,
    DesktopSetupState.inspecting => Icons.sync,
    DesktopSetupState.ready => Icons.check_circle_outline,
    DesktopSetupState.installRequired => Icons.download_outlined,
    DesktopSetupState.upgradeRequired => Icons.system_update_alt,
    DesktopSetupState.permissionRepairRequired => Icons.folder_off_outlined,
    DesktopSetupState.credentialRequired => Icons.badge_outlined,
    DesktopSetupState.credentialRoleMismatch => Icons.gpp_bad_outlined,
    DesktopSetupState.identityOptional => Icons.person_add_alt_outlined,
    DesktopSetupState.browserCompanionOptional => Icons.public_outlined,
    DesktopSetupState.verifying => Icons.verified_outlined,
    DesktopSetupState.complete => Icons.verified,
    DesktopSetupState.restartRequired => Icons.restart_alt,
    DesktopSetupState.manualRecoveryRequired => Icons.build_outlined,
    DesktopSetupState.failed => Icons.error_outline,
  };
}

extension DesktopSetupComponentPresentation on DesktopSetupComponentKind {
  String get title => switch (this) {
    DesktopSetupComponentKind.greenwaysHome => 'Greenways home',
    DesktopSetupComponentKind.daemon => 'Local daemon',
    DesktopSetupComponentKind.desktopClient => 'Desktop access',
    DesktopSetupComponentKind.identity => 'Public identity',
    DesktopSetupComponentKind.browserCompanion => 'Browser companion',
  };

  String get description => switch (this) {
    DesktopSetupComponentKind.greenwaysHome =>
      'Private installation state and runtime directories.',
    DesktopSetupComponentKind.daemon =>
      'Independent greenwaysd service and public node status.',
    DesktopSetupComponentKind.desktopClient =>
      'One private credential fixed to the Desktop role.',
    DesktopSetupComponentKind.identity =>
      'Optional public identity retained by the daemon vault.',
    DesktopSetupComponentKind.browserCompanion =>
      'Optional exact Chrome native-messaging boundary.',
  };

  IconData get icon => switch (this) {
    DesktopSetupComponentKind.greenwaysHome => Icons.folder_special_outlined,
    DesktopSetupComponentKind.daemon => Icons.dns_outlined,
    DesktopSetupComponentKind.desktopClient => Icons.badge_outlined,
    DesktopSetupComponentKind.identity => Icons.person_outline,
    DesktopSetupComponentKind.browserCompanion => Icons.extension_outlined,
  };
}

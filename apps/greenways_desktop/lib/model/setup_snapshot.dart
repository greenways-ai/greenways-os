import 'dart:convert';

part 'setup_snapshot_types.dart';
part 'setup_snapshot_validation.dart';

const desktopSetupProtocol = 'greenways-desktop-setup/0-alpha';
const desktopSetupResultProtocol = 'greenways-desktop-setup-result/0-alpha';
const desktopSetupStatusProtocol = 'greenways-desktop-setup-status/0-alpha';
const desktopSetupComponentProtocol =
    'greenways-desktop-setup-component/0-alpha';
const _maximumSafeInteger = 9007199254740991;

final _requestIdPattern = RegExp(r'^desktop/request/[A-Za-z0-9._:-]{8,160}$');
final _digestPattern = RegExp(r'^sha256:[0-9a-f]{64}$');
final _errorCodePattern = RegExp(r'^[a-z0-9-]{1,100}$');
final _identityHandlePattern = RegExp(
  r'^[a-z0-9](?:[a-z0-9._-]{0,46}[a-z0-9])?$',
);

String? normalizeDesktopIdentityHandle(String value) {
  var normalized = value.trim();
  while (normalized.startsWith('@')) {
    normalized = normalized.substring(1);
  }
  normalized = normalized.toLowerCase();
  return _identityHandlePattern.hasMatch(normalized) ? normalized : null;
}

final _confidentialValuePattern = RegExp(
  r'(^gwc_|local/session/|profile-key-|provider-key-|credential-key-|/\.greenways/)',
  caseSensitive: false,
);

enum DesktopSetupOperation {
  inspect,
  installDaemon,
  issueDesktopClient,
  createIdentity,
  installBrowserBridge,
  verify,
  repairPermissions;

  static DesktopSetupOperation fromWire(String value) => switch (value) {
    'inspect' => inspect,
    'install-daemon' => installDaemon,
    'issue-desktop-client' => issueDesktopClient,
    'create-identity' => createIdentity,
    'install-browser-bridge' => installBrowserBridge,
    'verify' => verify,
    'repair-permissions' => repairPermissions,
    _ => throw const FormatException('Unsupported Desktop setup operation.'),
  };

  String get wireName => switch (this) {
    inspect => 'inspect',
    installDaemon => 'install-daemon',
    issueDesktopClient => 'issue-desktop-client',
    createIdentity => 'create-identity',
    installBrowserBridge => 'install-browser-bridge',
    verify => 'verify',
    repairPermissions => 'repair-permissions',
  };
}

enum DesktopSetupState {
  notInspected,
  inspecting,
  ready,
  installRequired,
  upgradeRequired,
  permissionRepairRequired,
  credentialRequired,
  credentialRoleMismatch,
  identityOptional,
  browserCompanionOptional,
  verifying,
  complete,
  restartRequired,
  manualRecoveryRequired,
  failed;

  static DesktopSetupState fromWire(String value) => switch (value) {
    'not-inspected' => notInspected,
    'inspecting' => inspecting,
    'ready' => ready,
    'install-required' => installRequired,
    'upgrade-required' => upgradeRequired,
    'permission-repair-required' => permissionRepairRequired,
    'credential-required' => credentialRequired,
    'credential-role-mismatch' => credentialRoleMismatch,
    'identity-optional' => identityOptional,
    'browser-companion-optional' => browserCompanionOptional,
    'verifying' => verifying,
    'complete' => complete,
    'restart-required' => restartRequired,
    'manual-recovery-required' => manualRecoveryRequired,
    'failed' => failed,
    _ => throw const FormatException('Unsupported Desktop setup state.'),
  };

  String get wireName => switch (this) {
    notInspected => 'not-inspected',
    inspecting => 'inspecting',
    ready => 'ready',
    installRequired => 'install-required',
    upgradeRequired => 'upgrade-required',
    permissionRepairRequired => 'permission-repair-required',
    credentialRequired => 'credential-required',
    credentialRoleMismatch => 'credential-role-mismatch',
    identityOptional => 'identity-optional',
    browserCompanionOptional => 'browser-companion-optional',
    verifying => 'verifying',
    complete => 'complete',
    restartRequired => 'restart-required',
    manualRecoveryRequired => 'manual-recovery-required',
    failed => 'failed',
  };
}

enum DesktopSetupComponentKind {
  greenwaysHome,
  daemon,
  desktopClient,
  identity,
  browserCompanion;

  static DesktopSetupComponentKind fromWire(String value) => switch (value) {
    'greenways-home' => greenwaysHome,
    'daemon' => daemon,
    'desktop-client' => desktopClient,
    'identity' => identity,
    'browser-companion' => browserCompanion,
    _ => throw const FormatException('Unsupported Desktop setup component.'),
  };

  String get wireName => switch (this) {
    greenwaysHome => 'greenways-home',
    daemon => 'daemon',
    desktopClient => 'desktop-client',
    identity => 'identity',
    browserCompanion => 'browser-companion',
  };
}

const _componentOrder = <DesktopSetupComponentKind>[
  DesktopSetupComponentKind.greenwaysHome,
  DesktopSetupComponentKind.daemon,
  DesktopSetupComponentKind.desktopClient,
  DesktopSetupComponentKind.identity,
  DesktopSetupComponentKind.browserCompanion,
];

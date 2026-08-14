import 'package:greenways_desktop/model/connection_snapshot.dart';
import 'package:greenways_desktop/model/setup_snapshot.dart';
import 'package:greenways_desktop/services/desktop_bridge.dart';

final class FakeDesktopBridge implements DesktopBridge {
  FakeDesktopBridge({
    DesktopConnectionSnapshot? connectResult,
    DesktopConnectionSnapshot? refreshResult,
    DesktopConnectionSnapshot? disconnectResult,
    DesktopSetupSnapshot? setupResult,
    this.connectError,
    this.setupError,
  }) : connectResult = connectResult ?? connectedSnapshot(),
       refreshResult = refreshResult ?? connectResult ?? connectedSnapshot(),
       disconnectResult =
           disconnectResult ?? DesktopConnectionSnapshot.disconnected(),
       setupResult = setupResult ?? inspectedSetupSnapshot();

  DesktopConnectionSnapshot connectResult;
  DesktopConnectionSnapshot refreshResult;
  DesktopConnectionSnapshot disconnectResult;
  DesktopSetupSnapshot setupResult;
  Object? connectError;
  Object? setupError;
  int connects = 0;
  int refreshes = 0;
  int disconnects = 0;
  int inspections = 0;
  int daemonInstalls = 0;
  int desktopClientIssues = 0;
  int identityCreations = 0;
  int identityRecoveries = 0;
  final List<String?> identityHandles = [];
  int browserBridgeInstalls = 0;
  final List<DesktopSetupOperation> setupOperations = [];
  final List<String?> setupHandles = [];
  int permissionRepairs = 0;
  bool closed = false;

  @override
  Future<DesktopConnectionSnapshot> connect() async {
    connects += 1;
    final error = connectError;
    if (error != null) throw error;
    return connectResult;
  }

  @override
  Future<DesktopConnectionSnapshot> refresh() async {
    refreshes += 1;
    return refreshResult;
  }

  @override
  Future<DesktopConnectionSnapshot> disconnect() async {
    disconnects += 1;
    return disconnectResult;
  }

  @override
  Future<DesktopSetupSnapshot> performSetup(
    DesktopSetupOperation operation, {
    String? handle,
  }) async {
    setupOperations.add(operation);
    setupHandles.add(handle);
    switch (operation) {
      case DesktopSetupOperation.inspect:
        inspections += 1;
        break;
      case DesktopSetupOperation.installDaemon:
        daemonInstalls += 1;
        break;
      case DesktopSetupOperation.issueDesktopClient:
        desktopClientIssues += 1;
        break;
      case DesktopSetupOperation.createIdentity:
        identityCreations += 1;
        identityHandles.add(handle);
        break;
      case DesktopSetupOperation.recoverIdentity:
        identityRecoveries += 1;
        break;
      case DesktopSetupOperation.installBrowserBridge:
        browserBridgeInstalls += 1;
        break;
      case DesktopSetupOperation.repairPermissions:
        permissionRepairs += 1;
        break;
      default:
        break;
    }
    final error = setupError;
    if (error != null) throw error;
    return setupResult;
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

DesktopConnectionSnapshot connectedSnapshot({bool withIdentity = true}) =>
    DesktopConnectionSnapshot(
      protocol: desktopConnectionStatusProtocol,
      state: DesktopConnectionState.connected,
      daemon: const DesktopDaemonProjection(
        protocol: 'greenways-daemon-status/0-alpha',
        nodeId: 'node/00112233445566778899aabbccddeeff',
        daemonVersion: '0.1.0',
        localProtocol: 'greenways-local/0-alpha',
        generation: 4,
        stateRevision: 9,
        startedAtUnixMs: 1,
        observedAtUnixMs: 2,
        profileMode: 'configured',
        authorityMode: 'daemon',
      ),
      actor: const DesktopActorProjection(
        protocol: 'greenways-local-client/0-alpha',
        id: 'local/client/00112233445566778899aabbccddeeff',
        role: 'desktop',
        label: 'Greenways Desktop',
        createdAtUnixMs: 1,
      ),
      identity: withIdentity
          ? const DesktopIdentityProjection(
              protocol: 'greenways-profile-identity/0-alpha',
              id: 'identity/00112233445566778899aabbccddeeff',
              handle: 'greenways',
              keyId: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
              algorithm: 'p256-sha256-fixed',
              createdAtUnixMs: 1,
            )
          : null,
      hestiaImport: const DesktopHestiaImportProjection(
        protocol: hestiaImportStatusProtocol,
        state: hestiaImportState,
        repository: hestiaImportRepository,
        revision: hestiaImportRevision,
        package: hestiaImportPackage,
        artifactCount: hestiaImportArtifactCount,
        roomInvocationProtocol: hestiaRoomInvocationProtocol,
        authorityDecisionProtocol: hestiaAuthorityDecisionProtocol,
        preparedExecutionProtocol: greenwaysPreparedRoomExecutionProtocol,
        verificationScope: hestiaImportVerificationScope,
        roomProjectionsAdmitted: false,
        admittedRoomProjectionCount: 0,
      ),
      session: const DesktopSessionProjection(
        protocol: desktopSessionProjectionProtocol,
        openedAtUnixMs: 1,
        expiresAtUnixMs: 300001,
        remainingRequests: 124,
      ),
      error: null,
      observedAtUnixMs: 2,
    );

DesktopConnectionSnapshot failedSnapshot(DesktopConnectionState state) =>
    DesktopConnectionSnapshot(
      protocol: desktopConnectionStatusProtocol,
      state: state,
      daemon: null,
      actor: null,
      identity: null,
      hestiaImport: null,
      session: null,
      error: DesktopPublicError(code: state, message: 'Bounded failure.'),
      observedAtUnixMs: 2,
    );

DesktopSetupSnapshot inspectedSetupSnapshot({
  DesktopSetupState homeState = DesktopSetupState.ready,
  DesktopSetupState daemonState = DesktopSetupState.ready,
  DesktopSetupState desktopClientState = DesktopSetupState.ready,
  DesktopSetupState identityState = DesktopSetupState.identityOptional,
  DesktopSetupState browserState = DesktopSetupState.browserCompanionOptional,
}) {
  final components = [
    _setupComponent(DesktopSetupComponentKind.greenwaysHome, homeState),
    _setupComponent(
      DesktopSetupComponentKind.daemon,
      daemonState,
      version: daemonState == DesktopSetupState.ready ? '0.1.0' : null,
      publicId: daemonState == DesktopSetupState.ready
          ? 'node/00112233445566778899aabbccddeeff'
          : null,
    ),
    _setupComponent(
      DesktopSetupComponentKind.desktopClient,
      desktopClientState,
      publicId: desktopClientState == DesktopSetupState.ready
          ? 'local/client/00112233445566778899aabbccddeeff'
          : null,
    ),
    _setupComponent(
      DesktopSetupComponentKind.identity,
      identityState,
      publicId: identityState == DesktopSetupState.ready
          ? 'identity/00112233445566778899aabbccddeeff'
          : null,
    ),
    _setupComponent(
      DesktopSetupComponentKind.browserCompanion,
      browserState,
      version: browserState == DesktopSetupState.ready ? '0.1.0' : null,
      digest: browserState == DesktopSetupState.ready
          ? 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
          : null,
      publicId: browserState == DesktopSetupState.ready
          ? 'ai.greenways.browser_bridge'
          : null,
    ),
  ];
  return DesktopSetupSnapshot(
    protocol: desktopSetupStatusProtocol,
    state: _deriveSetupState(components),
    components: components,
    permittedActions: _setupActions(_deriveSetupState(components)),
    observedAtUnixMs: 2,
    error: null,
  );
}

DesktopSetupComponent _setupComponent(
  DesktopSetupComponentKind kind,
  DesktopSetupState state, {
  String? version,
  String? digest,
  String? publicId,
}) => DesktopSetupComponent(
  protocol: desktopSetupComponentProtocol,
  kind: kind,
  state: state,
  version: version,
  digest: digest,
  publicId: publicId,
  errorCode: _setupErrorCode(kind, state),
);

String? _setupErrorCode(
  DesktopSetupComponentKind kind,
  DesktopSetupState state,
) {
  if (state == DesktopSetupState.ready ||
      state == DesktopSetupState.identityOptional ||
      state == DesktopSetupState.browserCompanionOptional) {
    return null;
  }
  return '${kind.wireName}-${state.wireName}';
}

DesktopSetupState _deriveSetupState(List<DesktopSetupComponent> components) {
  final states = components.map((component) => component.state).toSet();
  for (final state in const [
    DesktopSetupState.manualRecoveryRequired,
    DesktopSetupState.permissionRepairRequired,
    DesktopSetupState.credentialRoleMismatch,
    DesktopSetupState.upgradeRequired,
    DesktopSetupState.restartRequired,
    DesktopSetupState.installRequired,
    DesktopSetupState.credentialRequired,
    DesktopSetupState.identityOptional,
    DesktopSetupState.browserCompanionOptional,
  ]) {
    if (states.contains(state)) return state;
  }
  return states.every((state) => state == DesktopSetupState.ready)
      ? DesktopSetupState.verificationRequired
      : DesktopSetupState.ready;
}

List<DesktopSetupOperation> _setupActions(DesktopSetupState state) {
  switch (state) {
    case DesktopSetupState.installRequired:
    case DesktopSetupState.upgradeRequired:
    case DesktopSetupState.restartRequired:
      return const [
        DesktopSetupOperation.installDaemon,
        DesktopSetupOperation.inspect,
      ];
    case DesktopSetupState.permissionRepairRequired:
      return const [
        DesktopSetupOperation.repairPermissions,
        DesktopSetupOperation.inspect,
      ];
    case DesktopSetupState.credentialRequired:
      return const [
        DesktopSetupOperation.issueDesktopClient,
        DesktopSetupOperation.inspect,
      ];
    case DesktopSetupState.identityOptional:
      return const [
        DesktopSetupOperation.createIdentity,
        DesktopSetupOperation.recoverIdentity,
        DesktopSetupOperation.inspect,
      ];
    case DesktopSetupState.browserCompanionOptional:
      return const [
        DesktopSetupOperation.installBrowserBridge,
        DesktopSetupOperation.inspect,
      ];
    case DesktopSetupState.verificationRequired:
      return const [DesktopSetupOperation.inspect];
    default:
      return const [DesktopSetupOperation.inspect];
  }
}

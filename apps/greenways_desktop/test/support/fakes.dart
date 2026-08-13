import 'package:greenways_desktop/model/connection_snapshot.dart';
import 'package:greenways_desktop/services/desktop_bridge.dart';

final class FakeDesktopBridge implements DesktopBridge {
  FakeDesktopBridge({
    DesktopConnectionSnapshot? connectResult,
    DesktopConnectionSnapshot? refreshResult,
    DesktopConnectionSnapshot? disconnectResult,
    this.connectError,
  }) : connectResult = connectResult ?? connectedSnapshot(),
       refreshResult = refreshResult ?? connectResult ?? connectedSnapshot(),
       disconnectResult =
           disconnectResult ?? DesktopConnectionSnapshot.disconnected();

  DesktopConnectionSnapshot connectResult;
  DesktopConnectionSnapshot refreshResult;
  DesktopConnectionSnapshot disconnectResult;
  Object? connectError;
  int connects = 0;
  int refreshes = 0;
  int disconnects = 0;
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
      session: const DesktopSessionProjection(
        protocol: desktopSessionProjectionProtocol,
        openedAtUnixMs: 1,
        expiresAtUnixMs: 300001,
        remainingRequests: 125,
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
      session: null,
      error: DesktopPublicError(code: state, message: 'Bounded failure.'),
      observedAtUnixMs: 2,
    );

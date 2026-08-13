import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/model/connection_snapshot.dart';

void main() {
  test('decodes the closed connected projection', () {
    final snapshot = DesktopConnectionSnapshot.fromJson(_connectedJson());
    expect(snapshot.state, DesktopConnectionState.connected);
    expect(snapshot.actor?.role, 'desktop');
    expect(snapshot.identity?.handle, 'greenways');
    expect(snapshot.session?.remainingRequests, 125);
  });

  test('maps protocol mismatch to the upgrade UI state', () {
    final json = _failedJson('protocol-mismatch');
    final snapshot = DesktopConnectionSnapshot.fromJson(json);
    expect(snapshot.state, DesktopConnectionState.protocolUpgradeRequired);
  });

  test('implements the exact reviewed connection-state fixture', () {
    final fixture = jsonDecode(
      File('../../protocol/fixtures/desktop-connection-states.json')
          .readAsStringSync(),
    ) as Map<String, Object?>;
    expect(
      fixture['protocol'],
      'greenways-connection-state-vocabulary/0-alpha',
    );
    final states = <String>{
      ...((fixture['shared']! as List<Object?>).cast<String>()),
      ...((fixture['desktopOnly']! as List<Object?>).cast<String>()),
    };
    expect(
      DesktopConnectionState.values.map((state) => state.wireName).toSet(),
      states,
    );
  });

  test('rejects legacy state aliases instead of expanding authority', () {
    for (final state in [
      'protocol-upgrade-required',
      'bridge-unavailable',
      'native-host-unavailable',
    ]) {
      expect(
        () => DesktopConnectionSnapshot.fromJson(_failedJson(state)),
        throwsFormatException,
      );
    }
  });

  test('rejects unknown fields and confidential authority', () {
    final unknown = _connectedJson()..['sessionId'] = 'local/session/hidden';
    expect(
      () => DesktopConnectionSnapshot.fromJson(unknown),
      throwsFormatException,
    );

    final credential = _failedJson('authentication-rejected');
    (credential['error']! as Map<String, Object?>)['message'] =
        'gwc_0000000000000000000000000000000000000000000000000000000000000000';
    expect(
      () => DesktopConnectionSnapshot.fromJson(credential),
      throwsFormatException,
    );
  });

  test('uses the shared wire vocabulary for Desktop-only failures', () {
    final snapshot = DesktopConnectionSnapshot.fromJson(
      _failedJson('desktop-bridge-unavailable'),
    );
    expect(snapshot.state, DesktopConnectionState.bridgeUnavailable);
    expect(snapshot.state.wireName, 'desktop-bridge-unavailable');
  });

  test('rejects redirected protocols, unsafe integers and session IDs', () {
    final redirected = _connectedJson();
    (redirected['daemon']! as Map<String, Object?>)['localProtocol'] =
        'greenways-local/changed';
    expect(
      () => DesktopConnectionSnapshot.fromJson(redirected),
      throwsFormatException,
    );

    final oversized = _connectedJson();
    (oversized['session']! as Map<String, Object?>)['remainingRequests'] =
        9007199254740992;
    expect(
      () => DesktopConnectionSnapshot.fromJson(oversized),
      throwsFormatException,
    );

    final sessionId = _failedJson('authentication-rejected');
    (sessionId['error']! as Map<String, Object?>)['message'] =
        'local/session/00112233445566778899aabbccddeeff';
    expect(
      () => DesktopConnectionSnapshot.fromJson(sessionId),
      throwsFormatException,
    );
  });

  test('rejects mismatched failure evidence and response request IDs', () {
    final mismatched = _failedJson('session-expired');
    (mismatched['error']! as Map<String, Object?>)['code'] =
        'authentication-rejected';
    expect(
      () => DesktopConnectionSnapshot.fromJson(mismatched),
      throwsFormatException,
    );

    expect(
      () => DesktopBridgeResponse.fromJson({
        'protocol': desktopBridgeResultProtocol,
        'requestId': 'local/request/not-desktop',
        'snapshot': _connectedJson(),
      }),
      throwsFormatException,
    );
  });

  test('diagnostics omit error text and all secret-shaped fields', () {
    final snapshot = DesktopConnectionSnapshot.fromJson(_connectedJson());
    final diagnostics = snapshot.diagnosticsJson();
    for (final forbidden in [
      'gwc_',
      'sessionId',
      'credential',
      'privateKey',
      'keyHandle',
      'providerHandle',
      'local/client/',
      '"id": "identity/',
      'openedAtUnixMs',
    ]) {
      expect(diagnostics, isNot(contains(forbidden)));
    }
    expect(diagnostics, contains('Greenways Desktop'));
    expect(diagnostics, contains('greenways'));
  });

  test('rejects changed nested protocols and mismatched error evidence', () {
    final daemon = _connectedJson();
    (daemon['daemon']! as Map<String, Object?>)['authorityMode'] = 'browser';
    expect(
      () => DesktopConnectionSnapshot.fromJson(daemon),
      throwsFormatException,
    );

    final identity = _connectedJson();
    (identity['identity']! as Map<String, Object?>)['algorithm'] = 'other';
    expect(
      () => DesktopConnectionSnapshot.fromJson(identity),
      throwsFormatException,
    );

    final error = _failedJson('daemon-unavailable');
    (error['error']! as Map<String, Object?>)['code'] =
        'authentication-rejected';
    expect(
      () => DesktopConnectionSnapshot.fromJson(error),
      throwsFormatException,
    );
  });
}

Map<String, Object?> _connectedJson() => {
  'protocol': desktopConnectionStatusProtocol,
  'state': 'connected',
  'daemon': {
    'protocol': 'greenways-daemon-status/0-alpha',
    'nodeId': 'node/00112233445566778899aabbccddeeff',
    'daemonVersion': '0.1.0',
    'localProtocol': 'greenways-local/0-alpha',
    'generation': 4,
    'stateRevision': 9,
    'startedAtUnixMs': 1,
    'observedAtUnixMs': 2,
    'profileMode': 'configured',
    'authorityMode': 'daemon',
  },
  'actor': {
    'protocol': 'greenways-local-client/0-alpha',
    'id': 'local/client/00112233445566778899aabbccddeeff',
    'role': 'desktop',
    'label': 'Greenways Desktop',
    'createdAtUnixMs': 1,
    'revokedAtUnixMs': null,
  },
  'identity': {
    'protocol': 'greenways-profile-identity/0-alpha',
    'id': 'identity/00112233445566778899aabbccddeeff',
    'handle': 'greenways',
    'keyId': 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    'algorithm': 'p256-sha256-fixed',
    'createdAtUnixMs': 1,
  },
  'session': {
    'protocol': desktopSessionProjectionProtocol,
    'openedAtUnixMs': 1,
    'expiresAtUnixMs': 300001,
    'remainingRequests': 125,
  },
  'error': null,
  'observedAtUnixMs': 2,
};

Map<String, Object?> _failedJson(String state) => {
  'protocol': desktopConnectionStatusProtocol,
  'state': state,
  'daemon': null,
  'actor': null,
  'identity': null,
  'session': null,
  'error': {'code': state, 'message': 'Bounded failure.'},
  'observedAtUnixMs': 2,
};

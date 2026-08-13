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
    expect(snapshot.session?.remainingRequests, 124);
    expect(snapshot.hestiaImport?.verificationScope, 'compiled-lock');
    expect(snapshot.hestiaImport?.admittedRoomProjectionCount, 0);
  });

  test('requires the exact closed Hestia compiled import projection', () {
    final snapshot = DesktopConnectionSnapshot.fromJson(_connectedJson());
    final imported = snapshot.hestiaImport!;
    expect(imported.protocol, hestiaImportStatusProtocol);
    expect(imported.state, hestiaImportState);
    expect(imported.repository, hestiaImportRepository);
    expect(imported.revision, hestiaImportRevision);
    expect(imported.package, hestiaImportPackage);
    expect(imported.artifactCount, hestiaImportArtifactCount);
    expect(imported.roomInvocationProtocol, hestiaRoomInvocationProtocol);
    expect(imported.authorityDecisionProtocol, hestiaAuthorityDecisionProtocol);
    expect(
      imported.preparedExecutionProtocol,
      greenwaysPreparedRoomExecutionProtocol,
    );
    expect(imported.verificationScope, hestiaImportVerificationScope);
    expect(imported.roomProjectionsAdmitted, isFalse);
    expect(imported.admittedRoomProjectionCount, 0);
  });

  test('rejects missing, changed and expanded Hestia import metadata', () {
    final missing = _connectedJson()..remove('hestiaImport');
    expect(
      () => DesktopConnectionSnapshot.fromJson(missing),
      throwsFormatException,
    );

    for (final change in <void Function(Map<String, Object?>)>[
      (value) => value['protocol'] = 'changed',
      (value) => value['repository'] = 'other/hestia',
      (value) => value['package'] = '@other/hestia',
      (value) => value['revision'] = List.filled(40, '0').join(),
      (value) => value['artifactCount'] = 13,
      (value) => value['roomInvocationProtocol'] = 'changed',
      (value) => value['authorityDecisionProtocol'] = 'changed',
      (value) => value['preparedExecutionProtocol'] = 'changed',
      (value) => value['verificationScope'] = 'live-room-state',
      (value) => value['artifactPaths'] = <Object?>[],
    ]) {
      final changed = _connectedJson();
      change(changed['hestiaImport']! as Map<String, Object?>);
      expect(
        () => DesktopConnectionSnapshot.fromJson(changed),
        throwsFormatException,
      );
    }
  });

  test('rejects admitted room projections in the readiness-only build', () {
    final mismatched = _connectedJson();
    (mismatched['hestiaImport']!
            as Map<String, Object?>)['roomProjectionsAdmitted'] =
        true;
    expect(
      () => DesktopConnectionSnapshot.fromJson(mismatched),
      throwsFormatException,
    );

    final admitted = _connectedJson();
    final imported = admitted['hestiaImport']! as Map<String, Object?>;
    imported['roomProjectionsAdmitted'] = true;
    imported['admittedRoomProjectionCount'] = 1;
    expect(
      () => DesktopConnectionSnapshot.fromJson(admitted),
      throwsFormatException,
    );
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
      'browser/src',
      'artifactPaths',
      'artifactDigest',
      'membershipRoot',
    ]) {
      expect(diagnostics, isNot(contains(forbidden)));
    }
    expect(diagnostics, contains('Greenways Desktop'));
    expect(diagnostics, contains('greenways'));
    expect(diagnostics, contains('@greenways/hestia-browser'));
    expect(diagnostics, contains('compiled-lock'));
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
  'hestiaImport': _hestiaImportJson(),
  'session': {
    'protocol': desktopSessionProjectionProtocol,
    'openedAtUnixMs': 1,
    'expiresAtUnixMs': 300001,
    'remainingRequests': 124,
  },
  'error': null,
  'observedAtUnixMs': 2,
};

Map<String, Object?> _hestiaImportJson() => {
  'protocol': hestiaImportStatusProtocol,
  'state': hestiaImportState,
  'repository': hestiaImportRepository,
  'revision': hestiaImportRevision,
  'package': hestiaImportPackage,
  'artifactCount': hestiaImportArtifactCount,
  'roomInvocationProtocol': hestiaRoomInvocationProtocol,
  'authorityDecisionProtocol': hestiaAuthorityDecisionProtocol,
  'preparedExecutionProtocol': greenwaysPreparedRoomExecutionProtocol,
  'verificationScope': hestiaImportVerificationScope,
  'roomProjectionsAdmitted': false,
  'admittedRoomProjectionCount': 0,
};

Map<String, Object?> _failedJson(String state) => {
  'protocol': desktopConnectionStatusProtocol,
  'state': state,
  'daemon': null,
  'actor': null,
  'identity': null,
  'hestiaImport': null,
  'session': null,
  'error': {'code': state, 'message': 'Bounded failure.'},
  'observedAtUnixMs': 2,
};

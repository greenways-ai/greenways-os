import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/model/setup_snapshot.dart';

void main() {
  test('decodes the closed setup inspection projection', () {
    final snapshot = DesktopSetupSnapshot.fromJson(_setupJson());
    expect(snapshot.state, DesktopSetupState.identityOptional);
    expect(snapshot.components.length, 5);
    expect(snapshot.mandatoryReady, isTrue);
    expect(snapshot.permittedActions, const [DesktopSetupOperation.inspect]);
  });

  test('requires exact setup keys and fixed component order', () {
    final expanded = _setupJson()..['extra'] = true;
    expect(
      () => DesktopSetupSnapshot.fromJson(expanded),
      throwsFormatException,
    );
    final reordered = _setupJson();
    final components = reordered['components']! as List<Object?>;
    final first = components.removeAt(0);
    components.add(first);
    expect(
      () => DesktopSetupSnapshot.fromJson(reordered),
      throwsFormatException,
    );
  });

  test('rejects aggregate state drift', () {
    final drifted = _setupJson()..['state'] = 'complete';
    expect(() => DesktopSetupSnapshot.fromJson(drifted), throwsFormatException);
  });

  test('daemon installation states expose only the daemon setup action', () {
    final json = _setupJson();
    json['state'] = 'install-required';
    final components = json['components']! as List<Object?>;
    components[0] = _component(
      'greenways-home',
      'install-required',
      errorCode: 'home-install-required',
    );
    components[1] = _component(
      'daemon',
      'install-required',
      errorCode: 'daemon-install-required',
    );
    json['permittedActions'] = <Object?>['install-daemon', 'inspect'];

    final snapshot = DesktopSetupSnapshot.fromJson(json);
    expect(snapshot.state, DesktopSetupState.installRequired);
    expect(snapshot.permittedActions, const [
      DesktopSetupOperation.installDaemon,
      DesktopSetupOperation.inspect,
    ]);
  });

  test('credential-required exposes only fixed Desktop enrollment', () {
    final json = _setupJson();
    json['state'] = 'credential-required';
    final components = json['components']! as List<Object?>;
    components[2] = _component(
      'desktop-client',
      'credential-required',
      errorCode: 'desktop-credential-required',
    );
    json['permittedActions'] = <Object?>['issue-desktop-client', 'inspect'];

    final snapshot = DesktopSetupSnapshot.fromJson(json);
    expect(snapshot.state, DesktopSetupState.credentialRequired);
    expect(snapshot.permittedActions, const [
      DesktopSetupOperation.issueDesktopClient,
      DesktopSetupOperation.inspect,
    ]);
  });

  test('diagnostics remain bounded and serializable', () {
    final snapshot = DesktopSetupSnapshot.fromJson(_setupJson());
    final diagnostics = jsonDecode(snapshot.diagnosticsJson());
    expect(diagnostics, isA<Map<String, Object?>>());
    expect(jsonEncode(diagnostics), contains('identity-optional'));
  });
}

Map<String, Object?> _setupJson() => {
  'protocol': desktopSetupStatusProtocol,
  'state': 'identity-optional',
  'components': <Object?>[
    _component('greenways-home', 'ready'),
    _component(
      'daemon',
      'ready',
      version: '0.1.0',
      publicId: 'node/00112233445566778899aabbccddeeff',
    ),
    _component('desktop-client', 'ready'),
    _component('identity', 'identity-optional'),
    _component('browser-companion', 'browser-companion-optional'),
  ],
  'permittedActions': <Object?>['inspect'],
  'observedAtUnixMs': 2,
  'error': null,
};

Map<String, Object?> _component(
  String kind,
  String state, {
  String? version,
  String? publicId,
  String? errorCode,
}) => {
  'protocol': desktopSetupComponentProtocol,
  'kind': kind,
  'state': state,
  'version': version,
  'digest': null,
  'publicId': publicId,
  'errorCode': errorCode,
};

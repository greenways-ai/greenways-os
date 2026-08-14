import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:greenways_desktop/model/setup_snapshot.dart';

void main() {
  test('decodes the closed setup inspection projection', () {
    final snapshot = DesktopSetupSnapshot.fromJson(_setupJson());
    expect(snapshot.state, DesktopSetupState.identityOptional);
    expect(snapshot.components.length, 5);
    expect(snapshot.mandatoryReady, isTrue);
    expect(snapshot.permittedActions, const [
      DesktopSetupOperation.createIdentity,
      DesktopSetupOperation.recoverIdentity,
      DesktopSetupOperation.inspect,
    ]);
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

  test(
    'identity optional exposes create, native recovery, and inspection only',
    () {
      final snapshot = DesktopSetupSnapshot.fromJson(_setupJson());
      expect(snapshot.permittedActions, const [
        DesktopSetupOperation.createIdentity,
        DesktopSetupOperation.recoverIdentity,
        DesktopSetupOperation.inspect,
      ]);
    },
  );

  test('browser optional exposes only exact installation and inspection', () {
    final json = _setupJson();
    json['state'] = 'browser-companion-optional';
    final components = json['components']! as List<Object?>;
    components[3] = _component('identity', 'ready');
    json['permittedActions'] = <Object?>['install-browser-bridge', 'inspect'];

    final snapshot = DesktopSetupSnapshot.fromJson(json);
    expect(snapshot.state, DesktopSetupState.browserCompanionOptional);
    expect(snapshot.permittedActions, const [
      DesktopSetupOperation.installBrowserBridge,
      DesktopSetupOperation.inspect,
    ]);
  });

  test('all installed components require later connection verification', () {
    final json = _setupJson();
    json['state'] = 'verification-required';
    final components = json['components']! as List<Object?>;
    components[3] = _component('identity', 'ready');
    components[4] = _component(
      'browser-companion',
      'ready',
      version: '0.1.0',
      digest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      publicId: 'ai.greenways.browser_bridge',
    );
    json['permittedActions'] = <Object?>['inspect'];

    final snapshot = DesktopSetupSnapshot.fromJson(json);
    expect(snapshot.state, DesktopSetupState.verificationRequired);
    expect(snapshot.permittedActions, const [DesktopSetupOperation.inspect]);
    expect(snapshot.mandatoryReady, isTrue);
    expect(
      snapshot.component(DesktopSetupComponentKind.browserCompanion)?.publicId,
      'ai.greenways.browser_bridge',
    );
  });

  test('normalizes only bounded public identity handles', () {
    expect(normalizeDesktopIdentityHandle('@River.Studio'), 'river.studio');
    expect(normalizeDesktopIdentityHandle(' a_b-c.9 '), 'a_b-c.9');
    expect(normalizeDesktopIdentityHandle('river/studio'), isNull);
    expect(normalizeDesktopIdentityHandle('-river'), isNull);
    expect(normalizeDesktopIdentityHandle('river-'), isNull);
    expect(normalizeDesktopIdentityHandle(List.filled(49, 'x').join()), isNull);
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
  'permittedActions': <Object?>[
    'create-identity',
    'recover-identity',
    'inspect',
  ],
  'observedAtUnixMs': 2,
  'error': null,
};

Map<String, Object?> _component(
  String kind,
  String state, {
  String? version,
  String? digest,
  String? publicId,
  String? errorCode,
}) => {
  'protocol': desktopSetupComponentProtocol,
  'kind': kind,
  'state': state,
  'version': version,
  'digest': digest,
  'publicId': publicId,
  'errorCode': errorCode,
};

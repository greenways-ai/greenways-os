import 'dart:convert';

const desktopBridgeProtocol = 'greenways-desktop-bridge/0-alpha';
const desktopBridgeResultProtocol = 'greenways-desktop-bridge-result/0-alpha';
const desktopConnectionStatusProtocol =
    'greenways-desktop-connection-status/0-alpha';
const desktopSessionProjectionProtocol =
    'greenways-desktop-session-projection/0-alpha';
const daemonStatusProtocol = 'greenways-daemon-status/0-alpha';
const greenwaysLocalProtocol = 'greenways-local/0-alpha';
const localClientProtocol = 'greenways-local-client/0-alpha';
const profileIdentityProtocol = 'greenways-profile-identity/0-alpha';
const profileIdentityAlgorithm = 'p256-sha256-fixed';
const _maximumSafeInteger = 9007199254740991;

final _nodeIdPattern = RegExp(r'^node/[0-9a-f]{32}$');
final _clientIdPattern = RegExp(r'^local/client/[0-9a-f]{32}$');
final _identityIdPattern = RegExp(r'^identity/[0-9a-f]{32}$');
final _digestPattern = RegExp(r'^sha256:[0-9a-f]{64}$');
final _requestIdPattern = RegExp(r'^desktop/request/[A-Za-z0-9._:-]{8,160}$');
final _confidentialValuePattern = RegExp(
  r'(^gwc_|local/session/|profile-key-|provider-key-|credential-key-)',
  caseSensitive: false,
);

const _forbiddenKeys = <String>{
  'token',
  'credential',
  'secret',
  'password',
  'cookie',
  'authorization',
  'privatekey',
  'keyhandle',
  'providerhandle',
  'sessionid',
};

enum DesktopConnectionState {
  connecting,
  connected,
  daemonUnavailable,
  credentialUnavailable,
  authenticationRejected,
  sessionExpired,
  protocolUpgradeRequired,
  bridgeUnavailable,
  disconnected;

  static DesktopConnectionState fromWire(String value) => switch (value) {
    'connecting' => connecting,
    'connected' => connected,
    'daemon-unavailable' => daemonUnavailable,
    'credential-unavailable' => credentialUnavailable,
    'authentication-rejected' => authenticationRejected,
    'session-expired' => sessionExpired,
    'protocol-mismatch' => protocolUpgradeRequired,
    'desktop-bridge-unavailable' => bridgeUnavailable,
    'disconnected' => disconnected,
    _ => throw const FormatException('Unsupported Desktop connection state.'),
  };

  String get wireName => switch (this) {
    connecting => 'connecting',
    connected => 'connected',
    daemonUnavailable => 'daemon-unavailable',
    credentialUnavailable => 'credential-unavailable',
    authenticationRejected => 'authentication-rejected',
    sessionExpired => 'session-expired',
    protocolUpgradeRequired => 'protocol-mismatch',
    bridgeUnavailable => 'desktop-bridge-unavailable',
    disconnected => 'disconnected',
  };
}

final class DesktopDaemonProjection {
  const DesktopDaemonProjection({
    required this.protocol,
    required this.nodeId,
    required this.daemonVersion,
    required this.localProtocol,
    required this.generation,
    required this.stateRevision,
    required this.startedAtUnixMs,
    required this.observedAtUnixMs,
    required this.profileMode,
    required this.authorityMode,
  });

  factory DesktopDaemonProjection.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {
      'protocol',
      'nodeId',
      'daemonVersion',
      'localProtocol',
      'generation',
      'stateRevision',
      'startedAtUnixMs',
      'observedAtUnixMs',
      'profileMode',
      'authorityMode',
    });
    final protocol = _text(json, 'protocol');
    final nodeId = _text(json, 'nodeId', maximum: 160);
    final daemonLocalProtocol = _text(json, 'localProtocol', maximum: 120);
    final authorityMode = _text(json, 'authorityMode', maximum: 80);
    final startedAtUnixMs = _integer(json, 'startedAtUnixMs', positive: true);
    final observedAtUnixMs = _integer(json, 'observedAtUnixMs', positive: true);
    if (protocol != daemonStatusProtocol ||
        daemonLocalProtocol != greenwaysLocalProtocol ||
        authorityMode != 'daemon' ||
        !_nodeIdPattern.hasMatch(nodeId) ||
        observedAtUnixMs < startedAtUnixMs) {
      throw const FormatException('Desktop daemon projection is invalid.');
    }
    return DesktopDaemonProjection(
      protocol: protocol,
      nodeId: nodeId,
      daemonVersion: _text(json, 'daemonVersion', maximum: 80),
      localProtocol: daemonLocalProtocol,
      generation: _integer(json, 'generation', positive: true),
      stateRevision: _integer(json, 'stateRevision'),
      startedAtUnixMs: startedAtUnixMs,
      observedAtUnixMs: observedAtUnixMs,
      profileMode: _text(json, 'profileMode', maximum: 80),
      authorityMode: authorityMode,
    );
  }

  final String protocol;
  final String nodeId;
  final String daemonVersion;
  final String localProtocol;
  final int generation;
  final int stateRevision;
  final int startedAtUnixMs;
  final int observedAtUnixMs;
  final String profileMode;
  final String authorityMode;

  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'nodeId': nodeId,
    'daemonVersion': daemonVersion,
    'localProtocol': localProtocol,
    'generation': generation,
    'stateRevision': stateRevision,
    'startedAtUnixMs': startedAtUnixMs,
    'observedAtUnixMs': observedAtUnixMs,
    'profileMode': profileMode,
    'authorityMode': authorityMode,
  };
}

final class DesktopActorProjection {
  const DesktopActorProjection({
    required this.protocol,
    required this.id,
    required this.role,
    required this.label,
    required this.createdAtUnixMs,
  });

  factory DesktopActorProjection.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {
      'protocol',
      'id',
      'role',
      'label',
      'createdAtUnixMs',
      'revokedAtUnixMs',
    });
    final protocol = _text(json, 'protocol');
    final id = _text(json, 'id', maximum: 160);
    if (protocol != localClientProtocol ||
        !_clientIdPattern.hasMatch(id) ||
        json['role'] != 'desktop' ||
        json['revokedAtUnixMs'] != null) {
      throw const FormatException('Desktop actor projection is invalid.');
    }
    return DesktopActorProjection(
      protocol: protocol,
      id: id,
      role: _text(json, 'role'),
      label: _text(json, 'label', maximum: 120),
      createdAtUnixMs: _integer(json, 'createdAtUnixMs', positive: true),
    );
  }

  final String protocol;
  final String id;
  final String role;
  final String label;
  final int createdAtUnixMs;

  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'id': id,
    'role': role,
    'label': label,
    'createdAtUnixMs': createdAtUnixMs,
  };
}

final class DesktopIdentityProjection {
  const DesktopIdentityProjection({
    required this.protocol,
    required this.id,
    required this.handle,
    required this.keyId,
    required this.algorithm,
    required this.createdAtUnixMs,
  });

  factory DesktopIdentityProjection.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {
      'protocol',
      'id',
      'handle',
      'keyId',
      'algorithm',
      'createdAtUnixMs',
    });
    final protocol = _text(json, 'protocol');
    final id = _text(json, 'id', maximum: 160);
    final keyId = _text(json, 'keyId', maximum: 80);
    final algorithm = _text(json, 'algorithm', maximum: 80);
    if (protocol != profileIdentityProtocol ||
        !_identityIdPattern.hasMatch(id) ||
        !_digestPattern.hasMatch(keyId) ||
        algorithm != profileIdentityAlgorithm) {
      throw const FormatException('Desktop identity projection is invalid.');
    }
    return DesktopIdentityProjection(
      protocol: protocol,
      id: id,
      handle: _text(json, 'handle', maximum: 48),
      keyId: keyId,
      algorithm: algorithm,
      createdAtUnixMs: _integer(json, 'createdAtUnixMs', positive: true),
    );
  }

  final String protocol;
  final String id;
  final String handle;
  final String keyId;
  final String algorithm;
  final int createdAtUnixMs;

  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'id': id,
    'handle': handle,
    'keyId': keyId,
    'algorithm': algorithm,
    'createdAtUnixMs': createdAtUnixMs,
  };
}

final class DesktopSessionProjection {
  const DesktopSessionProjection({
    required this.protocol,
    required this.openedAtUnixMs,
    required this.expiresAtUnixMs,
    required this.remainingRequests,
  });

  factory DesktopSessionProjection.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {
      'protocol',
      'openedAtUnixMs',
      'expiresAtUnixMs',
      'remainingRequests',
    });
    final protocol = _text(json, 'protocol');
    final opened = _integer(json, 'openedAtUnixMs', positive: true);
    final expires = _integer(json, 'expiresAtUnixMs', positive: true);
    final remainingRequests = _integer(json, 'remainingRequests');
    if (protocol != desktopSessionProjectionProtocol ||
        expires <= opened ||
        expires - opened > const Duration(days: 1).inMilliseconds ||
        remainingRequests > 1024) {
      throw const FormatException('Desktop session projection is invalid.');
    }
    return DesktopSessionProjection(
      protocol: protocol,
      openedAtUnixMs: opened,
      expiresAtUnixMs: expires,
      remainingRequests: remainingRequests,
    );
  }

  final String protocol;
  final int openedAtUnixMs;
  final int expiresAtUnixMs;
  final int remainingRequests;

  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'openedAtUnixMs': openedAtUnixMs,
    'expiresAtUnixMs': expiresAtUnixMs,
    'remainingRequests': remainingRequests,
  };
}

final class DesktopPublicError {
  const DesktopPublicError({required this.code, required this.message});

  factory DesktopPublicError.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {'code', 'message'});
    return DesktopPublicError(
      code: DesktopConnectionState.fromWire(_text(json, 'code')),
      message: _text(json, 'message', maximum: 400),
    );
  }

  final DesktopConnectionState code;
  final String message;

  Map<String, Object?> toJson() => {'code': code.wireName, 'message': message};
}

final class DesktopConnectionSnapshot {
  const DesktopConnectionSnapshot({
    required this.protocol,
    required this.state,
    required this.daemon,
    required this.actor,
    required this.identity,
    required this.session,
    required this.error,
    required this.observedAtUnixMs,
  });

  factory DesktopConnectionSnapshot.fromJson(Map<String, Object?> json) {
    _scanForSecrets(json);
    _requireExactKeys(json, const {
      'protocol',
      'state',
      'daemon',
      'actor',
      'identity',
      'session',
      'error',
      'observedAtUnixMs',
    });
    final snapshot = DesktopConnectionSnapshot(
      protocol: _text(json, 'protocol'),
      state: DesktopConnectionState.fromWire(_text(json, 'state')),
      daemon: _nullableObject(json['daemon'], DesktopDaemonProjection.fromJson),
      actor: _nullableObject(json['actor'], DesktopActorProjection.fromJson),
      identity: _nullableObject(
        json['identity'],
        DesktopIdentityProjection.fromJson,
      ),
      session: _nullableObject(
        json['session'],
        DesktopSessionProjection.fromJson,
      ),
      error: _nullableObject(json['error'], DesktopPublicError.fromJson),
      observedAtUnixMs: _integer(json, 'observedAtUnixMs', positive: true),
    );
    snapshot._validateShape();
    return snapshot;
  }

  factory DesktopConnectionSnapshot.connecting() => DesktopConnectionSnapshot(
    protocol: desktopConnectionStatusProtocol,
    state: DesktopConnectionState.connecting,
    daemon: null,
    actor: null,
    identity: null,
    session: null,
    error: null,
    observedAtUnixMs: DateTime.now().millisecondsSinceEpoch,
  );

  factory DesktopConnectionSnapshot.disconnected() => DesktopConnectionSnapshot(
    protocol: desktopConnectionStatusProtocol,
    state: DesktopConnectionState.disconnected,
    daemon: null,
    actor: null,
    identity: null,
    session: null,
    error: null,
    observedAtUnixMs: DateTime.now().millisecondsSinceEpoch,
  );

  factory DesktopConnectionSnapshot.bridgeUnavailable(String message) =>
      DesktopConnectionSnapshot(
        protocol: desktopConnectionStatusProtocol,
        state: DesktopConnectionState.bridgeUnavailable,
        daemon: null,
        actor: null,
        identity: null,
        session: null,
        error: DesktopPublicError(
          code: DesktopConnectionState.bridgeUnavailable,
          message: message,
        ),
        observedAtUnixMs: DateTime.now().millisecondsSinceEpoch,
      );

  final String protocol;
  final DesktopConnectionState state;
  final DesktopDaemonProjection? daemon;
  final DesktopActorProjection? actor;
  final DesktopIdentityProjection? identity;
  final DesktopSessionProjection? session;
  final DesktopPublicError? error;
  final int observedAtUnixMs;

  bool get isConnected => state == DesktopConnectionState.connected;

  void _validateShape() {
    if (protocol != desktopConnectionStatusProtocol) {
      throw const FormatException(
        'Desktop connection protocol is unsupported.',
      );
    }
    final connectedShape = daemon != null && actor != null && session != null;
    if (isConnected) {
      if (!connectedShape || error != null) {
        throw const FormatException(
          'Connected Desktop projection is incomplete.',
        );
      }
      return;
    }
    if (daemon != null ||
        actor != null ||
        identity != null ||
        session != null) {
      throw const FormatException(
        'Inactive Desktop projection exposes authority data.',
      );
    }
    final inactive =
        state == DesktopConnectionState.connecting ||
        state == DesktopConnectionState.disconnected;
    if (inactive && error != null) {
      throw const FormatException('Inactive Desktop projection has an error.');
    }
    if (!inactive && (error == null || error!.code != state)) {
      throw const FormatException(
        'Failed Desktop projection has invalid error evidence.',
      );
    }
  }

  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'state': state.wireName,
    'daemon': daemon?.toJson(),
    'actor': actor?.toJson(),
    'identity': identity?.toJson(),
    'session': session?.toJson(),
    'error': error?.toJson(),
    'observedAtUnixMs': observedAtUnixMs,
  };

  String diagnosticsJson() => const JsonEncoder.withIndent('  ').convert({
    'protocol': protocol,
    'state': state.wireName,
    'daemon': daemon == null
        ? null
        : {
            'protocol': daemon!.protocol,
            'nodeId': daemon!.nodeId,
            'daemonVersion': daemon!.daemonVersion,
            'localProtocol': daemon!.localProtocol,
            'generation': daemon!.generation,
            'stateRevision': daemon!.stateRevision,
            'profileMode': daemon!.profileMode,
            'authorityMode': daemon!.authorityMode,
          },
    'actor': actor == null
        ? null
        : {
            'protocol': actor!.protocol,
            'role': actor!.role,
            'label': actor!.label,
          },
    'identity': identity == null
        ? null
        : {
            'protocol': identity!.protocol,
            'handle': identity!.handle,
            'keyId': identity!.keyId,
            'algorithm': identity!.algorithm,
          },
    'session': session == null
        ? null
        : {
            'protocol': session!.protocol,
            'expiresAtUnixMs': session!.expiresAtUnixMs,
            'remainingRequests': session!.remainingRequests,
          },
    'observedAtUnixMs': observedAtUnixMs,
  });
}

final class DesktopBridgeResponse {
  const DesktopBridgeResponse({
    required this.protocol,
    required this.requestId,
    required this.snapshot,
  });

  factory DesktopBridgeResponse.fromJson(Map<String, Object?> json) {
    _scanForSecrets(json);
    _requireExactKeys(json, const {'protocol', 'requestId', 'snapshot'});
    final protocol = _text(json, 'protocol');
    if (protocol != desktopBridgeResultProtocol) {
      throw const FormatException(
        'Desktop bridge result protocol is unsupported.',
      );
    }
    final requestId = _text(json, 'requestId', maximum: 180);
    if (!_requestIdPattern.hasMatch(requestId)) {
      throw const FormatException('Desktop bridge request ID is invalid.');
    }
    return DesktopBridgeResponse(
      protocol: protocol,
      requestId: requestId,
      snapshot: DesktopConnectionSnapshot.fromJson(
        _object(json['snapshot'], 'snapshot'),
      ),
    );
  }

  final String protocol;
  final String requestId;
  final DesktopConnectionSnapshot snapshot;
}

T? _nullableObject<T>(Object? value, T Function(Map<String, Object?>) decode) {
  if (value == null) return null;
  return decode(_object(value, 'projection'));
}

Map<String, Object?> _object(Object? value, String field) {
  if (value is! Map) {
    throw FormatException('$field must be an object.');
  }
  return value.map((key, entry) {
    if (key is! String) {
      throw FormatException('$field contains a non-text key.');
    }
    return MapEntry(key, entry);
  });
}

void _requireExactKeys(Map<String, Object?> json, Set<String> expected) {
  final actual = json.keys.toSet();
  if (actual.length != expected.length || !actual.containsAll(expected)) {
    throw const FormatException('Desktop projection contains unknown fields.');
  }
}

String _text(Map<String, Object?> json, String field, {int maximum = 400}) {
  final value = json[field];
  if (value is! String ||
      value.isEmpty ||
      value.length > maximum ||
      value.runes.any((rune) => rune < 0x20 || rune == 0x7f)) {
    throw FormatException('$field must be bounded public text.');
  }
  return value;
}

int _integer(Map<String, Object?> json, String field, {bool positive = false}) {
  final value = json[field];
  if (value is! int ||
      value < (positive ? 1 : 0) ||
      value > _maximumSafeInteger) {
    throw FormatException('$field must be a bounded integer.');
  }
  return value;
}

void _scanForSecrets(Object? value) {
  switch (value) {
    case Map<Object?, Object?> map:
      for (final entry in map.entries) {
        final key = entry.key;
        if (key is! String) {
          throw const FormatException('Desktop projection has a non-text key.');
        }
        final normalized = key.toLowerCase().replaceAll(
          RegExp('[^a-z0-9]'),
          '',
        );
        if (_forbiddenKeys.any(normalized.contains)) {
          throw const FormatException(
            'Desktop projection attempted to expose confidential authority.',
          );
        }
        _scanForSecrets(entry.value);
      }
    case Iterable<Object?> values:
      for (final entry in values) {
        _scanForSecrets(entry);
      }
    case String text when _confidentialValuePattern.hasMatch(text):
      throw const FormatException(
        'Desktop projection attempted to expose a local credential.',
      );
    default:
      return;
  }
}

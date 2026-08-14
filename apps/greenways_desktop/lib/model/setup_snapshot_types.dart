part of 'setup_snapshot.dart';

final class DesktopSetupComponent {
  const DesktopSetupComponent({
    required this.protocol,
    required this.kind,
    required this.state,
    required this.version,
    required this.digest,
    required this.publicId,
    required this.errorCode,
  });

  factory DesktopSetupComponent.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {
      'protocol',
      'kind',
      'state',
      'version',
      'digest',
      'publicId',
      'errorCode',
    });
    final protocol = _text(json, 'protocol', maximum: 120);
    final kind = DesktopSetupComponentKind.fromWire(_text(json, 'kind'));
    final state = DesktopSetupState.fromWire(_text(json, 'state'));
    final version = _nullableText(json, 'version', maximum: 80);
    final digest = _nullableText(json, 'digest', maximum: 80);
    final publicId = _nullableText(json, 'publicId', maximum: 180);
    final errorCode = _nullableText(json, 'errorCode', maximum: 100);
    final transientState = {
      DesktopSetupState.notInspected,
      DesktopSetupState.inspecting,
      DesktopSetupState.verificationRequired,
      DesktopSetupState.verifying,
      DesktopSetupState.complete,
      DesktopSetupState.failed,
    }.contains(state);
    final optionalState = {
      DesktopSetupState.identityOptional,
      DesktopSetupState.browserCompanionOptional,
    }.contains(state);
    final metadataWithoutReadiness =
        state != DesktopSetupState.ready &&
        (version != null || digest != null || publicId != null);
    final invalidErrorShape = state == DesktopSetupState.ready || optionalState
        ? errorCode != null
        : errorCode == null;
    if (protocol != desktopSetupComponentProtocol ||
        (digest != null && !_digestPattern.hasMatch(digest)) ||
        (errorCode != null && !_errorCodePattern.hasMatch(errorCode)) ||
        transientState ||
        metadataWithoutReadiness ||
        invalidErrorShape) {
      throw const FormatException('Desktop setup component is invalid.');
    }
    return DesktopSetupComponent(
      protocol: protocol,
      kind: kind,
      state: state,
      version: version,
      digest: digest,
      publicId: publicId,
      errorCode: errorCode,
    );
  }

  final String protocol;
  final DesktopSetupComponentKind kind;
  final DesktopSetupState state;
  final String? version;
  final String? digest;
  final String? publicId;
  final String? errorCode;

  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'kind': kind.wireName,
    'state': state.wireName,
    'version': version,
    'digest': digest,
    'publicId': publicId,
    'errorCode': errorCode,
  };
}

final class DesktopSetupPublicError {
  const DesktopSetupPublicError({required this.code, required this.message});

  factory DesktopSetupPublicError.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {'code', 'message'});
    final code = _text(json, 'code', maximum: 100);
    final message = _text(json, 'message', maximum: 400);
    if (!_errorCodePattern.hasMatch(code)) {
      throw const FormatException('Desktop setup error code is invalid.');
    }
    return DesktopSetupPublicError(code: code, message: message);
  }

  final String code;
  final String message;

  Map<String, Object?> toJson() => {'code': code, 'message': message};
}

final class DesktopSetupSnapshot {
  const DesktopSetupSnapshot({
    required this.protocol,
    required this.state,
    required this.components,
    required this.permittedActions,
    required this.observedAtUnixMs,
    required this.error,
  });

  factory DesktopSetupSnapshot.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {
      'protocol',
      'state',
      'components',
      'permittedActions',
      'observedAtUnixMs',
      'error',
    });
    final protocol = _text(json, 'protocol', maximum: 120);
    final state = DesktopSetupState.fromWire(_text(json, 'state'));
    final components = _objects(
      json,
      'components',
      DesktopSetupComponent.fromJson,
    );
    final actions = _texts(
      json,
      'permittedActions',
    ).map(DesktopSetupOperation.fromWire).toList(growable: false);
    final observedAtUnixMs = _integer(json, 'observedAtUnixMs', positive: true);
    final error = _nullableObject(
      json['error'],
      DesktopSetupPublicError.fromJson,
    );
    final snapshot = DesktopSetupSnapshot(
      protocol: protocol,
      state: state,
      components: components,
      permittedActions: actions,
      observedAtUnixMs: observedAtUnixMs,
      error: error,
    );
    snapshot._validate();
    return snapshot;
  }

  factory DesktopSetupSnapshot.notInspected() => DesktopSetupSnapshot(
    protocol: desktopSetupStatusProtocol,
    state: DesktopSetupState.notInspected,
    components: const [],
    permittedActions: const [DesktopSetupOperation.inspect],
    observedAtUnixMs: DateTime.now().millisecondsSinceEpoch,
    error: null,
  );

  factory DesktopSetupSnapshot.inspecting() => DesktopSetupSnapshot(
    protocol: desktopSetupStatusProtocol,
    state: DesktopSetupState.inspecting,
    components: const [],
    permittedActions: const [],
    observedAtUnixMs: DateTime.now().millisecondsSinceEpoch,
    error: null,
  );

  factory DesktopSetupSnapshot.failed(String message) => DesktopSetupSnapshot(
    protocol: desktopSetupStatusProtocol,
    state: DesktopSetupState.failed,
    components: const [],
    permittedActions: const [DesktopSetupOperation.inspect],
    observedAtUnixMs: DateTime.now().millisecondsSinceEpoch,
    error: DesktopSetupPublicError(
      code: 'setup-bridge-unavailable',
      message: message,
    ),
  );

  final String protocol;
  final DesktopSetupState state;
  final List<DesktopSetupComponent> components;
  final List<DesktopSetupOperation> permittedActions;
  final int observedAtUnixMs;
  final DesktopSetupPublicError? error;

  bool get inspected => !{
    DesktopSetupState.notInspected,
    DesktopSetupState.inspecting,
    DesktopSetupState.verifying,
    DesktopSetupState.failed,
  }.contains(state);

  bool get mandatoryReady {
    if (!inspected || components.length != _componentOrder.length) return false;
    final byKind = {
      for (final component in components) component.kind: component,
    };
    return byKind[DesktopSetupComponentKind.greenwaysHome]?.state ==
            DesktopSetupState.ready &&
        byKind[DesktopSetupComponentKind.daemon]?.state ==
            DesktopSetupState.ready &&
        byKind[DesktopSetupComponentKind.desktopClient]?.state ==
            DesktopSetupState.ready;
  }

  DesktopSetupComponent? component(DesktopSetupComponentKind kind) {
    for (final component in components) {
      if (component.kind == kind) return component;
    }
    return null;
  }

  void _validate() {
    if (protocol != desktopSetupStatusProtocol ||
        observedAtUnixMs <= 0 ||
        observedAtUnixMs > _maximumSafeInteger) {
      throw const FormatException('Desktop setup projection is invalid.');
    }
    switch (state) {
      case DesktopSetupState.notInspected:
        _requireTransientShape(
          expectedActions: const [DesktopSetupOperation.inspect],
          requiresError: false,
        );
        break;
      case DesktopSetupState.inspecting:
      case DesktopSetupState.verifying:
        _requireTransientShape(expectedActions: const [], requiresError: false);
        break;
      case DesktopSetupState.failed:
        _requireTransientShape(
          expectedActions: const [DesktopSetupOperation.inspect],
          requiresError: true,
        );
        break;
      default:
        if (components.length != _componentOrder.length ||
            error != null ||
            !_sameActions(permittedActions, _permittedActionsForState(state))) {
          throw const FormatException(
            'Inspected Desktop setup projection is invalid.',
          );
        }
        for (var index = 0; index < components.length; index++) {
          if (components[index].kind != _componentOrder[index]) {
            throw const FormatException(
              'Desktop setup components are out of order.',
            );
          }
        }
        if (state != _deriveSetupState(components)) {
          throw const FormatException(
            'Desktop setup state does not match its components.',
          );
        }
        break;
    }
  }

  void _requireTransientShape({
    required List<DesktopSetupOperation> expectedActions,
    required bool requiresError,
  }) {
    if (components.isNotEmpty ||
        !_sameActions(permittedActions, expectedActions) ||
        (error != null) != requiresError) {
      throw const FormatException('Desktop setup transient state is invalid.');
    }
  }

  Map<String, Object?> toJson() => {
    'protocol': protocol,
    'state': state.wireName,
    'components': components.map((value) => value.toJson()).toList(),
    'permittedActions': permittedActions
        .map((value) => value.wireName)
        .toList(),
    'observedAtUnixMs': observedAtUnixMs,
    'error': error?.toJson(),
  };

  String diagnosticsJson() {
    final diagnostics = <String, Object?>{
      'protocol': protocol,
      'state': state.wireName,
      'components': [
        for (final component in components)
          {
            'kind': component.kind.wireName,
            'state': component.state.wireName,
            'version': component.version,
            'digest': component.digest,
            'publicId': component.publicId,
            'errorCode': component.errorCode,
          },
      ],
      'permittedActions': permittedActions
          .map((value) => value.wireName)
          .toList(),
      'observedAtUnixMs': observedAtUnixMs,
      'errorCode': error?.code,
    };
    return const JsonEncoder.withIndent('  ').convert(diagnostics);
  }
}

final class DesktopSetupResponse {
  const DesktopSetupResponse({
    required this.protocol,
    required this.requestId,
    required this.snapshot,
  });

  factory DesktopSetupResponse.fromJson(Map<String, Object?> json) {
    _requireExactKeys(json, const {'protocol', 'requestId', 'snapshot'});
    final protocol = _text(json, 'protocol', maximum: 120);
    final requestId = _text(json, 'requestId', maximum: 180);
    if (protocol != desktopSetupResultProtocol ||
        !_requestIdPattern.hasMatch(requestId)) {
      throw const FormatException('Desktop setup result is invalid.');
    }
    return DesktopSetupResponse(
      protocol: protocol,
      requestId: requestId,
      snapshot: DesktopSetupSnapshot.fromJson(
        _stringObject(json['snapshot'], 'snapshot'),
      ),
    );
  }

  final String protocol;
  final String requestId;
  final DesktopSetupSnapshot snapshot;
}

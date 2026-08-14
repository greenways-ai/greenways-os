part of 'setup_snapshot.dart';

List<DesktopSetupOperation> _permittedActionsForState(DesktopSetupState state) {
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
        DesktopSetupOperation.inspect,
      ];
    case DesktopSetupState.inspecting:
    case DesktopSetupState.verifying:
      return const [];
    default:
      return const [DesktopSetupOperation.inspect];
  }
}

DesktopSetupState _deriveSetupState(List<DesktopSetupComponent> components) {
  final states = components.map((component) => component.state).toSet();
  if (states.contains(DesktopSetupState.manualRecoveryRequired)) {
    return DesktopSetupState.manualRecoveryRequired;
  }
  if (states.contains(DesktopSetupState.permissionRepairRequired)) {
    return DesktopSetupState.permissionRepairRequired;
  }
  if (states.contains(DesktopSetupState.credentialRoleMismatch)) {
    return DesktopSetupState.credentialRoleMismatch;
  }
  if (states.contains(DesktopSetupState.upgradeRequired)) {
    return DesktopSetupState.upgradeRequired;
  }
  if (states.contains(DesktopSetupState.restartRequired)) {
    return DesktopSetupState.restartRequired;
  }
  if (states.contains(DesktopSetupState.installRequired)) {
    return DesktopSetupState.installRequired;
  }
  if (states.contains(DesktopSetupState.credentialRequired)) {
    return DesktopSetupState.credentialRequired;
  }
  if (states.contains(DesktopSetupState.identityOptional)) {
    return DesktopSetupState.identityOptional;
  }
  if (states.contains(DesktopSetupState.browserCompanionOptional)) {
    return DesktopSetupState.browserCompanionOptional;
  }
  if (states.every((state) => state == DesktopSetupState.ready)) {
    return DesktopSetupState.complete;
  }
  return DesktopSetupState.ready;
}

bool _sameActions(
  List<DesktopSetupOperation> left,
  List<DesktopSetupOperation> right,
) {
  if (left.length != right.length) return false;
  for (var index = 0; index < left.length; index++) {
    if (left[index] != right[index]) return false;
  }
  return true;
}

void _requireExactKeys(Map<String, Object?> json, Set<String> expected) {
  if (json.keys.toSet().length != expected.length ||
      !json.keys.toSet().containsAll(expected)) {
    throw const FormatException('Desktop setup object has unexpected fields.');
  }
}

String _text(Map<String, Object?> json, String field, {int maximum = 400}) {
  final value = json[field];
  if (value is! String || value.isEmpty || value.length > maximum) {
    throw FormatException('$field must be bounded text.');
  }
  if (_confidentialValuePattern.hasMatch(value)) {
    throw FormatException('$field contains confidential data.');
  }
  return value;
}

String? _nullableText(
  Map<String, Object?> json,
  String field, {
  int maximum = 400,
}) {
  if (json[field] == null) return null;
  return _text(json, field, maximum: maximum);
}

int _integer(Map<String, Object?> json, String field, {bool positive = false}) {
  final value = json[field];
  if (value is! int ||
      value < (positive ? 1 : 0) ||
      value > _maximumSafeInteger) {
    throw FormatException('$field must be a safe integer.');
  }
  return value;
}

List<String> _texts(Map<String, Object?> json, String field) {
  final value = json[field];
  if (value is! List || value.length > 16) {
    throw FormatException('$field must be a bounded list.');
  }
  return value
      .map((entry) {
        if (entry is! String || entry.isEmpty || entry.length > 100) {
          throw FormatException('$field contains invalid text.');
        }
        return entry;
      })
      .toList(growable: false);
}

List<T> _objects<T>(
  Map<String, Object?> json,
  String field,
  T Function(Map<String, Object?>) decode,
) {
  final value = json[field];
  if (value is! List || value.length > 16) {
    throw FormatException('$field must be a bounded list.');
  }
  return value
      .map((entry) => decode(_stringObject(entry, field)))
      .toList(growable: false);
}

T? _nullableObject<T>(Object? value, T Function(Map<String, Object?>) decode) =>
    value == null ? null : decode(_stringObject(value, 'object'));

Map<String, Object?> _stringObject(Object? value, String field) {
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

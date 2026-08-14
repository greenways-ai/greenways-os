#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 tool/bootstrap_macos.py
flutter pub get
dart format lib test
dart format --output=none --set-exit-if-changed lib test
flutter analyze
flutter test
flutter build macos --release

RESOURCES="build/macos/Build/Products/Release/Greenways Desktop.app/Contents/Resources"
for BINARY in greenways-desktop-bridge greenways-browser-bridge-host greenwaysd; do
  test -x "$RESOURCES/$BINARY"
  test -s "$RESOURCES/$BINARY"
done
"$RESOURCES/greenways-browser-bridge-host" --version | grep -Fx "greenways-browser-bridge-host 0.1.0"

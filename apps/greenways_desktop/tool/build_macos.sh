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

test -x "build/macos/Build/Products/Release/Greenways Desktop.app/Contents/Resources/greenways-desktop-bridge"
test -x "build/macos/Build/Products/Release/Greenways Desktop.app/Contents/Resources/greenwaysd"

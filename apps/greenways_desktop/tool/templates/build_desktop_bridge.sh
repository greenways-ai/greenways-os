#!/bin/bash
set -euo pipefail

ROOT="$(cd "$PROJECT_DIR/../../.." && pwd)"
PROFILE="debug"
CARGO_FLAGS=()
if [[ "$CONFIGURATION" != "Debug" ]]; then
  PROFILE="release"
  CARGO_FLAGS+=(--release)
fi

cd "$ROOT"
cargo build \
  -p greenways-desktop-bridge \
  -p greenways-browser-bridge-host \
  -p greenwaysd \
  -p greenways-cli \
  "${CARGO_FLAGS[@]}"

RESOURCES="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH"
mkdir -p "$RESOURCES"
for BINARY in greenways-desktop-bridge greenways-browser-bridge-host greenwaysd greenways; do
  SOURCE="$ROOT/target/$PROFILE/$BINARY"
  DESTINATION="$RESOURCES/$BINARY"
  install -m 0755 "$SOURCE" "$DESTINATION"

  if [[ "${CODE_SIGNING_ALLOWED:-NO}" == "YES" && -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
    /usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
      --preserve-metadata=identifier,entitlements,flags "$DESTINATION"
  fi
done

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
cargo build -p greenways-desktop-bridge "${CARGO_FLAGS[@]}"

SOURCE="$ROOT/target/$PROFILE/greenways-desktop-bridge"
DESTINATION="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/greenways-desktop-bridge"
mkdir -p "$(dirname "$DESTINATION")"
install -m 0755 "$SOURCE" "$DESTINATION"

if [[ "${CODE_SIGNING_ALLOWED:-NO}" == "YES" && -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]]; then
  /usr/bin/codesign --force --sign "$EXPANDED_CODE_SIGN_IDENTITY" \
    --preserve-metadata=identifier,entitlements,flags "$DESTINATION"
fi

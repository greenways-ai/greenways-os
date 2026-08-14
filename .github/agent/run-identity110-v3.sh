#!/usr/bin/env bash
set -euo pipefail

python3 - <<'PY'
import base64
import gzip
import hashlib
from pathlib import Path

parts = sorted(Path('.github/agent').glob('identity110.chunk-*'))
assert len(parts) == 19, len(parts)
encoded = b''.join(part.read_bytes() for part in parts)
assert len(encoded) == 18812, len(encoded)
assert hashlib.sha256(encoded).hexdigest() == '4facb058b0d7206366d58f787e0542ba90ccc413e937244f78a22c2c3dab0e01'
archive = base64.b64decode(encoded, validate=True)
assert len(archive) == 14107, len(archive)
assert hashlib.sha256(archive).hexdigest() == '56295e5615a37b34936287d812466fdd8397b3bfa784648af909429751c840ae'
patch = gzip.decompress(archive)
assert len(patch) == 61747, len(patch)
assert hashlib.sha256(patch).hexdigest() == '58b4f970f60bbd2dedb10225196826fb6309d94c1e7d5986e97b51e4cc642324'
Path('/tmp/desktop-identity-110.patch').write_bytes(patch)
PY
cp .github/agent/fix-identity110.py /tmp/fix-identity110.py

git fetch origin main
test "$(git rev-parse origin/main)" = 'afe6aa1950ae87c0fd21ec09ec98b0c11e1ff086'
git switch --detach origin/main
git switch -C agent/desktop-identity-110
git apply --check /tmp/desktop-identity-110.patch
git apply /tmp/desktop-identity-110.patch
python3 /tmp/fix-identity110.py

cargo +1.85.1 fmt --all
cargo +1.85.1 fmt --all -- --check
cargo +1.85.1 test -p greenways-identity --all-targets
cargo +1.85.1 test -p greenways-desktop-bridge --all-targets
cargo +1.85.1 clippy -p greenways-identity -p greenways-desktop-bridge --all-targets -- -D warnings

cd apps/greenways_desktop
flutter config --enable-macos-desktop
tool/build_macos.sh
cd ../..

git diff --check
cat > /tmp/expected-files <<'FILES'
apps/greenways_desktop/README.md
apps/greenways_desktop/lib/controller/setup_controller.dart
apps/greenways_desktop/lib/model/setup_snapshot.dart
apps/greenways_desktop/lib/model/setup_snapshot_validation.dart
apps/greenways_desktop/lib/services/desktop_bridge.dart
apps/greenways_desktop/lib/ui/setup_view.dart
apps/greenways_desktop/lib/ui/setup_view_components.dart
apps/greenways_desktop/test/desktop_shell_test.dart
apps/greenways_desktop/test/setup_controller_test.dart
apps/greenways_desktop/test/setup_snapshot_test.dart
apps/greenways_desktop/test/support/fakes.dart
crates/greenways-identity/src/lib.rs
protocol/desktop-setup.md
services/greenways-desktop-bridge/Cargo.toml
services/greenways-desktop-bridge/src/setup/host.rs
services/greenways-desktop-bridge/src/setup/inspect.rs
services/greenways-desktop-bridge/src/setup/mod.rs
services/greenways-desktop-bridge/src/setup/service.rs
services/greenways-desktop-bridge/src/setup/tests.rs
FILES
sort -o /tmp/expected-files /tmp/expected-files
xargs git add -N -- < /tmp/expected-files
git diff --name-only | sort > /tmp/actual-files
diff -u /tmp/expected-files /tmp/actual-files
test -z "$(git status --porcelain | grep '^??' || true)"

git config user.name greenways-os-ci
git config user.email actions@users.noreply.github.com
xargs git add -- < /tmp/expected-files
git diff --cached --name-only | sort > /tmp/staged-files
diff -u /tmp/expected-files /tmp/staged-files
git commit -m 'Create the initial public Greenways identity'
git push --force origin HEAD:refs/heads/agent/desktop-identity-110
git rev-parse HEAD

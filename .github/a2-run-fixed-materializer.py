#!/usr/bin/env python3
"""Run the reviewed A2 materializer against the current README contract."""

from __future__ import annotations

import ast
import base64
import re
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / ".github/a2-materialize-flow-foreman.py"

STALE_README = """> **Architecture direction:** Foreman is the first foreground Greenways
> application and is delivered through an invisible private personal Fabric.
> Greenways OS installs, verifies, updates, and launches Foreman through its
> cross-platform Fabric Server and Desktop, CLI, and browser application hosts.
> Person and provider identities are client-local; the server trusts only
> installed application/provider identities and host-signed capabilities. The
> previous workspace/Chats design remains useful historical evidence, but it is
> no longer the target product architecture."""

CURRENT_README = """> **Architecture direction:** Foreman is the first foreground Greenways
> application and is delivered through an invisible private personal Fabric.
> Greenways OS installs, verifies, updates, and launches Foreman through its
> cross-platform Fabric Server and Desktop, CLI, and browser application hosts.
> Person and AI-agent identity, permissions, storage, messaging, and application
> history remain private Fabric services. Public publication and multi-channel
> delivery belong to the separate Greenways Platform product. See
> [the Fabric architecture](docs/fabric-architecture.md)."""

STALE_REPLACEMENT = """> **Architecture direction:** Greenways Flow is the current foreground
> coordination application and is delivered through an invisible private
> personal Fabric. Greenways OS installs, verifies, updates, and launches Flow
> through its cross-platform Fabric Server and Desktop, CLI, and browser
> application hosts. Foreman remains Flow's internal coordination engine and
> durable domain implementation. Person and provider identities are client-local;
> the server trusts only installed application/provider identities and
> host-signed capabilities. The previous workspace/Chats design remains useful
> historical evidence, but it is no longer the target product architecture."""

CURRENT_REPLACEMENT = """> **Architecture direction:** Greenways Flow is the current foreground
> coordination application and is delivered through an invisible private
> personal Fabric. Greenways OS installs, verifies, updates, and launches Flow
> through its cross-platform Fabric Server and Desktop, CLI, and browser
> application hosts. Foreman remains Flow's internal coordination engine and
> durable domain implementation. Person and AI-agent identity, permissions,
> storage, messaging, and application history remain private Fabric services.
> Public publication and multi-channel delivery belong to the separate Greenways
> Platform product. See [the Fabric architecture](docs/fabric-architecture.md)."""


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    return source.replace(old, new, 1)


wrapper = WRAPPER.read_text(encoding="utf-8")
match = re.search(r"b85decode\((?P<literal>'(?:\\.|[^'])*')\)", wrapper, re.DOTALL)
if match is None:
    raise SystemExit("A2 materializer payload literal was not found")
payload = ast.literal_eval(match.group("literal"))
decoded = zlib.decompress(base64.b85decode(payload)).decode("utf-8")
decoded = replace_once(decoded, STALE_README, CURRENT_README, "current README input")
decoded = replace_once(
    decoded,
    STALE_REPLACEMENT,
    CURRENT_REPLACEMENT,
    "current README replacement",
)
compile(decoded, f"{WRAPPER}:decoded", "exec")
exec(
    compile(decoded, f"{WRAPPER}:decoded", "exec"),
    {"__file__": str(Path(__file__).resolve()), "__name__": "__main__"},
)

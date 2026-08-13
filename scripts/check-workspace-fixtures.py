#!/usr/bin/env python3
"""Verify the versioned workspace fixture set with the Python standard library."""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "protocol" / "fixtures"
MIGRATIONS = ROOT / "protocol" / "migrations"
MAGIC = b"HTA0"

NIL = 0
FALSE = 1
TRUE = 2
I64 = 3
STRING = 4
KEYWORD = 6
VECTOR = 9
MAP = 11


class FixtureError(RuntimeError):
    pass


def length(value: int) -> bytes:
    return struct.pack(">I", value)


def encode_value(value: Any) -> bytes:
    if value is None:
        return bytes([NIL])
    if value is False:
        return bytes([FALSE])
    if value is True:
        return bytes([TRUE])
    if isinstance(value, int):
        return bytes([I64]) + struct.pack(">q", value)
    if isinstance(value, str):
        raw = value.encode("utf-8")
        return bytes([STRING]) + length(len(raw)) + raw
    if isinstance(value, list):
        return bytes([VECTOR]) + length(len(value)) + b"".join(
            encode_value(item) for item in value
        )
    if isinstance(value, dict):
        entries: list[tuple[bytes, bytes]] = []
        for field, item in value.items():
            raw = field.encode("utf-8")
            encoded_field = bytes([KEYWORD]) + length(len(raw)) + raw
            entries.append((encoded_field, encode_value(item)))
        entries.sort(key=lambda entry: entry[0])
        return bytes([MAP]) + length(len(entries)) + b"".join(
            field + item for field, item in entries
        )
    raise FixtureError(f"unsupported fixture value: {type(value).__name__}")


def encode(value: Any) -> bytes:
    return MAGIC + encode_value(value)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def verify_vectors() -> tuple[int, int]:
    manifest = load("workspace-substrate-manifest.json")
    requests = load("workspace-substrate-requests.json")
    events = load("workspace-substrate-events.json")
    values = {**requests, **events}

    if manifest["protocol"] != "greenways.substrate.fixture/0-alpha":
        raise FixtureError("fixture protocol drift")
    if manifest["wire"] != {
        "protocol": "greenways-substrate/0-alpha",
        "length": "u32-big-endian",
        "requestMax": 65536,
        "serverMax": 262144,
    }:
        raise FixtureError("wire contract drift")

    expected_names = {entry[0] for entry in manifest["positive"]}
    if expected_names != set(values):
        raise FixtureError("fixture value set does not match the digest manifest")

    for name, payload_bytes, wire_bytes, payload_hash, wire_hash in manifest["positive"]:
        payload = encode(values[name])
        wire = length(len(payload)) + payload
        if len(payload) != payload_bytes:
            raise FixtureError(f"{name}: payload length drift")
        if len(wire) != wire_bytes:
            raise FixtureError(f"{name}: wire length drift")
        if digest(payload) != payload_hash:
            raise FixtureError(f"{name}: payload digest drift")
        if digest(wire) != wire_hash:
            raise FixtureError(f"{name}: wire digest drift")

    negative = manifest["negative"]
    if len({entry[0] for entry in negative}) != len(negative):
        raise FixtureError("duplicate negative fixture name")
    if len({entry[1] for entry in negative}) < 7:
        raise FixtureError("negative fixture classifications are incomplete")
    return len(values), len(negative)


def verify_cutover() -> None:
    path = MIGRATIONS / "chats-cutover-0-alpha.json"
    document = json.loads(path.read_text(encoding="utf-8"))
    states = [
        "legacy-writable",
        "prepared",
        "verified",
        "committed",
        "legacy-read-only",
    ]
    transitions = list(map(list, zip(states, states[1:])))
    if document["protocol"] != "greenways.chats.cutover/0-alpha":
        raise FixtureError("cutover protocol drift")
    if document["states"] != states or document["transitions"] != transitions:
        raise FixtureError("cutover state machine drift")
    if document["rollbackBeforeCommit"] != "legacy-writable":
        raise FixtureError("cutover rollback drift")
    if document["writableAfterCommit"] != "daemon-only":
        raise FixtureError("post-cutover writer drift")
    for phase in ("prepare", "verify", "commit"):
        values = document[phase]
        if not values or len(values) != len(set(values)):
            raise FixtureError(f"{phase}: invalid operation set")


def main() -> int:
    positive, negative = verify_vectors()
    verify_cutover()
    print(
        f"workspace fixtures verified: {positive} positive, "
        f"{negative} negative vectors and one cutover state machine"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FixtureError, KeyError, TypeError, ValueError) as error:
        print(f"workspace fixture verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)

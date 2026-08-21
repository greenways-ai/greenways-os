#!/usr/bin/env python3
"""Materialize the reviewed A2 Flow/Foreman compatibility proof."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE_REF = "refs/remotes/origin/a2-flow-compatibility-source"


def copy_from_source(source: str, target: str) -> None:
    output = subprocess.check_output(
        ["git", "show", f"{SOURCE_REF}:{source}"], cwd=ROOT
    )
    path = ROOT / target
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(output)


def replace_exact(path: str, old: str, new: str, count: int = 1) -> None:
    file = ROOT / path
    text = file.read_text(encoding="utf-8")
    actual = text.count(old)
    if actual != count:
        raise SystemExit(
            f"{path}: expected {count} occurrences of {old!r}, found {actual}"
        )
    file.write_text(text.replace(old, new), encoding="utf-8")


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def main() -> None:
    copies = {
        "crates/greenways-workspace-contracts/src/flow.rs":
            "crates/greenways-workspace-contracts/src/flow.rs",
        "crates/greenways-workspace-contracts/src/lib.rs":
            "crates/greenways-workspace-contracts/src/lib.rs",
        "crates/greenways-workspace-contracts/tests/fixtures/flow/flow-foreman-compatibility.json":
            "crates/greenways-workspace-contracts/tests/fixtures/flow/flow-foreman-compatibility.json",
        "crates/greenways-workspace-contracts/tests/flow_foreman_compatibility.rs":
            "crates/greenways-workspace-contracts/tests/flow_foreman_compatibility.rs",
        "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json":
            "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json",
        "scripts/check-flow-foreman-compatibility.py":
            "scripts/check-flow-build-foreman-inventory.py",
        "docs/flow-foreman-compatibility.md":
            "docs/flow-build-foreman-compatibility.md",
        ".github/workflows/flow-foreman-compatibility.yml":
            ".github/workflows/flow-build-foreman-compatibility.yml",
    }
    for source, target in copies.items():
        copy_from_source(source, target)

    replace_exact(
        "crates/greenways-workspace-contracts/src/suite.rs",
        "disposition: CompatibilityDisposition::InventoryRequired,",
        "disposition: CompatibilityDisposition::IncompatibleBlocked,",
    )
    replace_exact(
        "crates/greenways-workspace-contracts/tests/suite_gate0.rs",
        "CompatibilityDisposition::InventoryRequired",
        "CompatibilityDisposition::IncompatibleBlocked",
    )
    replace_exact(
        "crates/greenways-workspace-contracts/src/flow.rs",
        "CompatibilityDisposition::Absent,\n                false,",
        "CompatibilityDisposition::IncompatibleBlocked,\n                false,",
    )
    replace_exact(
        "crates/greenways-workspace-contracts/tests/flow_foreman_compatibility.rs",
        "CompatibilityDisposition::Absent",
        "CompatibilityDisposition::IncompatibleBlocked",
    )
    replace_exact(
        "crates/greenways-workspace-contracts/tests/flow_foreman_compatibility.rs",
        "fn build_is_absent_and_cannot_become_a_second_current_application()",
        "fn build_is_blocked_and_cannot_become_a_second_current_application()",
    )

    suite_path = ROOT / "crates/greenways-workspace-contracts/tests/fixtures/suite/current-suite.json"
    suite = json.loads(suite_path.read_text(encoding="utf-8"))
    applications = suite.get("applications")
    if (
        not isinstance(applications, list)
        or len(applications) != 2
        or applications[1].get("applicationId") != "flow"
    ):
        raise SystemExit("current suite fixture must contain exactly Spaces then Flow")
    slots = applications[1].get("compatibility")
    if (
        not isinstance(slots, list)
        or len(slots) != 1
        or slots[0].get("legacyApplicationId") != "build"
    ):
        raise SystemExit("Flow must contain exactly one legacy Build slot")
    slots[0]["disposition"] = "incompatible-blocked"
    write_json(suite_path, suite)

    flow_path = ROOT / "crates/greenways-workspace-contracts/tests/fixtures/flow/flow-foreman-compatibility.json"
    flow = json.loads(flow_path.read_text(encoding="utf-8"))
    rules = flow.get("compatibility")
    if not isinstance(rules, list) or not rules or rules[0].get("identity") != "build":
        raise SystemExit("Flow compatibility fixture must begin with legacy Build")
    rules[0]["disposition"] = "incompatible-blocked"
    write_json(flow_path, flow)

    inventory_path = ROOT / "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json"
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    resolution = inventory.get("buildResolution")
    if not isinstance(resolution, dict):
        raise SystemExit("inventory requires buildResolution")
    resolution.update(
        classification="incompatible-blocked",
        requestResult="incompatible",
        decision=(
            "The checked baseline contains no durable Build product identity. "
            "Legacy Build application requests are explicitly blocked; do not mint an alias, "
            "redirect, command family, record migration, or second logical project."
        ),
    )
    scan = inventory.get("scan")
    if not isinstance(scan, dict) or not isinstance(scan.get("excludedPaths"), list):
        raise SystemExit("inventory requires scan.excludedPaths")
    renames = {
        ".github/workflows/flow-foreman-compatibility.yml":
            ".github/workflows/flow-build-foreman-compatibility.yml",
        "docs/flow-foreman-compatibility.md":
            "docs/flow-build-foreman-compatibility.md",
        "scripts/check-flow-foreman-compatibility.py":
            "scripts/check-flow-build-foreman-inventory.py",
    }
    scan["excludedPaths"] = [renames.get(path, path) for path in scan["excludedPaths"]]
    write_json(inventory_path, inventory)

    checker = ROOT / "scripts/check-flow-build-foreman-inventory.py"
    text = checker.read_text(encoding="utf-8")
    replacements = {
        ".github/workflows/flow-foreman-compatibility.yml":
            ".github/workflows/flow-build-foreman-compatibility.yml",
        "docs/flow-foreman-compatibility.md":
            "docs/flow-build-foreman-compatibility.md",
        "scripts/check-flow-foreman-compatibility.py":
            "scripts/check-flow-build-foreman-inventory.py",
        '"classification": "absent",\n        "requestResult": "incompatible",':
            '"classification": "incompatible-blocked",\n        "requestResult": "incompatible",',
        '"disposition": "absent",\n        "discoverable": False,':
            '"disposition": "incompatible-blocked",\n        "discoverable": False,',
        'rules[0].get("disposition") != "absent"':
            'rules[0].get("disposition") != "incompatible-blocked"',
    }
    for old, new in replacements.items():
        if old not in text:
            raise SystemExit(f"checker replacement source missing: {old!r}")
        text = text.replace(old, new)
    text = text.replace(
        '"Flow/Foreman compatibility inventory verified: Build absent; "',
        '"Flow/Foreman compatibility inventory verified: legacy Build blocked; "',
    )
    checker.write_text(text, encoding="utf-8")
    checker.chmod(0o755)

    workflow = ROOT / ".github/workflows/flow-build-foreman-compatibility.yml"
    text = workflow.read_text(encoding="utf-8")
    text = text.replace(
        "name: Flow Foreman compatibility", "name: Flow Build Foreman compatibility"
    ).replace(
        "python3 scripts/check-flow-foreman-compatibility.py",
        "python3 scripts/check-flow-build-foreman-inventory.py",
    )
    workflow.write_text(text, encoding="utf-8")

    document = ROOT / "docs/flow-build-foreman-compatibility.md"
    text = document.read_text(encoding="utf-8")
    text = text.replace(
        "| Build application/package IDs | absent |",
        "| Legacy Build application target | incompatible / blocked |",
    ).replace(
        "It records all\nBuild categories as absent",
        "It records the legacy Build target as blocked and all searched\n"
        "Build product-identity categories as absent",
    ).replace(
        "python3 scripts/check-flow-foreman-compatibility.py",
        "python3 scripts/check-flow-build-foreman-inventory.py",
    )
    document.write_text(text, encoding="utf-8")

    for temporary in (
        ".github/workflows/a2-flow-foreman-inventory.yml",
        ".github/workflows/a2-flow-foreman-compatibility-proof.yml",
        ".github/workflows/a2-flow-proof-scope-format.yml",
        "scripts/materialize-a2-flow-compatibility-proof.py",
    ):
        path = ROOT / temporary
        if path.exists():
            path.unlink()


if __name__ == "__main__":
    main()

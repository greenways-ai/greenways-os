#!/usr/bin/env python3
"""Validate the closed Flow/Build/Foreman compatibility inventory."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INVENTORY_PATH = ROOT / "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json"
BASELINE_COMMIT = "80316806d3dac11031106aab8e6eb285b186b6ed"
BASELINE_TREE = "9e700a908302bb437460fe9a3f0b350b4ed81a8c"
PROTOCOL = "greenways.compatibility.flow-build-foreman-inventory/0-alpha"
ALLOWED_CLASSIFICATIONS = {
    "absent",
    "safe-display-alias",
    "versioned-compatibility-alias",
    "explicit-migration",
    "retained-technical-identity",
    "incompatible-blocked",
}
REQUIRED_DECISIONS = {
    "build-application-package-id": "incompatible-blocked",
    "build-route-deep-link": "absent",
    "build-cli-family": "absent",
    "build-operation-schema": "absent",
    "build-stored-surface-record": "absent",
    "build-handoff-application-id": "absent",
    "build-public-work-source-application": "absent",
    "build-visual-language-os-fixture": "absent",
    "foreman-product-copy": "safe-display-alias",
    "foreman-engine-domain": "retained-technical-identity",
    "project-work-buildout-runtime": "retained-technical-identity",
}
EXCLUDED_PATHS = {
    ".github/a2-materialize-flow-foreman.py",
    ".github/workflows/a2-flow-foreman-inventory.yml",
    "docs/flow-build-foreman-compatibility.md",
    "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json",
    "scripts/check-flow-build-foreman-inventory.py",
}
FOREMAN_RE = re.compile(r"(?i)\bforeman\b")
BUILDOUT_RE = re.compile(r"(?i)\bbuildouts?\b")
LEGACY_BUILD_FIXTURE_RE = re.compile(r'"legacyApplicationId"\s*:\s*"build"')
FORBIDDEN_PATTERNS = {
    "greenways-build-display": re.compile(r"\bGreenways Build\b"),
    "build-package": re.compile(r"(?i)\bgreenways/build\b"),
    "build-deep-link": re.compile(r"(?i)\bgreenways://build(?:/|\b)"),
    "build-route": re.compile(
        r"(?i)\b(?:routePrefix|href|to|route|deepLink|url)\b\s*[:=]\s*"
        r"[\"'`]/(?:applications/)?build(?:/|[?#\s\"'`]|$)"
    ),
    "build-cli": re.compile(r"(?i)\bgreenways\s+build(?:\s|$)"),
    "build-current-json-id": re.compile(
        r'"(?:applicationId|packageId|sourceApplicationId|targetApplicationId)"'
        r'\s*:\s*"build"'
    ),
    "build-operation": re.compile(r"[\"'`]build\.[a-z0-9_.-]+[\"'`]", re.I),
}


def fail(message: str) -> None:
    print(f"flow-build-foreman inventory check failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def tracked_paths() -> list[str]:
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    )
    return sorted(
        item.decode("utf-8")
        for item in output.split(b"\0")
        if item and item.decode("utf-8") not in EXCLUDED_PATHS
    )


def patterns_for(relative: str, line: str) -> tuple[str, ...]:
    patterns: list[str] = []
    if FOREMAN_RE.search(line):
        patterns.append("foreman-token")
    if BUILDOUT_RE.search(line):
        patterns.append("buildout-token")
    if "BUILD_APPLICATION_ID" in line:
        patterns.append("build-compatibility-symbol")
    if "LegacyApplicationId::Build" in line:
        patterns.append("build-compatibility-enum-use")
    if relative.endswith("crates/greenways-workspace-contracts/src/suite.rs") and line.strip() == "Build,":
        patterns.append("build-compatibility-enum-variant")
    if LEGACY_BUILD_FIXTURE_RE.search(line):
        patterns.append("build-compatibility-fixture")
    return tuple(sorted(set(patterns)))


def classification_for(patterns: tuple[str, ...]) -> str:
    if any(pattern.startswith("build-compatibility-") for pattern in patterns):
        return "incompatible-blocked"
    return "retained-technical-identity"


def reason_for(classification: str) -> str:
    if classification == "incompatible-blocked":
        return (
            "The legacy Build token is recognized only to fail explicitly; it is not a "
            "current application, alias, migration target, authority grant, or duplicate project."
        )
    return (
        "Foreman, project, work, and buildout vocabulary is retained only for the internal "
        "coordination engine, durable domain, compatibility evidence, tests, or diagnostics."
    )


def scan_findings() -> tuple[list[dict[str, object]], list[str], dict[str, int]]:
    aggregate: Counter[tuple[str, str, tuple[str, ...], str]] = Counter()
    forbidden: list[str] = []
    text_files = 0
    binary_files = 0

    for relative in tracked_paths():
        path = ROOT / relative
        if not path.is_file():
            continue
        raw = path.read_bytes()
        if b"\0" in raw:
            binary_files += 1
            continue
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            binary_files += 1
            continue
        text_files += 1
        for line_number, line in enumerate(text.splitlines(), start=1):
            for name, pattern in FORBIDDEN_PATTERNS.items():
                if pattern.search(line):
                    forbidden.append(f"{relative}:{line_number}: {name}: {line.strip()}")
            patterns = patterns_for(relative, line)
            if not patterns:
                continue
            classification = classification_for(patterns)
            aggregate[(relative, line.strip(), patterns, classification)] += 1

    findings = [
        {
            "path": path,
            "lineText": line_text,
            "patterns": list(patterns),
            "occurrences": occurrences,
            "classification": classification,
            "reason": reason_for(classification),
        }
        for (path, line_text, patterns, classification), occurrences in sorted(aggregate.items())
    ]
    return findings, forbidden, {
        "textFiles": text_files,
        "binaryFiles": binary_files,
        "findings": sum(item["occurrences"] for item in findings),
    }


def validate_inventory(inventory: dict[str, object]) -> None:
    if inventory.get("protocol") != PROTOCOL:
        fail("protocol is not canonical")
    baseline = inventory.get("baseline")
    if baseline != {"commit": BASELINE_COMMIT, "tree": BASELINE_TREE}:
        fail("baseline commit/tree is not the reviewed Gate 0 revision")

    current = inventory.get("currentExposure")
    expected_current = {
        "applications": ["spaces", "flow"],
        "coordinationApplication": "flow",
        "coordinationPackage": "greenways/flow",
        "coordinationDisplayName": "Greenways Flow",
        "coordinationLauncherLabel": "Flow",
        "coordinationRoutePrefix": "/flow/",
        "coordinationCliFamily": ["greenways", "flow"],
        "internalCoordinationService": "foreman",
        "futureUnactivated": ["imagine", "world"],
    }
    if current != expected_current:
        fail("current exposure does not describe exactly Spaces and Flow")

    decisions = inventory.get("decisions")
    if not isinstance(decisions, list):
        fail("decisions must be a list")
    by_surface: dict[str, str] = {}
    for decision in decisions:
        if not isinstance(decision, dict):
            fail("decision entries must be objects")
        surface = decision.get("surface")
        classification = decision.get("classification")
        reason = decision.get("reason")
        if not isinstance(surface, str) or not surface:
            fail("decision surface is invalid")
        if surface in by_surface:
            fail(f"duplicate decision surface: {surface}")
        if classification not in ALLOWED_CLASSIFICATIONS:
            fail(f"invalid classification for {surface}: {classification}")
        if not isinstance(reason, str) or len(reason.strip()) < 24:
            fail(f"decision reason is missing or too short: {surface}")
        by_surface[surface] = classification
    if by_surface != REQUIRED_DECISIONS:
        fail(f"decision table mismatch: expected {REQUIRED_DECISIONS}, got {by_surface}")

    declared = inventory.get("findings")
    if not isinstance(declared, list):
        fail("findings must be a list")
    for finding in declared:
        if not isinstance(finding, dict):
            fail("finding entries must be objects")
        if finding.get("classification") not in {
            "retained-technical-identity",
            "incompatible-blocked",
        }:
            fail(f"invalid finding classification: {finding}")
        if not isinstance(finding.get("reason"), str) or len(finding["reason"].strip()) < 24:
            fail(f"finding reason is missing or too short: {finding}")


def validate_suite_fixture() -> None:
    path = ROOT / "crates/greenways-workspace-contracts/tests/fixtures/suite/current-suite.json"
    fixture = json.loads(path.read_text(encoding="utf-8"))
    applications = fixture.get("applications")
    if not isinstance(applications, list):
        fail("current-suite applications are not a list")
    ids = [application.get("applicationId") for application in applications]
    if ids != ["spaces", "flow"]:
        fail(f"current-suite applications are not exactly spaces/flow: {ids}")
    flow = applications[1]
    if flow.get("package") != {"id": "greenways/flow", "revision": "0.1.0"}:
        fail("Flow package metadata is not canonical")
    if flow.get("displayName") != "Greenways Flow" or flow.get("launcherLabel") != "Flow":
        fail("Flow product display metadata is not canonical")
    if flow.get("routePrefix") != "/flow/" or flow.get("cliFamily") != ["greenways", "flow"]:
        fail("Flow route or CLI family is not canonical")
    compatibility = flow.get("compatibility")
    expected = [{
        "legacyApplicationId": "build",
        "targetApplicationId": "flow",
        "disposition": "incompatible-blocked",
        "discoverable": False,
        "grantsAuthority": False,
    }]
    if compatibility != expected:
        fail(f"Build compatibility is not explicitly blocked: {compatibility}")


def main() -> None:
    try:
        inventory = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read inventory: {error}")

    validate_inventory(inventory)
    validate_suite_fixture()
    actual, forbidden, counts = scan_findings()
    if forbidden:
        fail("forbidden current Build identity found:\n" + "\n".join(forbidden))
    declared = inventory["findings"]
    if declared != actual:
        declared_json = json.dumps(declared, indent=2, ensure_ascii=False)
        actual_json = json.dumps(actual, indent=2, ensure_ascii=False)
        fail(f"closed findings drifted\nDECLARED:\n{declared_json}\nACTUAL:\n{actual_json}")

    print(
        "Flow/Build/Foreman compatibility inventory is closed: "
        f"{counts['findings']} findings across {counts['textFiles']} UTF-8 files; "
        "Build is incompatible-blocked and Foreman/buildout identities are technical only."
    )


if __name__ == "__main__":
    main()

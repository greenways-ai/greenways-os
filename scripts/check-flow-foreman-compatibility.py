#!/usr/bin/env python3
"""Verify the pinned Flow, Build, and Foreman compatibility inventory."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
INVENTORY_PATH = (
    ROOT / "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json"
)
SUITE_FIXTURE_PATH = (
    ROOT
    / "crates/greenways-workspace-contracts/tests/fixtures/suite/current-suite.json"
)
FLOW_FIXTURE_PATH = (
    ROOT
    / "crates/greenways-workspace-contracts/tests/fixtures/flow/flow-foreman-compatibility.json"
)

EXPECTED_PROTOCOL = "greenways.flow.build-foreman-compatibility-inventory/0-alpha"
EXPECTED_BASELINE = {
    "repository": "greenways-ai/greenways-os",
    "branch": "main",
    "commit": "80316806d3dac11031106aab8e6eb285b186b6ed",
    "tree": "9e700a908302bb437460fe9a3f0b350b4ed81a8c",
}
EXPECTED_CLASSIFICATIONS = [
    "absent",
    "safe-display-alias",
    "versioned-compatibility-alias",
    "explicit-migration",
    "retained-technical-identity",
    "incompatible-blocked",
]
EXPECTED_BUILD_CATEGORIES = [
    "application-package-ids",
    "operations-schemas-protocols-record-kinds",
    "routes-deep-links",
    "cli-commands",
    "surface-activity-records",
    "handoff-application-ids",
    "public-work-source-application",
    "visual-language-routes-fixtures",
]
EXPECTED_COMPATIBILITY = {
    "Foreman": ("display-label", "safe-display-alias"),
    "foreman": ("service-identity", "retained-technical-identity"),
    "foreman.*": ("technical-namespace", "retained-technical-identity"),
    "project/*": ("durable-record-family", "retained-technical-identity"),
    "work/*": ("durable-record-family", "retained-technical-identity"),
    "buildout/*": ("durable-record-family", "retained-technical-identity"),
}
EXPECTED_FOREMAN_COUNTS = {
    "README.md": 2,
    "docs/fabric-architecture.md": 53,
    "docs/fabric-technology-map.md": 22,
    "docs/workspace-architecture.md": 4,
}
EXPECTED_BUILDOUT_COUNTS = {"docs/fabric-architecture.md": 10}
EXPECTED_EXCLUDED_PATHS = {
    ".github/workflows/flow-foreman-compatibility.yml",
    "crates/greenways-workspace-contracts/src/flow.rs",
    "crates/greenways-workspace-contracts/src/suite.rs",
    "crates/greenways-workspace-contracts/tests/fixtures/flow/flow-foreman-compatibility.json",
    "crates/greenways-workspace-contracts/tests/fixtures/suite/current-suite.json",
    "crates/greenways-workspace-contracts/tests/flow_foreman_compatibility.rs",
    "crates/greenways-workspace-contracts/tests/suite_gate0.rs",
    "docs/flow-foreman-compatibility.md",
    "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json",
    "scripts/check-flow-foreman-compatibility.py",
}

FOREMAN_WORD = re.compile(r"(?i)\bforeman\b")
BUILDOUT_WORD = re.compile(r"(?i)\bbuildouts?\b")
FOREMAN_NAMESPACE = re.compile(r"(?i)\bforeman\.[a-z0-9_.-]+")
BUILDOUT_PREFIX = re.compile(r"(?i)\bbuildout/[a-z0-9_.-]+")
STRONG_BUILD_PATTERNS = (
    re.compile(r"\bGreenways Build\b"),
    re.compile(r"(?i)\bgreenways/build\b"),
    re.compile(r"(?i)\bgreenways\s+build(?:\s|$)"),
    re.compile(r"(?i)greenways://build\b"),
    re.compile(r'''["']/build/["']'''),
    re.compile(r'''["']/v2/applications/build(?:/|["'])'''),
    re.compile(
        r'''(?i)(?:application(?:[-_ ]?id)?|package(?:[-_ ]?id)?|'''
        r'''source[-_ ]?application|target[-_ ]?application)\s*[:=]\s*["']build["']'''
    ),
    re.compile(r'''(?i)["']build\.[a-z0-9_.-]+'''),
    re.compile(
        r'''(?i)(?:href|route|path|deep[-_ ]?link)\s*[:=]\s*["']/build/'''
    ),
)


def fail(message: str) -> None:
    raise SystemExit(f"flow-foreman compatibility check failed: {message}")


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {path.relative_to(ROOT)}: {error}")
    if not isinstance(value, dict):
        fail(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        fail(f"{label} keys differ: expected {sorted(expected)}, found {sorted(actual)}")


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def verify_inventory(value: dict[str, Any]) -> set[str]:
    require_exact_keys(
        value,
        {
            "protocol",
            "baseline",
            "classifications",
            "buildResolution",
            "buildCategories",
            "compatibility",
            "scan",
        },
        "inventory",
    )
    if value["protocol"] != EXPECTED_PROTOCOL:
        fail("inventory protocol changed")
    if value["baseline"] != EXPECTED_BASELINE:
        fail("baseline commit or tree changed without a reviewed inventory revision")
    if value["classifications"] != EXPECTED_CLASSIFICATIONS:
        fail("classification vocabulary changed")

    resolution = value["buildResolution"]
    require_exact_keys(
        resolution,
        {
            "legacyApplicationId",
            "targetApplicationId",
            "classification",
            "requestResult",
            "discoverable",
            "grantsAuthority",
            "createsParallelRecord",
            "decision",
        },
        "build resolution",
    )
    if resolution != {
        **resolution,
        "legacyApplicationId": "build",
        "targetApplicationId": "flow",
        "classification": "absent",
        "requestResult": "incompatible",
        "discoverable": False,
        "grantsAuthority": False,
        "createsParallelRecord": False,
    }:
        fail("Build must remain absent, incompatible, non-discoverable, and non-authoritative")
    if not isinstance(resolution["decision"], str) or not resolution["decision"].strip():
        fail("Build resolution requires a decision")

    categories = value["buildCategories"]
    if not isinstance(categories, list) or [item.get("id") for item in categories] != EXPECTED_BUILD_CATEGORIES:
        fail("Build category inventory is incomplete or reordered")
    for item in categories:
        require_exact_keys(item, {"id", "classification", "decision"}, "Build category")
        if item["classification"] != "absent" or not str(item["decision"]).strip():
            fail(f"Build category {item['id']} must be explicitly absent with a decision")

    compatibility = value["compatibility"]
    if not isinstance(compatibility, list):
        fail("compatibility must be a list")
    actual_compatibility: dict[str, tuple[str, str]] = {}
    for item in compatibility:
        require_exact_keys(
            item,
            {
                "identity",
                "kind",
                "classification",
                "currentOwner",
                "accepted",
                "discoverable",
                "productFacing",
                "grantsAuthority",
                "rewriteDurableIdentity",
                "createsParallelRecord",
                "decision",
            },
            "compatibility entry",
        )
        identity = item["identity"]
        actual_compatibility[identity] = (item["kind"], item["classification"])
        if item["currentOwner"] != "flow" or item["accepted"] is not True:
            fail(f"{identity} must be accepted only under Flow ownership")
        if any(
            item[field] is not False
            for field in (
                "discoverable",
                "productFacing",
                "grantsAuthority",
                "rewriteDurableIdentity",
                "createsParallelRecord",
            )
        ):
            fail(f"{identity} cannot advertise, transfer authority, rewrite, or duplicate records")
        if not isinstance(item["decision"], str) or not item["decision"].strip():
            fail(f"{identity} requires a compatibility decision")
    if actual_compatibility != EXPECTED_COMPATIBILITY:
        fail("Foreman and durable identity compatibility entries differ from the closed table")

    scan = value["scan"]
    require_exact_keys(
        scan,
        {
            "trackedFilesOnly",
            "binaryPolicy",
            "strongBuildIdentityCount",
            "foremanNamespaceCount",
            "buildoutPrefixCount",
            "foremanTokenCounts",
            "buildoutTokenCounts",
            "excludedPaths",
        },
        "scan",
    )
    if scan["trackedFilesOnly"] is not True or scan["binaryPolicy"] != "skip-nul-or-invalid-utf8":
        fail("scan policy changed")
    if scan["strongBuildIdentityCount"] != 0:
        fail("inventory must expect no merged Build product identities")
    if scan["foremanNamespaceCount"] != 0 or scan["buildoutPrefixCount"] != 0:
        fail("baseline technical namespace counts changed")
    if scan["foremanTokenCounts"] != EXPECTED_FOREMAN_COUNTS:
        fail("recorded Foreman prose counts changed")
    if scan["buildoutTokenCounts"] != EXPECTED_BUILDOUT_COUNTS:
        fail("recorded buildout prose counts changed")

    excluded = set(scan["excludedPaths"])
    if excluded != EXPECTED_EXCLUDED_PATHS:
        fail("scanner exclusions changed without updating the closed checker")
    return excluded


def verify_baseline() -> None:
    commit = EXPECTED_BASELINE["commit"]
    ancestor = git("merge-base", "--is-ancestor", commit, "HEAD", check=False)
    if ancestor.returncode != 0:
        fail(f"baseline {commit} is not an ancestor of HEAD")
    tree = git("rev-parse", f"{commit}^{{tree}}").stdout.strip()
    if tree != EXPECTED_BASELINE["tree"]:
        fail("baseline commit no longer resolves to the recorded tree")


def tracked_text_files(excluded: set[str]) -> list[tuple[str, str]]:
    raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    files: list[tuple[str, str]] = []
    for encoded in raw.split(b"\0"):
        if not encoded:
            continue
        relative = encoded.decode("utf-8")
        if relative in excluded:
            continue
        path = ROOT / relative
        if not path.is_file():
            continue
        content = path.read_bytes()
        if b"\0" in content:
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        files.append((relative, text))
    return files


def verify_repository_scan(excluded: set[str]) -> None:
    foreman_counts: Counter[str] = Counter()
    buildout_counts: Counter[str] = Counter()
    strong_build_findings: list[str] = []
    foreman_namespace_findings: list[str] = []
    buildout_prefix_findings: list[str] = []

    for relative, text in tracked_text_files(excluded):
        foreman_count = len(FOREMAN_WORD.findall(text))
        buildout_count = len(BUILDOUT_WORD.findall(text))
        if foreman_count:
            foreman_counts[relative] = foreman_count
        if buildout_count:
            buildout_counts[relative] = buildout_count

        for number, line in enumerate(text.splitlines(), start=1):
            if any(pattern.search(line) for pattern in STRONG_BUILD_PATTERNS):
                strong_build_findings.append(f"{relative}:{number}: {line.strip()}")
            if FOREMAN_NAMESPACE.search(line):
                foreman_namespace_findings.append(f"{relative}:{number}: {line.strip()}")
            if BUILDOUT_PREFIX.search(line):
                buildout_prefix_findings.append(f"{relative}:{number}: {line.strip()}")

    if dict(foreman_counts) != EXPECTED_FOREMAN_COUNTS:
        fail(
            "Foreman prose drifted; expected "
            f"{EXPECTED_FOREMAN_COUNTS}, found {dict(foreman_counts)}"
        )
    if dict(buildout_counts) != EXPECTED_BUILDOUT_COUNTS:
        fail(
            "buildout prose drifted; expected "
            f"{EXPECTED_BUILDOUT_COUNTS}, found {dict(buildout_counts)}"
        )
    if strong_build_findings:
        fail("unexpected Build product identity:\n" + "\n".join(strong_build_findings))
    if foreman_namespace_findings:
        fail("unreviewed foreman.* identity:\n" + "\n".join(foreman_namespace_findings))
    if buildout_prefix_findings:
        fail("unreviewed buildout/* identity:\n" + "\n".join(buildout_prefix_findings))


def verify_contract_fixtures() -> None:
    suite = load_json(SUITE_FIXTURE_PATH)
    applications = suite.get("applications")
    if not isinstance(applications, list):
        fail("current suite fixture has no application list")
    if [application.get("applicationId") for application in applications] != ["spaces", "flow"]:
        fail("current suite must contain exactly Spaces and Flow")
    flow = applications[1]
    compatibility = flow.get("compatibility")
    if not isinstance(compatibility, list) or len(compatibility) != 1:
        fail("Flow requires exactly one Build compatibility slot")
    slot = compatibility[0]
    if slot != {
        "legacyApplicationId": "build",
        "targetApplicationId": "flow",
        "disposition": "absent",
        "discoverable": False,
        "grantsAuthority": False,
    }:
        fail("current suite Build compatibility slot is not the closed absent result")

    fixture = load_json(FLOW_FIXTURE_PATH)
    if fixture.get("protocol") != "greenways.flow.foreman-compatibility/0-alpha":
        fail("Flow compatibility fixture protocol changed")
    product = fixture.get("product", {})
    if product.get("applicationId") != "flow" or product.get("packageId") != "greenways/flow":
        fail("Flow compatibility fixture has the wrong product identity")
    service = fixture.get("service", {})
    if service.get("serviceId") != "foreman" or any(
        service.get(field) is not False
        for field in ("productFacing", "discoverable", "grantsApplicationAuthority")
    ):
        fail("Foreman service must remain internal, non-discoverable, and non-authoritative")
    aggregate = fixture.get("aggregate", {})
    if (
        aggregate.get("aggregateRootKind") != "project"
        or aggregate.get("buildoutRequired") is not False
        or aggregate.get("crossProjectImplicitMove") is not False
    ):
        fail("Project must remain the root and buildout must remain optional")
    rules = fixture.get("compatibility")
    if not isinstance(rules, list) or [item.get("identity") for item in rules] != [
        "build",
        "Foreman",
        "foreman",
        "foreman.*",
        "project/*",
        "work/*",
        "buildout/*",
    ]:
        fail("Flow compatibility fixture rule order changed")
    if rules[0].get("disposition") != "absent" or rules[0].get("accepted") is not False:
        fail("Build cannot be accepted as an application alias")
    for rule in rules:
        if any(
            rule.get(field) is not False
            for field in (
                "discoverable",
                "productFacing",
                "rewriteDurableIdentity",
                "createsParallelRecord",
            )
        ):
            fail(f"fixture rule {rule.get('identity')} exposes or rewrites compatibility")
    serialized = json.dumps(fixture, sort_keys=True).lower()
    if "imagine" in serialized or "world" in serialized:
        fail("future applications cannot enter the current Flow compatibility fixture")


def main() -> None:
    inventory = load_json(INVENTORY_PATH)
    excluded = verify_inventory(inventory)
    verify_baseline()
    verify_repository_scan(excluded)
    verify_contract_fixtures()
    print(
        "Flow/Foreman compatibility inventory verified: Build absent; "
        "Foreman display-only at the product boundary; technical identities retained."
    )


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)

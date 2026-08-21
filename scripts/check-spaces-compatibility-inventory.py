#!/usr/bin/env python3
"""Verify the baseline inventory of merged Greenways Research identities."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
INVENTORY_PATH = (
    ROOT / "protocol" / "compatibility" / "spaces-research-inventory-0-alpha.json"
)

PROTOCOL = "greenways.spaces.research-compatibility-inventory/0-alpha"
BASELINE_REPOSITORY = "greenways-ai/greenways-os"
CLASSIFICATIONS = {
    "absent",
    "safe display alias",
    "versioned compatibility alias",
    "explicit migration",
    "retained technical identity",
    "incompatible / blocked",
}
CATEGORY_IDS = {
    "application-package-ids",
    "operations-schemas-record-kinds",
    "routes-deep-links",
    "cli-commands",
    "stored-project-space-records",
    "surface-activity-records",
    "handoff-application-ids",
    "public-work-source-application",
}
SELF_EXCLUDED_PATHS = {
    ".github/workflows/spaces-compatibility-inventory.yml",
    "docs/spaces-compatibility-inventory.md",
    "protocol/compatibility/spaces-research-inventory-0-alpha.json",
    "scripts/check-spaces-compatibility-inventory.py",
}


class InventoryError(RuntimeError):
    pass


@dataclass(frozen=True)
class ActualFinding:
    path: str
    line_number: int
    line_text: str
    pattern: str
    category: str | None
    occurrences: int

    @property
    def key(self) -> tuple[str, str, str, int]:
        return (self.path, self.line_text, self.pattern, self.occurrences)


CONTEXT_PATTERNS: tuple[tuple[str, str, re.Pattern[str]], ...] = (
    (
        "operations-schemas-record-kinds",
        "operation-schema-record",
        re.compile(
            r"(?i)(?:\bresearch\.[a-z0-9_.-]+|\bresearch/[a-z0-9_.-]+|"
            r"\bresearch[-_. ](?:operation|schema|record|kind|event)\b)"
        ),
    ),
    (
        "cli-commands",
        "cli-command",
        re.compile(r"(?i)\bgreenways\s+research(?:\s|$)"),
    ),
    (
        "routes-deep-links",
        "route-deep-link",
        re.compile(
            r"(?i)(?:greenways://research\b|"
            r"(?:^|[^a-z0-9])/(?:applications/)?research(?:/|[?#'\"\s]|$)|"
            r"\b(?:route|deep[-_ ]?link)[^\n]{0,80}\bresearch\b)"
        ),
    ),
    (
        "public-work-source-application",
        "public-work-source-application",
        re.compile(
            r"(?i)(?:\bpublic[-_ ]?work[^\n]{0,100}\bresearch\b|"
            r"\bsource[-_ ]?application[^\n]{0,100}\bresearch\b|"
            r"\bresearch\b[^\n]{0,100}\bsource[-_ ]?application\b)"
        ),
    ),
    (
        "handoff-application-ids",
        "handoff-application-id",
        re.compile(
            r"(?i)(?:\bhandoff[^\n]{0,100}\bresearch\b|"
            r"\bresearch\b[^\n]{0,100}\bhandoff\b|"
            r"\b(?:source|target)[-_ ]?application[^\n]{0,80}\bresearch\b)"
        ),
    ),
    (
        "stored-project-space-records",
        "stored-project-space-record",
        re.compile(
            r"(?i)(?:\bresearch[-_. ](?:project|space)\b|"
            r"\b(?:project|space)[-_. ]research\b|"
            r"\bstored[^\n]{0,80}\bresearch\b)"
        ),
    ),
    (
        "application-package-ids",
        "application-package-id",
        re.compile(
            r"(?i)(?:\bgreenways/research\b|"
            r"\bresearch[-_. ](?:application|package)\b|"
            r"\b(?:application|package)[-_./: ]research\b|"
            r"\b(?:application|package)[-_ ]?id[^\n]{0,80}[\"': ]research\b)"
        ),
    ),
    (
        "surface-activity-records",
        "surface-activity-record",
        re.compile(
            r"(?:\bGreenways Research\b|"
            r"(?i:\b(?:launcher|recent|search|notification|activity)[^\n]{0,100}\bresearch\b)|"
            r"(?i:\bresearch\b[^\n]{0,100}\b(?:launcher|recent|search|notification|activity)\b))"
        ),
    ),
)
RESEARCH_WORD = re.compile(r"(?i)\bresearch\b")


def load_inventory() -> dict[str, Any]:
    try:
        value = json.loads(INVENTORY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise InventoryError(f"cannot load inventory: {error}") from error
    if not isinstance(value, dict):
        raise InventoryError("inventory root must be an object")
    return value


def validate_inventory(value: dict[str, Any]) -> None:
    expected_keys = {
        "protocol",
        "baseline",
        "classifications",
        "categories",
        "scan",
        "findings",
    }
    if set(value) != expected_keys:
        raise InventoryError(
            f"inventory keys drift: expected {sorted(expected_keys)}, got {sorted(value)}"
        )
    if value["protocol"] != PROTOCOL:
        raise InventoryError("inventory protocol drift")
    if set(value["classifications"]) != CLASSIFICATIONS:
        raise InventoryError("compatibility classification vocabulary drift")

    baseline = value["baseline"]
    if set(baseline) != {"repository", "branch", "commit", "tree"}:
        raise InventoryError("baseline fields drift")
    if baseline["repository"] != BASELINE_REPOSITORY or baseline["branch"] != "main":
        raise InventoryError("inventory must be based on greenways-ai/greenways-os main")
    for field in ("commit", "tree"):
        if not re.fullmatch(r"[0-9a-f]{40}", baseline[field]):
            raise InventoryError(f"baseline {field} must be a full lowercase SHA")

    categories = value["categories"]
    if not isinstance(categories, list) or len(categories) != len(CATEGORY_IDS):
        raise InventoryError("inventory must contain each compatibility category once")
    seen_categories: set[str] = set()
    for category in categories:
        if set(category) != {"id", "classification", "decision", "evidence"}:
            raise InventoryError("category fields drift")
        category_id = category["id"]
        if category_id not in CATEGORY_IDS or category_id in seen_categories:
            raise InventoryError(f"invalid or duplicate category: {category_id}")
        seen_categories.add(category_id)
        if category["classification"] not in CLASSIFICATIONS:
            raise InventoryError(f"invalid classification for {category_id}")
        if not category["decision"] or not category["evidence"]:
            raise InventoryError(f"category {category_id} needs decision and evidence")
    if seen_categories != CATEGORY_IDS:
        raise InventoryError("compatibility category set drift")

    scan = value["scan"]
    if set(scan) != {
        "term",
        "caseSensitive",
        "trackedFilesOnly",
        "binaryPolicy",
        "excludedPaths",
    }:
        raise InventoryError("scan policy fields drift")
    if scan["term"] != "research" or scan["caseSensitive"] is not False:
        raise InventoryError("scan must review every case-insensitive research token")
    if scan["trackedFilesOnly"] is not True:
        raise InventoryError("scan must be bounded to tracked repository files")
    if scan["binaryPolicy"] != "skip files containing NUL or invalid UTF-8":
        raise InventoryError("binary scan policy drift")
    if set(scan["excludedPaths"]) != SELF_EXCLUDED_PATHS:
        raise InventoryError("self-exclusion set drift")

    findings = value["findings"]
    if not isinstance(findings, list):
        raise InventoryError("findings must be a list")
    seen_findings: set[tuple[str, str, str, int]] = set()
    for finding in findings:
        if set(finding) != {
            "path",
            "lineText",
            "pattern",
            "category",
            "occurrences",
            "kind",
            "classification",
            "reason",
        }:
            raise InventoryError("finding fields drift")
        key = (
            finding["path"],
            finding["lineText"],
            finding["pattern"],
            finding["occurrences"],
        )
        if key in seen_findings:
            raise InventoryError(f"duplicate declared finding: {key}")
        seen_findings.add(key)
        if not finding["path"] or not finding["lineText"] or not finding["reason"]:
            raise InventoryError("finding path, lineText, and reason are required")
        if not isinstance(finding["occurrences"], int) or finding["occurrences"] < 1:
            raise InventoryError("finding occurrences must be a positive integer")
        if finding["kind"] == "generic-prose":
            if finding["category"] is not None or finding["classification"] is not None:
                raise InventoryError("generic prose cannot carry an identity classification")
        elif finding["kind"] == "legacy-identity":
            if finding["category"] not in CATEGORY_IDS:
                raise InventoryError("legacy identity needs a compatibility category")
            if finding["classification"] not in CLASSIFICATIONS - {"absent"}:
                raise InventoryError("merged legacy identity cannot be classified absent")
        else:
            raise InventoryError(f"invalid finding kind: {finding['kind']}")


def tracked_paths() -> list[str]:
    try:
        raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT)
    except (OSError, subprocess.CalledProcessError) as error:
        raise InventoryError(f"cannot enumerate tracked files: {error}") from error
    return [item.decode("utf-8") for item in raw.split(b"\0") if item]


def classify_line(line: str) -> tuple[str, str | None]:
    for category, pattern_id, pattern in CONTEXT_PATTERNS:
        if pattern.search(line):
            return pattern_id, category
    return "generic-prose", None


def scan_repository(excluded_paths: set[str]) -> tuple[list[ActualFinding], int, int, int]:
    findings: list[ActualFinding] = []
    text_files = 0
    binary_files = 0
    non_file_entries = 0

    for relative_path in tracked_paths():
        if relative_path in excluded_paths:
            continue
        path = ROOT / relative_path
        if not path.is_file():
            non_file_entries += 1
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
            matches = RESEARCH_WORD.findall(line)
            if not matches:
                continue
            pattern_id, category = classify_line(line)
            findings.append(
                ActualFinding(
                    path=relative_path,
                    line_number=line_number,
                    line_text=line.strip(),
                    pattern=pattern_id,
                    category=category,
                    occurrences=len(matches),
                )
            )

    return findings, text_files, binary_files, non_file_entries


def expected_findings(value: dict[str, Any]) -> dict[tuple[str, str, str, int], dict[str, Any]]:
    return {
        (
            finding["path"],
            finding["lineText"],
            finding["pattern"],
            finding["occurrences"],
        ): finding
        for finding in value["findings"]
    }


def verify_findings(value: dict[str, Any], actual: list[ActualFinding]) -> None:
    expected = expected_findings(value)
    actual_by_key = {finding.key: finding for finding in actual}
    if len(actual_by_key) != len(actual):
        duplicates = Counter(finding.key for finding in actual)
        repeated = [key for key, count in duplicates.items() if count > 1]
        raise InventoryError(f"ambiguous duplicate scan findings: {repeated}")

    unexpected = [finding for finding in actual if finding.key not in expected]
    missing = [key for key in expected if key not in actual_by_key]
    mismatched: list[str] = []
    for key, declared in expected.items():
        observed = actual_by_key.get(key)
        if observed is None:
            continue
        if declared["pattern"] == "generic-prose":
            if declared["kind"] != "generic-prose" or declared["category"] is not None:
                mismatched.append(f"{declared['path']}: generic prose disposition drift")
        else:
            if declared["kind"] != "legacy-identity":
                mismatched.append(f"{declared['path']}: legacy identity kind drift")
            if declared["category"] != observed.category:
                mismatched.append(
                    f"{declared['path']}: declared {declared['category']}, "
                    f"observed {observed.category}"
                )

    if unexpected or missing or mismatched:
        messages = ["tracked Research-token inventory is not closed"]
        if unexpected:
            messages.append("unexpected findings:")
            for finding in unexpected[:200]:
                messages.append(
                    f"  {finding.path}:{finding.line_number} "
                    f"[{finding.pattern}/{finding.category or 'non-identity'}] "
                    f"x{finding.occurrences}: {finding.line_text[:300]}"
                )
            if len(unexpected) > 200:
                messages.append(f"  ... {len(unexpected) - 200} more")
        if missing:
            messages.append("declared findings no longer present:")
            messages.extend(f"  {key}" for key in missing[:200])
        if mismatched:
            messages.append("classification mismatches:")
            messages.extend(f"  {message}" for message in mismatched)
        raise InventoryError("\n".join(messages))

    categories = {category["id"]: category for category in value["categories"]}
    legacy_by_category: Counter[str] = Counter(
        finding["category"]
        for finding in value["findings"]
        if finding["kind"] == "legacy-identity"
    )
    for category_id, category in categories.items():
        count = legacy_by_category[category_id]
        if category["classification"] == "absent" and count:
            raise InventoryError(
                f"category {category_id} is absent but has {count} legacy findings"
            )
        if category["classification"] != "absent" and not count:
            raise InventoryError(
                f"category {category_id} is {category['classification']} without evidence"
            )


def verify_baseline_is_ancestor(value: dict[str, Any]) -> None:
    baseline = value["baseline"]["commit"]
    result = subprocess.run(
        ["git", "merge-base", "--is-ancestor", baseline, "HEAD"],
        cwd=ROOT,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode == 1:
        raise InventoryError(f"baseline {baseline} is not an ancestor of HEAD")
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit {result.returncode}"
        raise InventoryError(f"cannot verify baseline ancestry: {detail}")


def main() -> int:
    inventory = load_inventory()
    validate_inventory(inventory)
    verify_baseline_is_ancestor(inventory)
    findings, text_files, binary_files, non_file_entries = scan_repository(
        set(inventory["scan"]["excludedPaths"])
    )
    verify_findings(inventory, findings)
    legacy_count = sum(
        finding["kind"] == "legacy-identity" for finding in inventory["findings"]
    )
    prose_count = sum(
        finding["kind"] == "generic-prose" for finding in inventory["findings"]
    )
    print(
        "Spaces compatibility inventory verified: "
        f"{text_files} text files scanned, {binary_files} binary files skipped, "
        f"{non_file_entries} non-file entries skipped, "
        f"{legacy_count} legacy identities classified, "
        f"{prose_count} generic prose findings reviewed"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (InventoryError, KeyError, TypeError, ValueError) as error:
        print(f"Spaces compatibility inventory verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)

#!/usr/bin/env python3
from __future__ import annotations

import json
import runpy
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPERS = [
    ROOT / ".github/a3-materialize-flow-project.py",
    ROOT / ".github/workflows/a3-flow-project-materializer.yml",
]


def first_reference(value: object, application_id: str) -> dict[str, object] | None:
    if isinstance(value, dict):
        if (
            value.get("protocol") == "greenways.reference/0-alpha"
            and value.get("applicationId") == application_id
        ):
            return value
        for child in value.values():
            found = first_reference(child, application_id)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = first_reference(child, application_id)
            if found is not None:
                return found
    return None


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def operation(
    operation_id: str,
    scope: str,
    intent: str,
    requires_project_id: bool,
    requires_entity_id: bool,
    requires_expected_revision: bool,
    idempotency: str,
    result_kind: str,
) -> dict[str, object]:
    return {
        "protocol": "greenways.flow.operation/0-alpha",
        "operationId": operation_id,
        "applicationId": "flow",
        "applicationRevision": "0.1.0",
        "scope": scope,
        "intent": intent,
        "requiresProjectId": requires_project_id,
        "requiresEntityId": requires_entity_id,
        "requiresExpectedRevision": requires_expected_revision,
        "idempotency": idempotency,
        "resultKind": result_kind,
        "grantsApplicationAuthority": False,
    }


def main() -> None:
    lib = ROOT / "crates/greenways-workspace-contracts/src/lib.rs"
    source = lib.read_text(encoding="utf-8")
    if "mod flow;\n" not in source:
        source = source.replace("mod error;\n", "mod error;\nmod flow;\n")
    if "pub use flow::*;\n" not in source:
        source = source.replace("pub use error::{", "pub use flow::*;\npub use error::{")
    lib.write_text(source, encoding="utf-8")

    suite_fixtures = ROOT / "crates/greenways-workspace-contracts/tests/fixtures/suite"
    spaces_fixture = json.loads(
        (suite_fixtures / "spaces-question-to-flow.json").read_text(encoding="utf-8")
    )
    flow_fixture = json.loads(
        (suite_fixtures / "flow-result-to-spaces.json").read_text(encoding="utf-8")
    )
    spaces_reference = first_reference(spaces_fixture, "spaces")
    flow_reference = first_reference(flow_fixture, "flow")
    if spaces_reference is None or flow_reference is None:
        raise SystemExit("canonical shared-reference fixtures are missing")

    fixture_root = ROOT / "crates/greenways-workspace-contracts/tests/fixtures/flow"
    direct_project = {
        "protocol": "greenways.flow.project/0-alpha",
        "applicationId": "flow",
        "applicationRevision": "0.1.0",
        "projectId": "project/flow-direct-work",
        "revision": 3,
        "title": "Prepare the current suite release proof",
        "summary": "A Flow project with direct work and no optional buildout grouping.",
        "state": "active",
        "createdAtUnixMs": 1787270400000,
        "updatedAtUnixMs": 1787274000000,
        "sourceReferences": [spaces_reference],
        "evidenceReferences": [],
        "work": [
            {
                "protocol": "greenways.flow.work-reference/0-alpha",
                "applicationId": "flow",
                "applicationRevision": "0.1.0",
                "projectId": "project/flow-direct-work",
                "workId": "work/flow-direct-001",
                "revision": 2,
                "title": "Assemble exact release evidence",
                "summary": "Collect current-suite fixtures, checks, and immutable revision evidence.",
                "state": "ready",
                "buildoutId": None,
                "exactRoot": None,
            }
        ],
        "buildouts": [],
    }

    buildout_id = "buildout/flow-control-room"
    grouped_project = {
        "protocol": "greenways.flow.project/0-alpha",
        "applicationId": "flow",
        "applicationRevision": "0.1.0",
        "projectId": "project/flow-control-room",
        "revision": 7,
        "title": "Flow Project Control Room foundation",
        "summary": "A Flow project whose related work is grouped by one optional buildout.",
        "state": "active",
        "createdAtUnixMs": 1787270400000,
        "updatedAtUnixMs": 1787277600000,
        "sourceReferences": [spaces_reference],
        "evidenceReferences": [flow_reference],
        "work": [
            {
                "protocol": "greenways.flow.work-reference/0-alpha",
                "applicationId": "flow",
                "applicationRevision": "0.1.0",
                "projectId": "project/flow-control-room",
                "workId": "work/flow-control-room-model",
                "revision": 4,
                "title": "Freeze the project read model",
                "summary": "Define the bounded project, work, buildout, and evidence composition.",
                "state": "completed",
                "buildoutId": buildout_id,
                "exactRoot": "sha256:" + "1" * 64,
            },
            {
                "protocol": "greenways.flow.work-reference/0-alpha",
                "applicationId": "flow",
                "applicationRevision": "0.1.0",
                "projectId": "project/flow-control-room",
                "workId": "work/flow-control-room-actions",
                "revision": 2,
                "title": "Specify truthful management actions",
                "summary": "Keep later approve, resume, handoff, and record-opening actions evidence-backed.",
                "state": "running",
                "buildoutId": buildout_id,
                "exactRoot": None,
            },
        ],
        "buildouts": [
            {
                "protocol": "greenways.flow.buildout-reference/0-alpha",
                "applicationId": "flow",
                "applicationRevision": "0.1.0",
                "projectId": "project/flow-control-room",
                "buildoutId": buildout_id,
                "revision": 3,
                "title": "Control Room contract buildout",
                "summary": "Optional grouping for the current Project Control Room contract work.",
                "state": "active",
                "workIds": [
                    "work/flow-control-room-model",
                    "work/flow-control-room-actions",
                ],
                "exactRoot": None,
            }
        ],
    }

    operations = [
        operation("flow.project.list", "project-collection", "read", False, False, False, "none", "project-page"),
        operation("flow.project.get", "project", "read", True, False, False, "none", "project"),
        operation("flow.project.create", "project-collection", "manage", False, False, False, "exact-request", "project"),
        operation("flow.project.update", "project", "manage", True, False, True, "exact-request", "project"),
        operation("flow.project.transition", "project", "manage", True, False, True, "exact-request", "project"),
        operation("flow.work.list", "work", "read", True, False, False, "none", "work-page"),
        operation("flow.work.get", "work", "read", True, True, False, "none", "work"),
        operation("flow.work.create", "work", "manage", True, False, True, "exact-request", "work"),
        operation("flow.work.update", "work", "manage", True, True, True, "exact-request", "work"),
        operation("flow.work.transition", "work", "manage", True, True, True, "exact-request", "work"),
        operation("flow.buildout.list", "buildout", "read", True, False, False, "none", "buildout-page"),
        operation("flow.buildout.get", "buildout", "read", True, True, False, "none", "buildout"),
        operation("flow.buildout.create", "buildout", "manage", True, False, True, "exact-request", "buildout"),
        operation("flow.buildout.update", "buildout", "manage", True, True, True, "exact-request", "buildout"),
        operation("flow.buildout.transition", "buildout", "manage", True, True, True, "exact-request", "buildout"),
    ]
    catalogue = {
        "protocol": "greenways.flow.operation-catalogue/0-alpha",
        "applicationId": "flow",
        "applicationRevision": "0.1.0",
        "operations": operations,
    }

    write_json(fixture_root / "project-direct-work.json", direct_project)
    write_json(fixture_root / "project-buildout.json", grouped_project)
    write_json(fixture_root / "operation-catalogue.json", catalogue)

    for helper in HELPERS:
        helper.unlink(missing_ok=True)

    checker_path = ROOT / "scripts/check-flow-build-foreman-inventory.py"
    checker = runpy.run_path(str(checker_path))
    findings, forbidden, counts = checker["scan_findings"]()
    if forbidden:
        raise SystemExit("forbidden Build identity found:\n" + "\n".join(forbidden))
    inventory_path = ROOT / "protocol/compatibility/flow-build-foreman-inventory-0-alpha.json"
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    inventory["findings"] = findings
    inventory["reviewedThrough"] = {
        "slice": "agent-1-a3-flow-project-contract",
        "baseCommit": subprocess.check_output(
            ["git", "merge-base", "HEAD", "origin/main"], cwd=ROOT, text=True
        ).strip(),
        "trackedUtf8Files": counts["textFiles"],
        "closedFindings": counts["findings"],
    }
    write_json(inventory_path, inventory)


if __name__ == "__main__":
    main()

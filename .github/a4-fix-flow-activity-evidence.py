#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SELF = Path(__file__).resolve()
RETRY_WORKFLOW = ROOT / ".github/workflows/a4-flow-activity-evidence-retry.yml"
ERROR_LOG = ROOT / ".github/a4-flow-activity-evidence-error.log"


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    source = path.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one match, found {count}")
    path.write_text(source.replace(old, new, 1), encoding="utf-8")


module = ROOT / "crates/greenways-workspace-contracts/src/flow_activity_evidence.rs"
source = module.read_text(encoding="utf-8")
source = source.replace("const MAX_INTERVENTION_ID_BYTES: usize = 256;\n", "")

presence_source = (
    ROOT / "crates/greenways-workspace-contracts/src/flow_presence.rs"
).read_text(encoding="utf-8")
session_types = [
    name
    for name, body in re.findall(
        r"pub struct ([A-Za-z0-9_]+)\s*\{(.*?)\n\}",
        presence_source,
        flags=re.DOTALL,
    )
    if "pub session_id:" in body and "pub presence_state:" in body
]
if len(session_types) != 1:
    raise SystemExit(f"expected one session presence struct, found {session_types}")
source = source.replace(
    "crate::flow_presence::FlowProjectSessionBinding",
    f"crate::flow_presence::{session_types[0]}",
)
module.write_text(source, encoding="utf-8")

tests = ROOT / "crates/greenways-workspace-contracts/tests/flow_activity_evidence.rs"
replace_once(
    tests,
    """    snapshot.activity.remove(3);
    snapshot.activity[3].sequence = 4;
    snapshot.activity[3].causal_predecessor_activity_id =
        Some("activity/flow-readback-observed".to_owned());
""",
    """    snapshot.activity.retain(|entry| {
        !matches!(
            entry.kind,
            greenways_workspace_contracts::FlowProjectActivityKind::ExternalReadbackObserved
                | greenways_workspace_contracts::FlowProjectActivityKind::ExternalEffectVerified
        )
    });
    snapshot.activity[2].sequence = 3;
    snapshot.activity[2].causal_predecessor_activity_id =
        Some("activity/flow-artifact-selected".to_owned());
""",
    "Provider acceptance activity truthfulness",
)

for fixture_path in [
    ROOT
    / "crates/greenways-workspace-contracts/tests/fixtures/flow/project-activity-evidence.json",
    ROOT
    / "crates/greenways-workspace-contracts/tests/fixtures/flow/project-activity-evidence-restart.json",
]:
    value = json.loads(fixture_path.read_text(encoding="utf-8"))

    def verify_digests(node: object, path: str = "$") -> None:
        if isinstance(node, dict):
            for key, child in node.items():
                verify_digests(child, f"{path}.{key}")
        elif isinstance(node, list):
            for index, child in enumerate(node):
                verify_digests(child, f"{path}[{index}]")
        elif isinstance(node, str) and node.startswith("sha256:"):
            suffix = node.removeprefix("sha256:")
            if len(suffix) != 64 or any(character not in "0123456789abcdef" for character in suffix):
                raise SystemExit(f"invalid digest at {fixture_path}:{path}: {node}")

    verify_digests(value)

for helper in [ERROR_LOG, RETRY_WORKFLOW, SELF]:
    subprocess.run(
        ["git", "rm", "--ignore-unmatch", str(helper.relative_to(ROOT))],
        cwd=ROOT,
        check=True,
    )

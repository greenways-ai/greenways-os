use crate::error::ContractError;
use crate::flow::{
    flow_operation_catalogue, FlowBuildoutState, FlowIdempotencyLaw, FlowOperationId,
    FlowOperationIntent, FlowOperationScope, FlowProjectSnapshot, FlowProjectState, FlowWorkState,
};
use crate::suite::{CurrentApplicationId, CURRENT_SUITE_REVISION};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const FLOW_PROJECT_CONTROL_ROOM_PROTOCOL: &str =
    "greenways.flow.project-control-room/0-alpha";
pub const FLOW_CONTROL_ROOM_ACTION_PROTOCOL: &str =
    "greenways.flow.project-control-room-action/0-alpha";

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_WORK_ID_BYTES: usize = 256;
const MAX_BUILDOUT_ID_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 160;
const MAX_SUMMARY_BYTES: usize = 400;
const MAX_CONTROL_ROOM_WORK: usize = 512;
const MAX_CONTROL_ROOM_BUILDOUTS: usize = 128;
const MAX_CONTROL_ROOM_ATTENTION: usize = 512;
const MAX_CONTROL_ROOM_ACTIONS: usize = 16;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControlRoomSelectionKind {
    Project,
    Work,
    Buildout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomSelection {
    pub kind: FlowControlRoomSelectionKind,
    pub entity_id: Option<String>,
}

impl FlowControlRoomSelection {
    pub fn project() -> Self {
        Self {
            kind: FlowControlRoomSelectionKind::Project,
            entity_id: None,
        }
    }

    pub fn work(work_id: impl Into<String>) -> Self {
        Self {
            kind: FlowControlRoomSelectionKind::Work,
            entity_id: Some(work_id.into()),
        }
    }

    pub fn buildout(buildout_id: impl Into<String>) -> Self {
        Self {
            kind: FlowControlRoomSelectionKind::Buildout,
            entity_id: Some(buildout_id.into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomProjectHeader {
    pub project_id: String,
    pub project_revision: u64,
    pub title: String,
    pub summary: Option<String>,
    pub state: FlowProjectState,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomReferenceCounts {
    pub source_references: usize,
    pub evidence_references: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomSummary {
    pub work_total: usize,
    pub direct_work: usize,
    pub grouped_work: usize,
    pub buildout_total: usize,
    pub planned_work: usize,
    pub ready_work: usize,
    pub running_work: usize,
    pub blocked_work: usize,
    pub review_work: usize,
    pub completed_work: usize,
    pub cancelled_work: usize,
    pub failed_work: usize,
    pub source_references: usize,
    pub evidence_references: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomWorkCard {
    pub work_id: String,
    pub revision: u64,
    pub title: String,
    pub summary: Option<String>,
    pub state: FlowWorkState,
    pub buildout_id: Option<String>,
    pub exact_root: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomBuildoutLane {
    pub buildout_id: String,
    pub revision: u64,
    pub title: String,
    pub summary: Option<String>,
    pub state: FlowBuildoutState,
    pub exact_root: Option<String>,
    pub work: Vec<FlowControlRoomWorkCard>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControlRoomAttentionKind {
    ProjectPaused,
    ProjectReview,
    WorkBlocked,
    WorkReview,
    WorkFailed,
    BuildoutBlocked,
    BuildoutReview,
    BuildoutFailed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControlRoomAttentionSeverity {
    Informational,
    ActionRequired,
    Critical,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControlRoomTargetKind {
    Project,
    Work,
    Buildout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomAttentionItem {
    pub kind: FlowControlRoomAttentionKind,
    pub severity: FlowControlRoomAttentionSeverity,
    pub target_kind: FlowControlRoomTargetKind,
    pub target_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControlRoomActionAvailability {
    Available,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControlRoomDisabledReason {
    TerminalProject,
    TerminalWork,
    TerminalBuildout,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowControlRoomRevisionSubject {
    Project,
    Work,
    Buildout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomExpectedRevision {
    pub subject: FlowControlRoomRevisionSubject,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowControlRoomAction {
    pub protocol: String,
    pub operation_id: FlowOperationId,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: Option<String>,
    pub entity_id: Option<String>,
    pub expected_revision: Option<FlowControlRoomExpectedRevision>,
    pub availability: FlowControlRoomActionAvailability,
    pub disabled_reason: Option<FlowControlRoomDisabledReason>,
    pub grants_application_authority: bool,
}

impl FlowControlRoomAction {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol != FLOW_CONTROL_ROOM_ACTION_PROTOCOL {
            return Err(ContractError::new(
                "flow-control-room-action-protocol-mismatch",
                "Flow Control Room action uses an unsupported protocol",
            ));
        }
        require_flow_application(self.application_id, &self.application_revision)?;
        if self.grants_application_authority {
            return Err(ContractError::new(
                "flow-control-room-authority-transfer",
                "Flow Control Room actions never grant application authority",
            ));
        }

        let catalogue = flow_operation_catalogue();
        let descriptor = catalogue
            .operations
            .iter()
            .find(|candidate| candidate.operation_id == self.operation_id)
            .ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-control-room-operation",
                    "Flow Control Room action is not in the current operation catalogue",
                )
            })?;

        if !is_control_room_operation(self.operation_id) {
            return Err(ContractError::new(
                "unsupported-flow-control-room-operation",
                "Flow operation is not exposed by the current Control Room",
            ));
        }
        if descriptor.grants_application_authority {
            return Err(ContractError::new(
                "flow-control-room-operation-authority",
                "Current Flow operation catalogue cannot grant application authority",
            ));
        }
        if descriptor.requires_project_id != self.project_id.is_some() {
            return Err(ContractError::new(
                "flow-control-room-project-context-mismatch",
                "Flow Control Room action project context does not match its operation",
            ));
        }
        if descriptor.requires_entity_id != self.entity_id.is_some() {
            return Err(ContractError::new(
                "flow-control-room-entity-context-mismatch",
                "Flow Control Room action entity context does not match its operation",
            ));
        }
        if descriptor.requires_expected_revision != self.expected_revision.is_some() {
            return Err(ContractError::new(
                "flow-control-room-revision-context-mismatch",
                "Flow Control Room action revision fence does not match its operation",
            ));
        }
        if descriptor.intent == FlowOperationIntent::Read
            && self.availability != FlowControlRoomActionAvailability::Available
        {
            return Err(ContractError::new(
                "disabled-flow-control-room-read",
                "Flow Control Room read operations remain available for terminal records",
            ));
        }
        if self.availability == FlowControlRoomActionAvailability::Available
            && self.disabled_reason.is_some()
        {
            return Err(ContractError::new(
                "unexpected-flow-control-room-disabled-reason",
                "Available Flow Control Room action cannot include a disabled reason",
            ));
        }
        if self.availability == FlowControlRoomActionAvailability::Disabled
            && self.disabled_reason.is_none()
        {
            return Err(ContractError::new(
                "missing-flow-control-room-disabled-reason",
                "Disabled Flow Control Room action requires an explicit reason",
            ));
        }

        if let Some(project_id) = &self.project_id {
            validate_scoped_identifier(
                project_id,
                "project/",
                MAX_PROJECT_ID_BYTES,
                "invalid-flow-control-room-project-id",
            )?;
        }
        if let Some(entity_id) = &self.entity_id {
            let (prefix, maximum, code) = match descriptor.scope {
                FlowOperationScope::Work => (
                    "work/",
                    MAX_WORK_ID_BYTES,
                    "invalid-flow-control-room-work-id",
                ),
                FlowOperationScope::Buildout => (
                    "buildout/",
                    MAX_BUILDOUT_ID_BYTES,
                    "invalid-flow-control-room-buildout-id",
                ),
                _ => {
                    return Err(ContractError::new(
                        "unexpected-flow-control-room-entity-id",
                        "Flow Control Room entity ID is not valid for this operation scope",
                    ));
                }
            };
            validate_scoped_identifier(entity_id, prefix, maximum, code)?;
        }
        if let Some(expected_revision) = &self.expected_revision {
            if expected_revision.revision == 0 {
                return Err(ContractError::new(
                    "invalid-flow-control-room-expected-revision",
                    "Flow Control Room expected revision must be positive",
                ));
            }
            if expected_revision.subject != revision_subject(self.operation_id)? {
                return Err(ContractError::new(
                    "flow-control-room-revision-subject-mismatch",
                    "Flow Control Room expected revision is fenced to the wrong record",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectControlRoom {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project: FlowControlRoomProjectHeader,
    pub selection: FlowControlRoomSelection,
    pub references: FlowControlRoomReferenceCounts,
    pub summary: FlowControlRoomSummary,
    pub direct_work: Vec<FlowControlRoomWorkCard>,
    pub buildouts: Vec<FlowControlRoomBuildoutLane>,
    pub attention: Vec<FlowControlRoomAttentionItem>,
    pub actions: Vec<FlowControlRoomAction>,
}

impl FlowProjectControlRoom {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol != FLOW_PROJECT_CONTROL_ROOM_PROTOCOL {
            return Err(ContractError::new(
                "flow-control-room-protocol-mismatch",
                "Flow Project Control Room uses an unsupported protocol",
            ));
        }
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_project_header(&self.project)?;
        if self.direct_work.len() > MAX_CONTROL_ROOM_WORK
            || self.buildouts.len() > MAX_CONTROL_ROOM_BUILDOUTS
            || self.attention.len() > MAX_CONTROL_ROOM_ATTENTION
            || self.actions.len() > MAX_CONTROL_ROOM_ACTIONS
        {
            return Err(ContractError::new(
                "flow-control-room-bound-exceeded",
                "Flow Project Control Room collection exceeds its contract bound",
            ));
        }

        let mut work_ids = BTreeSet::new();
        for work in &self.direct_work {
            validate_work_card(work)?;
            if work.buildout_id.is_some() {
                return Err(ContractError::new(
                    "grouped-work-in-direct-flow-lane",
                    "Direct Flow Control Room work cannot carry a buildout identity",
                ));
            }
            if !work_ids.insert(work.work_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-control-room-work",
                    "Flow Control Room work identities must be unique",
                ));
            }
        }

        let mut buildout_ids = BTreeSet::new();
        for buildout in &self.buildouts {
            validate_buildout_lane(buildout)?;
            if !buildout_ids.insert(buildout.buildout_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-control-room-buildout",
                    "Flow Control Room buildout identities must be unique",
                ));
            }
            for work in &buildout.work {
                if work.buildout_id.as_deref() != Some(buildout.buildout_id.as_str()) {
                    return Err(ContractError::new(
                        "flow-control-room-buildout-membership-mismatch",
                        "Flow Control Room grouped work must name its owning buildout",
                    ));
                }
                if !work_ids.insert(work.work_id.as_str()) {
                    return Err(ContractError::new(
                        "duplicate-flow-control-room-work",
                        "Flow Control Room work cannot appear in more than one lane",
                    ));
                }
            }
        }

        validate_selection(self)?;
        if self.summary != summarize_room(self) {
            return Err(ContractError::new(
                "flow-control-room-summary-mismatch",
                "Flow Control Room summary does not match its visible records",
            ));
        }
        if self.attention != attention_for_room(self) {
            return Err(ContractError::new(
                "flow-control-room-attention-mismatch",
                "Flow Control Room attention does not match its visible record states",
            ));
        }
        for action in &self.actions {
            action.validate()?;
        }
        if self.actions != actions_for_room(self)? {
            return Err(ContractError::new(
                "flow-control-room-actions-mismatch",
                "Flow Control Room actions do not match selection, state, and revision fences",
            ));
        }
        Ok(())
    }
}

pub fn flow_project_control_room(
    project: &FlowProjectSnapshot,
    selection: FlowControlRoomSelection,
) -> Result<FlowProjectControlRoom, ContractError> {
    project.validate()?;
    validate_snapshot_selection(project, &selection)?;

    let direct_work = project
        .work
        .iter()
        .filter(|work| work.buildout_id.is_none())
        .map(|work| FlowControlRoomWorkCard {
            work_id: work.work_id.clone(),
            revision: work.revision,
            title: work.title.clone(),
            summary: work.summary.clone(),
            state: work.state,
            buildout_id: None,
            exact_root: work.exact_root.clone(),
        })
        .collect::<Vec<_>>();

    let mut buildouts = Vec::with_capacity(project.buildouts.len());
    for buildout in &project.buildouts {
        let mut work = Vec::with_capacity(buildout.work_ids.len());
        for work_id in &buildout.work_ids {
            let source = project
                .work
                .iter()
                .find(|candidate| candidate.work_id == *work_id)
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-control-room-buildout-work",
                        "Flow Control Room buildout references work outside the project",
                    )
                })?;
            work.push(FlowControlRoomWorkCard {
                work_id: source.work_id.clone(),
                revision: source.revision,
                title: source.title.clone(),
                summary: source.summary.clone(),
                state: source.state,
                buildout_id: source.buildout_id.clone(),
                exact_root: source.exact_root.clone(),
            });
        }
        buildouts.push(FlowControlRoomBuildoutLane {
            buildout_id: buildout.buildout_id.clone(),
            revision: buildout.revision,
            title: buildout.title.clone(),
            summary: buildout.summary.clone(),
            state: buildout.state,
            exact_root: buildout.exact_root.clone(),
            work,
        });
    }

    let mut room = FlowProjectControlRoom {
        protocol: FLOW_PROJECT_CONTROL_ROOM_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        project: FlowControlRoomProjectHeader {
            project_id: project.project_id.clone(),
            project_revision: project.revision,
            title: project.title.clone(),
            summary: project.summary.clone(),
            state: project.state,
            created_at_unix_ms: project.created_at_unix_ms,
            updated_at_unix_ms: project.updated_at_unix_ms,
        },
        selection,
        references: FlowControlRoomReferenceCounts {
            source_references: project.source_references.len(),
            evidence_references: project.evidence_references.len(),
        },
        summary: FlowControlRoomSummary {
            work_total: 0,
            direct_work: 0,
            grouped_work: 0,
            buildout_total: 0,
            planned_work: 0,
            ready_work: 0,
            running_work: 0,
            blocked_work: 0,
            review_work: 0,
            completed_work: 0,
            cancelled_work: 0,
            failed_work: 0,
            source_references: 0,
            evidence_references: 0,
        },
        direct_work,
        buildouts,
        attention: Vec::new(),
        actions: Vec::new(),
    };
    room.summary = summarize_room(&room);
    room.attention = attention_for_room(&room);
    room.actions = actions_for_room(&room)?;
    room.validate()?;
    Ok(room)
}

fn summarize_room(room: &FlowProjectControlRoom) -> FlowControlRoomSummary {
    let work = room
        .direct_work
        .iter()
        .chain(room.buildouts.iter().flat_map(|buildout| buildout.work.iter()))
        .collect::<Vec<_>>();
    FlowControlRoomSummary {
        work_total: work.len(),
        direct_work: room.direct_work.len(),
        grouped_work: work.len().saturating_sub(room.direct_work.len()),
        buildout_total: room.buildouts.len(),
        planned_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Planned)
            .count(),
        ready_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Ready)
            .count(),
        running_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Running)
            .count(),
        blocked_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Blocked)
            .count(),
        review_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Review)
            .count(),
        completed_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Completed)
            .count(),
        cancelled_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Cancelled)
            .count(),
        failed_work: work
            .iter()
            .filter(|item| item.state == FlowWorkState::Failed)
            .count(),
        source_references: room.references.source_references,
        evidence_references: room.references.evidence_references,
    }
}

fn attention_for_room(room: &FlowProjectControlRoom) -> Vec<FlowControlRoomAttentionItem> {
    let mut attention = Vec::new();
    match room.project.state {
        FlowProjectState::Paused => attention.push(FlowControlRoomAttentionItem {
            kind: FlowControlRoomAttentionKind::ProjectPaused,
            severity: FlowControlRoomAttentionSeverity::ActionRequired,
            target_kind: FlowControlRoomTargetKind::Project,
            target_id: room.project.project_id.clone(),
            title: room.project.title.clone(),
        }),
        FlowProjectState::Review => attention.push(FlowControlRoomAttentionItem {
            kind: FlowControlRoomAttentionKind::ProjectReview,
            severity: FlowControlRoomAttentionSeverity::Informational,
            target_kind: FlowControlRoomTargetKind::Project,
            target_id: room.project.project_id.clone(),
            title: room.project.title.clone(),
        }),
        _ => {}
    }

    for work in room
        .direct_work
        .iter()
        .chain(room.buildouts.iter().flat_map(|buildout| buildout.work.iter()))
    {
        let (kind, severity) = match work.state {
            FlowWorkState::Failed => (
                FlowControlRoomAttentionKind::WorkFailed,
                FlowControlRoomAttentionSeverity::Critical,
            ),
            FlowWorkState::Blocked => (
                FlowControlRoomAttentionKind::WorkBlocked,
                FlowControlRoomAttentionSeverity::ActionRequired,
            ),
            FlowWorkState::Review => (
                FlowControlRoomAttentionKind::WorkReview,
                FlowControlRoomAttentionSeverity::Informational,
            ),
            _ => continue,
        };
        attention.push(FlowControlRoomAttentionItem {
            kind,
            severity,
            target_kind: FlowControlRoomTargetKind::Work,
            target_id: work.work_id.clone(),
            title: work.title.clone(),
        });
    }

    for buildout in &room.buildouts {
        let (kind, severity) = match buildout.state {
            FlowBuildoutState::Failed => (
                FlowControlRoomAttentionKind::BuildoutFailed,
                FlowControlRoomAttentionSeverity::Critical,
            ),
            FlowBuildoutState::Blocked => (
                FlowControlRoomAttentionKind::BuildoutBlocked,
                FlowControlRoomAttentionSeverity::ActionRequired,
            ),
            FlowBuildoutState::Review => (
                FlowControlRoomAttentionKind::BuildoutReview,
                FlowControlRoomAttentionSeverity::Informational,
            ),
            _ => continue,
        };
        attention.push(FlowControlRoomAttentionItem {
            kind,
            severity,
            target_kind: FlowControlRoomTargetKind::Buildout,
            target_id: buildout.buildout_id.clone(),
            title: buildout.title.clone(),
        });
    }
    attention
}

fn actions_for_room(
    room: &FlowProjectControlRoom,
) -> Result<Vec<FlowControlRoomAction>, ContractError> {
    let project_terminal = matches!(
        room.project.state,
        FlowProjectState::Completed | FlowProjectState::Cancelled
    );
    let project_availability = if project_terminal {
        FlowControlRoomActionAvailability::Disabled
    } else {
        FlowControlRoomActionAvailability::Available
    };
    let project_reason = project_terminal.then_some(FlowControlRoomDisabledReason::TerminalProject);

    let mut actions = vec![
        action(
            FlowOperationId::ProjectList,
            None,
            None,
            None,
            FlowControlRoomActionAvailability::Available,
            None,
        ),
        action(
            FlowOperationId::ProjectGet,
            Some(room.project.project_id.clone()),
            None,
            None,
            FlowControlRoomActionAvailability::Available,
            None,
        ),
        action(
            FlowOperationId::ProjectUpdate,
            Some(room.project.project_id.clone()),
            None,
            Some(FlowControlRoomExpectedRevision {
                subject: FlowControlRoomRevisionSubject::Project,
                revision: room.project.project_revision,
            }),
            project_availability,
            project_reason,
        ),
        action(
            FlowOperationId::ProjectTransition,
            Some(room.project.project_id.clone()),
            None,
            Some(FlowControlRoomExpectedRevision {
                subject: FlowControlRoomRevisionSubject::Project,
                revision: room.project.project_revision,
            }),
            project_availability,
            project_reason,
        ),
        action(
            FlowOperationId::WorkCreate,
            Some(room.project.project_id.clone()),
            None,
            Some(FlowControlRoomExpectedRevision {
                subject: FlowControlRoomRevisionSubject::Project,
                revision: room.project.project_revision,
            }),
            project_availability,
            project_reason,
        ),
        action(
            FlowOperationId::BuildoutCreate,
            Some(room.project.project_id.clone()),
            None,
            Some(FlowControlRoomExpectedRevision {
                subject: FlowControlRoomRevisionSubject::Project,
                revision: room.project.project_revision,
            }),
            project_availability,
            project_reason,
        ),
    ];

    match room.selection.kind {
        FlowControlRoomSelectionKind::Project => {}
        FlowControlRoomSelectionKind::Work => {
            let work_id = room.selection.entity_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "missing-flow-control-room-work-selection",
                    "Flow Control Room work selection requires a work identity",
                )
            })?;
            let work = room
                .direct_work
                .iter()
                .chain(room.buildouts.iter().flat_map(|buildout| buildout.work.iter()))
                .find(|candidate| candidate.work_id == work_id)
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-control-room-work-selection",
                        "Selected Flow work does not exist in the Control Room",
                    )
                })?;
            let terminal = matches!(
                work.state,
                FlowWorkState::Completed | FlowWorkState::Cancelled | FlowWorkState::Failed
            );
            let availability = if terminal {
                FlowControlRoomActionAvailability::Disabled
            } else {
                FlowControlRoomActionAvailability::Available
            };
            let reason = terminal.then_some(FlowControlRoomDisabledReason::TerminalWork);
            actions.extend([
                action(
                    FlowOperationId::WorkGet,
                    Some(room.project.project_id.clone()),
                    Some(work.work_id.clone()),
                    None,
                    FlowControlRoomActionAvailability::Available,
                    None,
                ),
                action(
                    FlowOperationId::WorkUpdate,
                    Some(room.project.project_id.clone()),
                    Some(work.work_id.clone()),
                    Some(FlowControlRoomExpectedRevision {
                        subject: FlowControlRoomRevisionSubject::Work,
                        revision: work.revision,
                    }),
                    availability,
                    reason,
                ),
                action(
                    FlowOperationId::WorkTransition,
                    Some(room.project.project_id.clone()),
                    Some(work.work_id.clone()),
                    Some(FlowControlRoomExpectedRevision {
                        subject: FlowControlRoomRevisionSubject::Work,
                        revision: work.revision,
                    }),
                    availability,
                    reason,
                ),
            ]);
        }
        FlowControlRoomSelectionKind::Buildout => {
            let buildout_id = room.selection.entity_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "missing-flow-control-room-buildout-selection",
                    "Flow Control Room buildout selection requires a buildout identity",
                )
            })?;
            let buildout = room
                .buildouts
                .iter()
                .find(|candidate| candidate.buildout_id == buildout_id)
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-control-room-buildout-selection",
                        "Selected Flow buildout does not exist in the Control Room",
                    )
                })?;
            let terminal = matches!(
                buildout.state,
                FlowBuildoutState::Completed
                    | FlowBuildoutState::Cancelled
                    | FlowBuildoutState::Failed
            );
            let availability = if terminal {
                FlowControlRoomActionAvailability::Disabled
            } else {
                FlowControlRoomActionAvailability::Available
            };
            let reason = terminal.then_some(FlowControlRoomDisabledReason::TerminalBuildout);
            actions.extend([
                action(
                    FlowOperationId::BuildoutGet,
                    Some(room.project.project_id.clone()),
                    Some(buildout.buildout_id.clone()),
                    None,
                    FlowControlRoomActionAvailability::Available,
                    None,
                ),
                action(
                    FlowOperationId::BuildoutUpdate,
                    Some(room.project.project_id.clone()),
                    Some(buildout.buildout_id.clone()),
                    Some(FlowControlRoomExpectedRevision {
                        subject: FlowControlRoomRevisionSubject::Buildout,
                        revision: buildout.revision,
                    }),
                    availability,
                    reason,
                ),
                action(
                    FlowOperationId::BuildoutTransition,
                    Some(room.project.project_id.clone()),
                    Some(buildout.buildout_id.clone()),
                    Some(FlowControlRoomExpectedRevision {
                        subject: FlowControlRoomRevisionSubject::Buildout,
                        revision: buildout.revision,
                    }),
                    availability,
                    reason,
                ),
            ]);
        }
    }
    Ok(actions)
}

fn action(
    operation_id: FlowOperationId,
    project_id: Option<String>,
    entity_id: Option<String>,
    expected_revision: Option<FlowControlRoomExpectedRevision>,
    availability: FlowControlRoomActionAvailability,
    disabled_reason: Option<FlowControlRoomDisabledReason>,
) -> FlowControlRoomAction {
    FlowControlRoomAction {
        protocol: FLOW_CONTROL_ROOM_ACTION_PROTOCOL.to_owned(),
        operation_id,
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        project_id,
        entity_id,
        expected_revision,
        availability,
        disabled_reason,
        grants_application_authority: false,
    }
}

fn validate_snapshot_selection(
    project: &FlowProjectSnapshot,
    selection: &FlowControlRoomSelection,
) -> Result<(), ContractError> {
    match selection.kind {
        FlowControlRoomSelectionKind::Project if selection.entity_id.is_none() => Ok(()),
        FlowControlRoomSelectionKind::Work => {
            let work_id = selection.entity_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "missing-flow-control-room-work-selection",
                    "Flow Control Room work selection requires a work identity",
                )
            })?;
            if project.work.iter().any(|work| work.work_id == work_id) {
                Ok(())
            } else {
                Err(ContractError::new(
                    "unknown-flow-control-room-work-selection",
                    "Selected Flow work does not exist in the project",
                ))
            }
        }
        FlowControlRoomSelectionKind::Buildout => {
            let buildout_id = selection.entity_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "missing-flow-control-room-buildout-selection",
                    "Flow Control Room buildout selection requires a buildout identity",
                )
            })?;
            if project
                .buildouts
                .iter()
                .any(|buildout| buildout.buildout_id == buildout_id)
            {
                Ok(())
            } else {
                Err(ContractError::new(
                    "unknown-flow-control-room-buildout-selection",
                    "Selected Flow buildout does not exist in the project",
                ))
            }
        }
        FlowControlRoomSelectionKind::Project => Err(ContractError::new(
            "unexpected-flow-control-room-project-entity",
            "Flow Control Room project selection cannot include an entity identity",
        )),
    }
}

fn validate_selection(room: &FlowProjectControlRoom) -> Result<(), ContractError> {
    match room.selection.kind {
        FlowControlRoomSelectionKind::Project if room.selection.entity_id.is_none() => Ok(()),
        FlowControlRoomSelectionKind::Work => {
            let work_id = room.selection.entity_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "missing-flow-control-room-work-selection",
                    "Flow Control Room work selection requires a work identity",
                )
            })?;
            if room
                .direct_work
                .iter()
                .chain(room.buildouts.iter().flat_map(|buildout| buildout.work.iter()))
                .any(|work| work.work_id == work_id)
            {
                Ok(())
            } else {
                Err(ContractError::new(
                    "unknown-flow-control-room-work-selection",
                    "Selected Flow work does not exist in the Control Room",
                ))
            }
        }
        FlowControlRoomSelectionKind::Buildout => {
            let buildout_id = room.selection.entity_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "missing-flow-control-room-buildout-selection",
                    "Flow Control Room buildout selection requires a buildout identity",
                )
            })?;
            if room
                .buildouts
                .iter()
                .any(|buildout| buildout.buildout_id == buildout_id)
            {
                Ok(())
            } else {
                Err(ContractError::new(
                    "unknown-flow-control-room-buildout-selection",
                    "Selected Flow buildout does not exist in the Control Room",
                ))
            }
        }
        FlowControlRoomSelectionKind::Project => Err(ContractError::new(
            "unexpected-flow-control-room-project-entity",
            "Flow Control Room project selection cannot include an entity identity",
        )),
    }
}

fn validate_project_header(header: &FlowControlRoomProjectHeader) -> Result<(), ContractError> {
    validate_scoped_identifier(
        &header.project_id,
        "project/",
        MAX_PROJECT_ID_BYTES,
        "invalid-flow-control-room-project-id",
    )?;
    if header.project_revision == 0 {
        return Err(ContractError::new(
            "invalid-flow-control-room-project-revision",
            "Flow Control Room project revision must be positive",
        ));
    }
    validate_text(&header.title, MAX_TITLE_BYTES, "invalid-flow-control-room-title")?;
    if let Some(summary) = &header.summary {
        validate_text(
            summary,
            MAX_SUMMARY_BYTES,
            "invalid-flow-control-room-summary",
        )?;
    }
    if header.created_at_unix_ms == 0
        || header.updated_at_unix_ms == 0
        || header.updated_at_unix_ms < header.created_at_unix_ms
    {
        return Err(ContractError::new(
            "invalid-flow-control-room-time",
            "Flow Control Room project timestamps must be positive and monotonic",
        ));
    }
    Ok(())
}

fn validate_work_card(work: &FlowControlRoomWorkCard) -> Result<(), ContractError> {
    validate_scoped_identifier(
        &work.work_id,
        "work/",
        MAX_WORK_ID_BYTES,
        "invalid-flow-control-room-work-id",
    )?;
    if work.revision == 0 {
        return Err(ContractError::new(
            "invalid-flow-control-room-work-revision",
            "Flow Control Room work revision must be positive",
        ));
    }
    validate_text(
        &work.title,
        MAX_TITLE_BYTES,
        "invalid-flow-control-room-work-title",
    )?;
    if let Some(summary) = &work.summary {
        validate_text(
            summary,
            MAX_SUMMARY_BYTES,
            "invalid-flow-control-room-work-summary",
        )?;
    }
    if let Some(buildout_id) = &work.buildout_id {
        validate_scoped_identifier(
            buildout_id,
            "buildout/",
            MAX_BUILDOUT_ID_BYTES,
            "invalid-flow-control-room-buildout-id",
        )?;
    }
    if let Some(root) = &work.exact_root {
        validate_digest(root)?;
    }
    Ok(())
}

fn validate_buildout_lane(buildout: &FlowControlRoomBuildoutLane) -> Result<(), ContractError> {
    validate_scoped_identifier(
        &buildout.buildout_id,
        "buildout/",
        MAX_BUILDOUT_ID_BYTES,
        "invalid-flow-control-room-buildout-id",
    )?;
    if buildout.revision == 0 || buildout.work.is_empty() {
        return Err(ContractError::new(
            "invalid-flow-control-room-buildout",
            "Flow Control Room buildout must be revisioned and contain visible work",
        ));
    }
    validate_text(
        &buildout.title,
        MAX_TITLE_BYTES,
        "invalid-flow-control-room-buildout-title",
    )?;
    if let Some(summary) = &buildout.summary {
        validate_text(
            summary,
            MAX_SUMMARY_BYTES,
            "invalid-flow-control-room-buildout-summary",
        )?;
    }
    if let Some(root) = &buildout.exact_root {
        validate_digest(root)?;
    }
    for work in &buildout.work {
        validate_work_card(work)?;
    }
    Ok(())
}

fn revision_subject(
    operation_id: FlowOperationId,
) -> Result<FlowControlRoomRevisionSubject, ContractError> {
    match operation_id {
        FlowOperationId::ProjectUpdate
        | FlowOperationId::ProjectTransition
        | FlowOperationId::WorkCreate
        | FlowOperationId::BuildoutCreate => Ok(FlowControlRoomRevisionSubject::Project),
        FlowOperationId::WorkUpdate | FlowOperationId::WorkTransition => {
            Ok(FlowControlRoomRevisionSubject::Work)
        }
        FlowOperationId::BuildoutUpdate | FlowOperationId::BuildoutTransition => {
            Ok(FlowControlRoomRevisionSubject::Buildout)
        }
        _ => Err(ContractError::new(
            "unexpected-flow-control-room-revision",
            "Flow Control Room operation does not use an expected revision",
        )),
    }
}

fn is_control_room_operation(operation_id: FlowOperationId) -> bool {
    matches!(
        operation_id,
        FlowOperationId::ProjectList
            | FlowOperationId::ProjectGet
            | FlowOperationId::ProjectUpdate
            | FlowOperationId::ProjectTransition
            | FlowOperationId::WorkGet
            | FlowOperationId::WorkCreate
            | FlowOperationId::WorkUpdate
            | FlowOperationId::WorkTransition
            | FlowOperationId::BuildoutGet
            | FlowOperationId::BuildoutCreate
            | FlowOperationId::BuildoutUpdate
            | FlowOperationId::BuildoutTransition
    )
}

fn require_flow_application(
    application_id: CurrentApplicationId,
    application_revision: &str,
) -> Result<(), ContractError> {
    if application_id != CurrentApplicationId::Flow {
        return Err(ContractError::new(
            "invalid-flow-control-room-application",
            "Flow Project Control Room must be owned by the current Flow application",
        ));
    }
    if application_revision != CURRENT_SUITE_REVISION {
        return Err(ContractError::new(
            "flow-control-room-application-revision-mismatch",
            "Flow Project Control Room requires the exact current application revision",
        ));
    }
    Ok(())
}

fn validate_scoped_identifier(
    value: &str,
    prefix: &str,
    maximum: usize,
    code: &'static str,
) -> Result<(), ContractError> {
    let valid = value.starts_with(prefix)
        && value.len() > prefix.len()
        && value.len() <= maximum
        && !value.ends_with('/')
        && !value.contains("//")
        && !value.contains("..")
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        });
    if valid {
        Ok(())
    } else {
        Err(ContractError::new(code, "Flow Control Room scoped identity is invalid"))
    }
}

fn validate_digest(value: &str) -> Result<(), ContractError> {
    if value.strip_prefix("sha256:").is_some_and(|suffix| {
        suffix.len() == 64
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        Ok(())
    } else {
        Err(ContractError::new(
            "invalid-flow-control-room-exact-root",
            "Flow Control Room exact root must be a lowercase SHA-256 digest",
        ))
    }
}

fn validate_text(
    value: &str,
    maximum: usize,
    code: &'static str,
) -> Result<(), ContractError> {
    if !value.is_empty() && value.len() <= maximum {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow Control Room text is outside its byte bound",
        ))
    }
}

#[allow(dead_code)]
fn _assert_catalogue_idempotency_is_closed() {
    let catalogue = flow_operation_catalogue();
    for operation in catalogue.operations {
        if operation.intent == FlowOperationIntent::Manage {
            debug_assert_eq!(operation.idempotency, FlowIdempotencyLaw::ExactRequest);
        }
    }
}

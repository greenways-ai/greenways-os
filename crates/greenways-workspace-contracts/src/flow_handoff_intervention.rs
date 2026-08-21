use crate::error::ContractError;
use crate::flow_participation::{
    FlowAgentMandateCapability, FlowAgentMandateState, FlowProjectMemberRole,
    FlowProjectMemberState, FlowProjectParticipationSnapshot, FlowProjectPrincipalKind,
};
use crate::flow_presence::{
    FlowHostObservationState, FlowProjectHostAttachmentState, FlowProjectPresenceSnapshot,
    FlowSessionPresenceState,
};
use crate::flow_work_coordination::{FlowWorkClaimState, FlowWorkCoordinationSnapshot};
use crate::suite::{
    CurrentApplicationId, HandoffEnvelope, HandoffState as SuiteHandoffState, SharedReference,
    CURRENT_SUITE_REVISION, SPACES_APPLICATION_ID,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const FLOW_PROJECT_HANDOFF_INTERVENTION_PROTOCOL: &str =
    "greenways.flow.project-handoffs-interventions/0-alpha";
pub const FLOW_PROJECT_HANDOFF_PROTOCOL: &str = "greenways.flow.project-handoff/0-alpha";
pub const FLOW_PROJECT_INTERVENTION_PROTOCOL: &str =
    "greenways.flow.project-intervention/0-alpha";
pub const FLOW_HANDOFF_RECONCILIATION_PROTOCOL: &str =
    "greenways.flow.handoff-reconciliation/0-alpha";
pub const FLOW_HANDOFF_INTERVENTION_OPERATION_PROTOCOL: &str =
    "greenways.flow.handoff-intervention-operation/0-alpha";
pub const FLOW_HANDOFF_INTERVENTION_OPERATION_CATALOGUE_PROTOCOL: &str =
    "greenways.flow.handoff-intervention-operation-catalogue/0-alpha";

pub const FLOW_PROJECT_HANDOFFS_LIST_OPERATION: &str = "flow.project.handoffs.list";
pub const FLOW_PROJECT_HANDOFF_REQUEST_OPERATION: &str = "flow.project.handoff.request";
pub const FLOW_PROJECT_HANDOFF_DECIDE_OPERATION: &str = "flow.project.handoff.decide";
pub const FLOW_PROJECT_HANDOFF_OBSERVE_OPERATION: &str = "flow.project.handoff.observe";
pub const FLOW_PROJECT_HANDOFF_CANCEL_OPERATION: &str = "flow.project.handoff.cancel";
pub const FLOW_PROJECT_HANDOFF_RECONCILE_OPERATION: &str = "flow.project.handoff.reconcile";
pub const FLOW_PROJECT_INTERVENTIONS_LIST_OPERATION: &str =
    "flow.project.interventions.list";
pub const FLOW_PROJECT_INTERVENTION_RAISE_OPERATION: &str =
    "flow.project.intervention.raise";
pub const FLOW_PROJECT_INTERVENTION_ACKNOWLEDGE_OPERATION: &str =
    "flow.project.intervention.acknowledge";
pub const FLOW_PROJECT_INTERVENTION_DECIDE_OPERATION: &str =
    "flow.project.intervention.decide";
pub const FLOW_PROJECT_INTERVENTION_RESOLVE_OPERATION: &str =
    "flow.project.intervention.resolve";

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_HANDOFF_ID_BYTES: usize = 256;
const MAX_INTERVENTION_ID_BYTES: usize = 256;
const MAX_MEMBERSHIP_ID_BYTES: usize = 256;
const MAX_MANDATE_ID_BYTES: usize = 256;
const MAX_SESSION_ID_BYTES: usize = 256;
const MAX_WORK_ID_BYTES: usize = 256;
const MAX_CLAIM_ID_BYTES: usize = 256;
const MAX_TARGET_ID_BYTES: usize = 256;
const MAX_RECONCILIATION_ID_BYTES: usize = 256;
const MAX_IDEMPOTENCY_KEY_BYTES: usize = 256;
const MAX_SUMMARY_BYTES: usize = 200;
const MAX_DETAIL_BYTES: usize = 800;
const MAX_INCLUDED_REFERENCES: usize = 32;
const MAX_HANDOFFS: usize = 512;
const MAX_INTERVENTIONS: usize = 512;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectHandoffActor {
    pub membership_id: String,
    pub agent_mandate_id: Option<String>,
    pub session_id: Option<String>,
}

impl FlowProjectHandoffActor {
    pub fn validate(&self) -> Result<(), ContractError> {
        validate_scoped_identifier(
            &self.membership_id,
            "membership/",
            MAX_MEMBERSHIP_ID_BYTES,
            "invalid-flow-handoff-membership-id",
        )?;
        if let Some(mandate_id) = &self.agent_mandate_id {
            validate_scoped_identifier(
                mandate_id,
                "mandate/",
                MAX_MANDATE_ID_BYTES,
                "invalid-flow-handoff-mandate-id",
            )?;
        }
        if let Some(session_id) = &self.session_id {
            validate_scoped_identifier(
                session_id,
                "session/",
                MAX_SESSION_ID_BYTES,
                "invalid-flow-handoff-session-id",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHandoffTargetKind {
    Membership,
    AgentMandate,
    HostAttachment,
    Session,
    Application,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectHandoffTarget {
    pub kind: FlowProjectHandoffTargetKind,
    pub target_id: String,
}

impl FlowProjectHandoffTarget {
    pub fn validate(&self) -> Result<(), ContractError> {
        match self.kind {
            FlowProjectHandoffTargetKind::Membership => validate_scoped_identifier(
                &self.target_id,
                "membership/",
                MAX_TARGET_ID_BYTES,
                "invalid-flow-handoff-target",
            ),
            FlowProjectHandoffTargetKind::AgentMandate => validate_scoped_identifier(
                &self.target_id,
                "mandate/",
                MAX_TARGET_ID_BYTES,
                "invalid-flow-handoff-target",
            ),
            FlowProjectHandoffTargetKind::HostAttachment => validate_scoped_identifier(
                &self.target_id,
                "attachment/",
                MAX_TARGET_ID_BYTES,
                "invalid-flow-handoff-target",
            ),
            FlowProjectHandoffTargetKind::Session => validate_scoped_identifier(
                &self.target_id,
                "session/",
                MAX_TARGET_ID_BYTES,
                "invalid-flow-handoff-target",
            ),
            FlowProjectHandoffTargetKind::Application => {
                if self.target_id == SPACES_APPLICATION_ID {
                    Ok(())
                } else {
                    Err(ContractError::new(
                        "unactivated-or-incompatible-flow-handoff-target",
                        "Current Flow application handoffs target activated Spaces only",
                    ))
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FlowExcludedAuthority {
    ApplicationAuthority,
    ProjectMembership,
    AgentMandate,
    ProviderCredentials,
    HostWideAuthority,
    WorkRuntimeState,
    ExternalEffectAuthority,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHandoffState {
    Prepared,
    ApprovalRequired,
    Ready,
    Accepted,
    Transferring,
    Received,
    Completed,
    Partial,
    Rejected,
    Cancelled,
    Failed,
    Expired,
    Stale,
}

impl FlowProjectHandoffState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Prepared,
                Self::ApprovalRequired | Self::Ready | Self::Cancelled | Self::Expired
            ) | (
                Self::ApprovalRequired,
                Self::Ready | Self::Rejected | Self::Cancelled | Self::Expired
            ) | (
                Self::Ready,
                Self::Accepted | Self::Rejected | Self::Cancelled | Self::Expired
            ) | (
                Self::Accepted,
                Self::Transferring | Self::Cancelled | Self::Failed | Self::Stale
            ) | (
                Self::Transferring,
                Self::Received | Self::Partial | Self::Cancelled | Self::Failed | Self::Stale
            ) | (
                Self::Received,
                Self::Completed | Self::Partial | Self::Failed | Self::Stale
            ) | (
                Self::Stale,
                Self::Ready
                    | Self::Accepted
                    | Self::Transferring
                    | Self::Received
                    | Self::Cancelled
                    | Self::Failed
                    | Self::Expired
            )
        )
    }

    const fn requires_ready_target(self) -> bool {
        matches!(
            self,
            Self::Ready
                | Self::Accepted
                | Self::Transferring
                | Self::Received
                | Self::Completed
                | Self::Partial
        )
    }

    const fn is_current(self) -> bool {
        !matches!(
            self,
            Self::Completed
                | Self::Partial
                | Self::Rejected
                | Self::Cancelled
                | Self::Failed
                | Self::Expired
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHandoffTerminalCode {
    Rejected,
    Cancelled,
    Failed,
    Expired,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHandoffStaleReason {
    SourceRevisionChanged,
    TargetUnavailable,
    SessionLost,
    HostStale,
    ObservationLost,
    TransferUnknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectHandoff {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub handoff_id: String,
    pub revision: u64,
    pub idempotency_key: String,
    pub request_digest: String,
    pub source_actor: FlowProjectHandoffActor,
    pub target: FlowProjectHandoffTarget,
    pub work_id: Option<String>,
    pub claim_id: Option<String>,
    pub included_references: Vec<SharedReference>,
    pub context_digest: String,
    pub excluded_authority: Vec<FlowExcludedAuthority>,
    pub approval_required: bool,
    pub state: FlowProjectHandoffState,
    pub application_handoff: Option<HandoffEnvelope>,
    pub created_at_unix_ms: u64,
    pub approved_at_unix_ms: Option<u64>,
    pub accepted_at_unix_ms: Option<u64>,
    pub transfer_started_at_unix_ms: Option<u64>,
    pub received_at_unix_ms: Option<u64>,
    pub completed_at_unix_ms: Option<u64>,
    pub last_observed_at_unix_ms: Option<u64>,
    pub terminal_at_unix_ms: Option<u64>,
    pub stale_at_unix_ms: Option<u64>,
    pub stale_reason: Option<FlowProjectHandoffStaleReason>,
    pub terminal_code: Option<FlowProjectHandoffTerminalCode>,
    pub authority_transfer: bool,
    pub carries_provider_credentials: bool,
    pub carries_private_provider_reference: bool,
    pub copies_work_runtime_state: bool,
    pub repeats_external_effect: bool,
}

impl FlowProjectHandoff {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_HANDOFF_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.handoff_id,
            "handoff/",
            MAX_HANDOFF_ID_BYTES,
            "invalid-flow-project-handoff-id",
        )?;
        validate_scoped_identifier(
            &self.idempotency_key,
            "idempotency/",
            MAX_IDEMPOTENCY_KEY_BYTES,
            "invalid-flow-handoff-idempotency-key",
        )?;
        require_positive_revision(self.revision, "invalid-flow-project-handoff-revision")?;
        validate_digest(&self.request_digest)?;
        validate_digest(&self.context_digest)?;
        self.source_actor.validate()?;
        self.target.validate()?;
        if let Some(work_id) = &self.work_id {
            validate_scoped_identifier(
                work_id,
                "work/",
                MAX_WORK_ID_BYTES,
                "invalid-flow-handoff-work-id",
            )?;
        }
        if let Some(claim_id) = &self.claim_id {
            validate_scoped_identifier(
                claim_id,
                "claim/",
                MAX_CLAIM_ID_BYTES,
                "invalid-flow-handoff-claim-id",
            )?;
            if self.work_id.is_none() {
                return Err(ContractError::new(
                    "flow-handoff-claim-without-work",
                    "Flow project handoff claim context requires exact work",
                ));
            }
        }
        if self.included_references.len() > MAX_INCLUDED_REFERENCES {
            return Err(ContractError::new(
                "too-many-flow-handoff-references",
                "Flow project handoff includes too many shared references",
            ));
        }
        let mut reference_ids = BTreeSet::new();
        for reference in &self.included_references {
            reference.validate()?;
            if reference.application_revision != CURRENT_SUITE_REVISION {
                return Err(ContractError::new(
                    "flow-handoff-reference-revision-mismatch",
                    "Flow handoff references require the exact current application revision",
                ));
            }
            if !reference_ids.insert((
                reference.application_id,
                reference.owner_id.as_str(),
                reference.record_kind.as_str(),
                reference.logical_id.as_str(),
            )) {
                return Err(ContractError::new(
                    "duplicate-flow-handoff-reference",
                    "Flow handoff included references must be unique",
                ));
            }
        }
        if self
            .excluded_authority
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            != required_excluded_authority()
            || self.excluded_authority.len() != required_excluded_authority().len()
        {
            return Err(ContractError::new(
                "incomplete-flow-handoff-authority-exclusion",
                "Flow handoff must explicitly exclude every non-transferable authority class",
            ));
        }
        if self.created_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-handoff-time",
                "Flow handoff creation time must be positive",
            ));
        }
        for timestamp in [
            self.approved_at_unix_ms,
            self.accepted_at_unix_ms,
            self.transfer_started_at_unix_ms,
            self.received_at_unix_ms,
            self.completed_at_unix_ms,
            self.last_observed_at_unix_ms,
            self.terminal_at_unix_ms,
            self.stale_at_unix_ms,
        ]
        .into_iter()
        .flatten()
        {
            if timestamp < self.created_at_unix_ms {
                return Err(ContractError::new(
                    "invalid-flow-handoff-time",
                    "Flow handoff lifecycle timestamps must follow creation",
                ));
            }
        }
        if !ordered_optional_times(&[
            self.accepted_at_unix_ms,
            self.transfer_started_at_unix_ms,
            self.received_at_unix_ms,
            self.completed_at_unix_ms,
        ]) {
            return Err(ContractError::new(
                "invalid-flow-handoff-time-order",
                "Flow handoff acceptance, transfer, receipt, and completion must be monotonic",
            ));
        }
        if self.approval_required
            && matches!(
                self.state,
                FlowProjectHandoffState::Ready
                    | FlowProjectHandoffState::Accepted
                    | FlowProjectHandoffState::Transferring
                    | FlowProjectHandoffState::Received
                    | FlowProjectHandoffState::Completed
                    | FlowProjectHandoffState::Partial
            )
            && self.approved_at_unix_ms.is_none()
        {
            return Err(ContractError::new(
                "flow-handoff-missing-approval",
                "Approval-required Flow handoff cannot advance without approval evidence",
            ));
        }
        if !self.approval_required && self.approved_at_unix_ms.is_some() {
            return Err(ContractError::new(
                "unexpected-flow-handoff-approval",
                "Flow handoff without an approval gate cannot claim approval evidence",
            ));
        }

        let state_evidence_is_valid = match self.state {
            FlowProjectHandoffState::Prepared => {
                self.approved_at_unix_ms.is_none()
                    && self.accepted_at_unix_ms.is_none()
                    && self.transfer_started_at_unix_ms.is_none()
                    && self.received_at_unix_ms.is_none()
                    && self.completed_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self.terminal_code.is_none()
            }
            FlowProjectHandoffState::ApprovalRequired => {
                self.approval_required
                    && self.approved_at_unix_ms.is_none()
                    && self.accepted_at_unix_ms.is_none()
                    && self.transfer_started_at_unix_ms.is_none()
                    && self.received_at_unix_ms.is_none()
                    && self.completed_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self.terminal_code.is_none()
            }
            FlowProjectHandoffState::Ready => {
                self.accepted_at_unix_ms.is_none()
                    && self.transfer_started_at_unix_ms.is_none()
                    && self.received_at_unix_ms.is_none()
                    && self.completed_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self.terminal_code.is_none()
            }
            FlowProjectHandoffState::Accepted => {
                self.accepted_at_unix_ms.is_some()
                    && self.transfer_started_at_unix_ms.is_none()
                    && self.received_at_unix_ms.is_none()
                    && self.completed_at_unix_ms.is_none()
                    && self.last_observed_at_unix_ms.is_some()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self.terminal_code.is_none()
            }
            FlowProjectHandoffState::Transferring => {
                self.accepted_at_unix_ms.is_some()
                    && self.transfer_started_at_unix_ms.is_some()
                    && self.received_at_unix_ms.is_none()
                    && self.completed_at_unix_ms.is_none()
                    && self.last_observed_at_unix_ms.is_some()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self.terminal_code.is_none()
            }
            FlowProjectHandoffState::Received => {
                self.accepted_at_unix_ms.is_some()
                    && self.transfer_started_at_unix_ms.is_some()
                    && self.received_at_unix_ms.is_some()
                    && self.completed_at_unix_ms.is_none()
                    && self.last_observed_at_unix_ms.is_some()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self.terminal_code.is_none()
            }
            FlowProjectHandoffState::Completed | FlowProjectHandoffState::Partial => {
                self.accepted_at_unix_ms.is_some()
                    && self.transfer_started_at_unix_ms.is_some()
                    && self.received_at_unix_ms.is_some()
                    && self.completed_at_unix_ms.is_some()
                    && self.last_observed_at_unix_ms.is_some()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self.terminal_code.is_none()
            }
            FlowProjectHandoffState::Rejected => terminal_evidence_matches(
                self,
                FlowProjectHandoffTerminalCode::Rejected,
                true,
            ),
            FlowProjectHandoffState::Cancelled => terminal_evidence_matches(
                self,
                FlowProjectHandoffTerminalCode::Cancelled,
                false,
            ),
            FlowProjectHandoffState::Failed => terminal_evidence_matches(
                self,
                FlowProjectHandoffTerminalCode::Failed,
                false,
            ),
            FlowProjectHandoffState::Expired => terminal_evidence_matches(
                self,
                FlowProjectHandoffTerminalCode::Expired,
                false,
            ),
            FlowProjectHandoffState::Stale => {
                self.accepted_at_unix_ms.is_some()
                    && self.completed_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_some()
                    && self.stale_reason.is_some()
                    && self.last_observed_at_unix_ms.is_some()
                    && self
                        .stale_at_unix_ms
                        .zip(self.last_observed_at_unix_ms)
                        .is_some_and(|(stale, observed)| stale >= observed)
                    && self.terminal_code.is_none()
            }
        };
        if !state_evidence_is_valid {
            return Err(ContractError::new(
                "flow-handoff-state-evidence-mismatch",
                "Flow handoff state requires exact matching lifecycle evidence",
            ));
        }
        if self.authority_transfer
            || self.carries_provider_credentials
            || self.carries_private_provider_reference
            || self.copies_work_runtime_state
            || self.repeats_external_effect
        {
            return Err(ContractError::new(
                "flow-handoff-authority-or-effect-expansion",
                "Flow handoff cannot transfer authority, credentials, private provider references, Work state, or external effects",
            ));
        }

        match self.target.kind {
            FlowProjectHandoffTargetKind::Application => {
                if self.included_references.is_empty() {
                    return Err(ContractError::new(
                        "missing-flow-application-handoff-reference",
                        "Current application handoff requires bounded shared context",
                    ));
                }
                let application_handoff = self.application_handoff.as_ref().ok_or_else(|| {
                    ContractError::new(
                        "missing-flow-application-handoff",
                        "Flow application target requires the common handoff envelope",
                    )
                })?;
                application_handoff.validate()?;
                if application_handoff.source.application_id != CurrentApplicationId::Flow
                    || application_handoff.source.owner_id != self.project_id
                    || application_handoff.target_application_id != CurrentApplicationId::Spaces
                    || application_handoff.target_application_revision != self.application_revision
                    || application_handoff.idempotency_key != self.idempotency_key
                    || application_handoff.request_digest != self.request_digest
                    || !suite_state_matches(self.state, application_handoff.state)
                {
                    return Err(ContractError::new(
                        "flow-application-handoff-mismatch",
                        "Flow project and common application handoff envelopes must describe one exact request and lifecycle",
                    ));
                }
            }
            _ => {
                if self.application_handoff.is_some() {
                    return Err(ContractError::new(
                        "unexpected-flow-application-handoff",
                        "Project-local Flow handoff cannot carry an application envelope",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHandoffReplay {
    New,
    ExactReplay,
}

pub fn compare_flow_project_handoff_replay(
    existing: &FlowProjectHandoff,
    candidate: &FlowProjectHandoff,
) -> Result<FlowProjectHandoffReplay, ContractError> {
    existing.validate()?;
    candidate.validate()?;
    if existing.idempotency_key != candidate.idempotency_key {
        return Ok(FlowProjectHandoffReplay::New);
    }
    if existing.project_id == candidate.project_id
        && existing.request_digest == candidate.request_digest
        && existing.source_actor == candidate.source_actor
        && existing.target == candidate.target
        && existing.work_id == candidate.work_id
        && existing.claim_id == candidate.claim_id
        && existing.included_references == candidate.included_references
        && existing.context_digest == candidate.context_digest
        && existing.excluded_authority == candidate.excluded_authority
        && existing.approval_required == candidate.approval_required
        && same_application_handoff_request(
            existing.application_handoff.as_ref(),
            candidate.application_handoff.as_ref(),
        )
    {
        Ok(FlowProjectHandoffReplay::ExactReplay)
    } else {
        Err(ContractError::new(
            "flow-handoff-idempotency-collision",
            "Flow handoff idempotency key is bound to different request content",
        ))
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectInterventionKind {
    Blocker,
    Question,
    Approval,
    UncertainEffect,
    StaleClaim,
    HandoffReview,
    Divergence,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectInterventionSubjectKind {
    Project,
    Work,
    Claim,
    Handoff,
    Session,
    HostAttachment,
    ExternalEffect,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectInterventionState {
    Open,
    Acknowledged,
    DecisionRequired,
    Approved,
    Rejected,
    Resolved,
    Dismissed,
    Expired,
}

impl FlowProjectInterventionState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Open,
                Self::Acknowledged
                    | Self::DecisionRequired
                    | Self::Resolved
                    | Self::Dismissed
                    | Self::Expired
            ) | (
                Self::Acknowledged,
                Self::DecisionRequired
                    | Self::Resolved
                    | Self::Dismissed
                    | Self::Expired
            ) | (
                Self::DecisionRequired,
                Self::Approved | Self::Rejected | Self::Dismissed | Self::Expired
            ) | (Self::Approved, Self::Resolved) | (Self::Rejected, Self::Resolved)
        )
    }

    const fn is_current(self) -> bool {
        matches!(self, Self::Open | Self::Acknowledged | Self::DecisionRequired)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectInterventionDecision {
    Approve,
    Reject,
    Narrow,
    Retry,
    Cancel,
    NoAction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectIntervention {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub intervention_id: String,
    pub revision: u64,
    pub kind: FlowProjectInterventionKind,
    pub subject_kind: FlowProjectInterventionSubjectKind,
    pub subject_id: String,
    pub raised_by: FlowProjectHandoffActor,
    pub state: FlowProjectInterventionState,
    pub summary: String,
    pub detail: Option<String>,
    pub created_at_unix_ms: u64,
    pub acknowledged_at_unix_ms: Option<u64>,
    pub acknowledged_by_membership_id: Option<String>,
    pub decision: Option<FlowProjectInterventionDecision>,
    pub decided_at_unix_ms: Option<u64>,
    pub decided_by_membership_id: Option<String>,
    pub resolution_reference: Option<SharedReference>,
    pub resolved_at_unix_ms: Option<u64>,
    pub resolved_by_membership_id: Option<String>,
    pub expires_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
    pub mutates_external_effect: bool,
    pub repeats_provider_work: bool,
    pub deletes_durable_history: bool,
}

impl FlowProjectIntervention {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_INTERVENTION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.intervention_id,
            "intervention/",
            MAX_INTERVENTION_ID_BYTES,
            "invalid-flow-intervention-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-intervention-revision")?;
        validate_intervention_subject(self.subject_kind, &self.subject_id)?;
        self.raised_by.validate()?;
        validate_text(
            &self.summary,
            MAX_SUMMARY_BYTES,
            "invalid-flow-intervention-summary",
        )?;
        if let Some(detail) = &self.detail {
            validate_text(
                detail,
                MAX_DETAIL_BYTES,
                "invalid-flow-intervention-detail",
            )?;
        }
        if self.created_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-intervention-time",
                "Flow intervention creation time must be positive",
            ));
        }
        for timestamp in [
            self.acknowledged_at_unix_ms,
            self.decided_at_unix_ms,
            self.resolved_at_unix_ms,
            self.expires_at_unix_ms,
        ]
        .into_iter()
        .flatten()
        {
            if timestamp < self.created_at_unix_ms {
                return Err(ContractError::new(
                    "invalid-flow-intervention-time",
                    "Flow intervention lifecycle timestamps must follow creation",
                ));
            }
        }
        validate_optional_actor_pair(
            self.acknowledged_at_unix_ms,
            self.acknowledged_by_membership_id.as_deref(),
            "flow-intervention-acknowledgement-mismatch",
        )?;
        validate_optional_decision(self)?;
        validate_optional_resolution(self)?;
        if let Some(membership_id) = &self.acknowledged_by_membership_id {
            validate_scoped_identifier(
                membership_id,
                "membership/",
                MAX_MEMBERSHIP_ID_BYTES,
                "invalid-flow-intervention-actor",
            )?;
        }
        if let Some(membership_id) = &self.decided_by_membership_id {
            validate_scoped_identifier(
                membership_id,
                "membership/",
                MAX_MEMBERSHIP_ID_BYTES,
                "invalid-flow-intervention-actor",
            )?;
        }
        if let Some(membership_id) = &self.resolved_by_membership_id {
            validate_scoped_identifier(
                membership_id,
                "membership/",
                MAX_MEMBERSHIP_ID_BYTES,
                "invalid-flow-intervention-actor",
            )?;
        }
        if let Some(reference) = &self.resolution_reference {
            reference.validate()?;
            if reference.application_id != CurrentApplicationId::Flow
                || reference.application_revision != self.application_revision
                || reference.owner_id != self.project_id
            {
                return Err(ContractError::new(
                    "invalid-flow-intervention-resolution-reference",
                    "Flow intervention resolution evidence must remain owned by the exact Flow project",
                ));
            }
        }

        let state_evidence_is_valid = match self.state {
            FlowProjectInterventionState::Open => {
                self.acknowledged_at_unix_ms.is_none()
                    && self.decision.is_none()
                    && self.resolution_reference.is_none()
                    && self.resolved_at_unix_ms.is_none()
                    && self.expires_at_unix_ms.is_none()
            }
            FlowProjectInterventionState::Acknowledged => {
                self.acknowledged_at_unix_ms.is_some()
                    && self.decision.is_none()
                    && self.resolution_reference.is_none()
                    && self.resolved_at_unix_ms.is_none()
            }
            FlowProjectInterventionState::DecisionRequired => {
                self.acknowledged_at_unix_ms.is_some()
                    && self.decision.is_none()
                    && self.resolution_reference.is_none()
                    && self.resolved_at_unix_ms.is_none()
            }
            FlowProjectInterventionState::Approved => {
                self.acknowledged_at_unix_ms.is_some()
                    && matches!(
                        self.decision,
                        Some(
                            FlowProjectInterventionDecision::Approve
                                | FlowProjectInterventionDecision::Narrow
                                | FlowProjectInterventionDecision::Retry
                        )
                    )
                    && self.resolution_reference.is_none()
                    && self.resolved_at_unix_ms.is_none()
            }
            FlowProjectInterventionState::Rejected => {
                self.acknowledged_at_unix_ms.is_some()
                    && matches!(
                        self.decision,
                        Some(
                            FlowProjectInterventionDecision::Reject
                                | FlowProjectInterventionDecision::Cancel
                        )
                    )
                    && self.resolution_reference.is_none()
                    && self.resolved_at_unix_ms.is_none()
            }
            FlowProjectInterventionState::Resolved => {
                self.acknowledged_at_unix_ms.is_some()
                    && self.resolution_reference.is_some()
                    && self.resolved_at_unix_ms.is_some()
            }
            FlowProjectInterventionState::Dismissed => {
                self.acknowledged_at_unix_ms.is_some()
                    && self.decision == Some(FlowProjectInterventionDecision::NoAction)
                    && self.resolution_reference.is_none()
                    && self.resolved_at_unix_ms.is_none()
            }
            FlowProjectInterventionState::Expired => {
                self.expires_at_unix_ms.is_some()
                    && self.resolution_reference.is_none()
                    && self.resolved_at_unix_ms.is_none()
            }
        };
        if !state_evidence_is_valid {
            return Err(ContractError::new(
                "flow-intervention-state-evidence-mismatch",
                "Flow intervention state requires exact acknowledgement, decision, and resolution evidence",
            ));
        }
        if intervention_kind_requires_decision(self.kind)
            && self.state == FlowProjectInterventionState::Resolved
            && self.decision.is_none()
        {
            return Err(ContractError::new(
                "flow-intervention-resolution-without-decision",
                "Approval, handoff review, uncertain-effect, and divergence interventions require a human decision before resolution",
            ));
        }
        if self.authority_transfer
            || self.mutates_external_effect
            || self.repeats_provider_work
            || self.deletes_durable_history
        {
            return Err(ContractError::new(
                "flow-intervention-authority-or-effect-expansion",
                "Flow interventions neither transfer authority, mutate effects, repeat provider work, nor delete history",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowHandoffReconciliationState {
    Current,
    Stale,
    Divergent,
    ResyncRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowHandoffReconciliation {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub reconciliation_id: String,
    pub generation: u64,
    pub previous_generation: Option<u64>,
    pub state: FlowHandoffReconciliationState,
    pub started_at_unix_ms: u64,
    pub completed_at_unix_ms: u64,
    pub repeats_transfers: bool,
    pub repeats_provider_work: bool,
    pub repeats_external_effects: bool,
    pub mutates_terminal_handoff_state: bool,
    pub authority_transfer: bool,
}

impl FlowHandoffReconciliation {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_HANDOFF_RECONCILIATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.reconciliation_id,
            "handoff-reconciliation/",
            MAX_RECONCILIATION_ID_BYTES,
            "invalid-flow-handoff-reconciliation-id",
        )?;
        require_positive_revision(
            self.generation,
            "invalid-flow-handoff-reconciliation-generation",
        )?;
        if self
            .previous_generation
            .is_some_and(|value| value == 0 || value >= self.generation)
        {
            return Err(ContractError::new(
                "invalid-flow-handoff-previous-generation",
                "Flow handoff reconciliation previous generation must be positive and earlier",
            ));
        }
        if self.started_at_unix_ms == 0 || self.completed_at_unix_ms < self.started_at_unix_ms {
            return Err(ContractError::new(
                "invalid-flow-handoff-reconciliation-time",
                "Flow handoff reconciliation timestamps must be positive and monotonic",
            ));
        }
        if self.repeats_transfers
            || self.repeats_provider_work
            || self.repeats_external_effects
            || self.mutates_terminal_handoff_state
            || self.authority_transfer
        {
            return Err(ContractError::new(
                "flow-handoff-reconciliation-side-effect",
                "Flow handoff reconciliation updates evidence only and cannot repeat transfer, provider work, external effects, terminal state, or authority",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectHandoffInterventionSnapshot {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub project_revision: u64,
    pub snapshot_generation: u64,
    pub observed_at_unix_ms: u64,
    pub reconciliation: FlowHandoffReconciliation,
    pub handoffs: Vec<FlowProjectHandoff>,
    pub interventions: Vec<FlowProjectIntervention>,
}

impl FlowProjectHandoffInterventionSnapshot {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_PROJECT_HANDOFF_INTERVENTION_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        require_positive_revision(self.project_revision, "invalid-flow-project-revision")?;
        require_positive_revision(
            self.snapshot_generation,
            "invalid-flow-handoff-snapshot-generation",
        )?;
        if self.observed_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-handoff-observation-time",
                "Flow handoff/intervention observation time must be positive",
            ));
        }
        if self.handoffs.len() > MAX_HANDOFFS || self.interventions.len() > MAX_INTERVENTIONS {
            return Err(ContractError::new(
                "flow-handoff-intervention-collection-limit",
                "Flow handoff/intervention collections exceed their bounds",
            ));
        }
        self.reconciliation.validate()?;
        require_record_membership(
            &self.project_id,
            &self.application_revision,
            &self.reconciliation.project_id,
            &self.reconciliation.application_revision,
            "flow-handoff-reconciliation-project-mismatch",
        )?;
        if self.reconciliation.generation != self.snapshot_generation
            || self.reconciliation.completed_at_unix_ms > self.observed_at_unix_ms
        {
            return Err(ContractError::new(
                "flow-handoff-reconciliation-snapshot-mismatch",
                "Flow handoff reconciliation must describe the exact snapshot generation",
            ));
        }

        let mut handoff_ids = BTreeSet::new();
        let mut idempotency_keys = BTreeSet::new();
        for handoff in &self.handoffs {
            handoff.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &handoff.project_id,
                &handoff.application_revision,
                "flow-project-handoff-project-mismatch",
            )?;
            if !handoff_ids.insert(handoff.handoff_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-project-handoff-id",
                    "Flow project handoff identities must be unique",
                ));
            }
            if !idempotency_keys.insert(handoff.idempotency_key.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-handoff-idempotency-key",
                    "One Flow handoff snapshot cannot bind one idempotency key twice",
                ));
            }
            if handoff
                .last_observed_at_unix_ms
                .is_some_and(|value| value > self.observed_at_unix_ms)
                || handoff
                    .stale_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || handoff
                    .completed_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || handoff
                    .terminal_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
            {
                return Err(ContractError::new(
                    "future-flow-handoff-evidence",
                    "Flow handoff lifecycle evidence cannot be newer than its snapshot",
                ));
            }
        }

        let mut intervention_ids = BTreeSet::new();
        for intervention in &self.interventions {
            intervention.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &intervention.project_id,
                &intervention.application_revision,
                "flow-project-intervention-project-mismatch",
            )?;
            if !intervention_ids.insert(intervention.intervention_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-project-intervention-id",
                    "Flow project intervention identities must be unique",
                ));
            }
            if intervention.subject_kind == FlowProjectInterventionSubjectKind::Handoff
                && !handoff_ids.contains(intervention.subject_id.as_str())
            {
                return Err(ContractError::new(
                    "unknown-flow-intervention-handoff",
                    "Flow intervention handoff subject must exist in the exact snapshot",
                ));
            }
        }

        for handoff in self
            .handoffs
            .iter()
            .filter(|handoff| handoff.state == FlowProjectHandoffState::ApprovalRequired)
        {
            let pending_reviews = self
                .interventions
                .iter()
                .filter(|intervention| {
                    intervention.subject_kind == FlowProjectInterventionSubjectKind::Handoff
                        && intervention.subject_id == handoff.handoff_id
                        && matches!(
                            intervention.kind,
                            FlowProjectInterventionKind::Approval
                                | FlowProjectInterventionKind::HandoffReview
                        )
                        && intervention.state.is_current()
                })
                .count();
            if pending_reviews != 1 {
                return Err(ContractError::new(
                    "flow-handoff-approval-intervention-mismatch",
                    "Approval-required Flow handoff requires exactly one current human review intervention",
                ));
            }
        }
        if self.reconciliation.state == FlowHandoffReconciliationState::Stale
            && !self
                .handoffs
                .iter()
                .any(|handoff| handoff.state == FlowProjectHandoffState::Stale)
        {
            return Err(ContractError::new(
                "flow-handoff-stale-without-stale-evidence",
                "Stale Flow handoff reconciliation requires a stale handoff record",
            ));
        }
        if self.reconciliation.state == FlowHandoffReconciliationState::Current
            && self
                .handoffs
                .iter()
                .any(|handoff| handoff.state == FlowProjectHandoffState::Stale)
        {
            return Err(ContractError::new(
                "flow-handoff-current-with-stale-evidence",
                "Current Flow handoff reconciliation cannot contain a stale handoff",
            ));
        }
        Ok(())
    }

    pub fn validate_against_context(
        &self,
        participation: &FlowProjectParticipationSnapshot,
        coordination: &FlowWorkCoordinationSnapshot,
        presence: &FlowProjectPresenceSnapshot,
    ) -> Result<(), ContractError> {
        self.validate()?;
        participation.validate()?;
        coordination.validate_against_participation(participation)?;
        presence.validate_against_context(participation, coordination)?;
        if self.project_id != participation.project_id
            || self.project_id != coordination.project_id
            || self.project_id != presence.project_id
            || self.project_revision != participation.project_revision
            || self.project_revision != coordination.project_revision
            || self.project_revision != presence.project_revision
            || self.application_revision != participation.application_revision
            || self.application_revision != coordination.application_revision
            || self.application_revision != presence.application_revision
        {
            return Err(ContractError::new(
                "flow-handoff-context-mismatch",
                "Flow handoffs, participation, work coordination, and presence must describe the same project revision",
            ));
        }

        let members = participation
            .members
            .iter()
            .map(|member| (member.membership_id.as_str(), member))
            .collect::<BTreeMap<_, _>>();
        let mandates = participation
            .agent_mandates
            .iter()
            .map(|mandate| (mandate.mandate_id.as_str(), mandate))
            .collect::<BTreeMap<_, _>>();
        let work = coordination
            .work
            .iter()
            .map(|item| (item.work_id.as_str(), item))
            .collect::<BTreeMap<_, _>>();
        let claims = coordination
            .claims
            .iter()
            .map(|claim| (claim.claim_id.as_str(), claim))
            .collect::<BTreeMap<_, _>>();
        let attachments = presence
            .host_attachments
            .iter()
            .map(|attachment| (attachment.attachment_id.as_str(), attachment))
            .collect::<BTreeMap<_, _>>();
        let sessions = presence
            .sessions
            .iter()
            .map(|session| (session.session_id.as_str(), session))
            .collect::<BTreeMap<_, _>>();
        let handoffs = self
            .handoffs
            .iter()
            .map(|handoff| (handoff.handoff_id.as_str(), handoff))
            .collect::<BTreeMap<_, _>>();

        for handoff in &self.handoffs {
            validate_request_actor(
                &handoff.source_actor,
                FlowAgentMandateCapability::HandoffRequest,
                &members,
                &mandates,
                &sessions,
            )?;
            if let Some(work_id) = handoff.work_id.as_deref() {
                work.get(work_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-handoff-work",
                        "Flow handoff work must exist in the exact coordination snapshot",
                    )
                })?;
            }
            if let Some(claim_id) = handoff.claim_id.as_deref() {
                let claim = claims.get(claim_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-handoff-claim",
                        "Flow handoff claim must exist in the exact coordination snapshot",
                    )
                })?;
                if handoff.work_id.as_deref() != Some(claim.work_id.as_str())
                    || claim.claimant_membership_id != handoff.source_actor.membership_id
                    || claim.agent_mandate_id != handoff.source_actor.agent_mandate_id
                    || !matches!(
                        claim.state,
                        FlowWorkClaimState::Proposed | FlowWorkClaimState::Active
                    )
                {
                    return Err(ContractError::new(
                        "flow-handoff-claim-context-mismatch",
                        "Flow handoff claim must match its work and exact current source actor",
                    ));
                }
            }
            validate_handoff_target(
                handoff,
                &members,
                &mandates,
                &attachments,
                &sessions,
            )?;
        }

        for intervention in &self.interventions {
            validate_request_actor(
                &intervention.raised_by,
                FlowAgentMandateCapability::InterventionRaise,
                &members,
                &mandates,
                &sessions,
            )?;
            for actor in [
                intervention.acknowledged_by_membership_id.as_deref(),
                intervention.decided_by_membership_id.as_deref(),
                intervention.resolved_by_membership_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                require_active_human_coordinator(actor, &members)?;
            }
            match intervention.subject_kind {
                FlowProjectInterventionSubjectKind::Project => {
                    if intervention.subject_id != self.project_id {
                        return Err(ContractError::new(
                            "flow-intervention-project-subject-mismatch",
                            "Flow project intervention must name the exact project",
                        ));
                    }
                }
                FlowProjectInterventionSubjectKind::Work => {
                    work.get(intervention.subject_id.as_str()).ok_or_else(|| {
                        ContractError::new(
                            "unknown-flow-intervention-work",
                            "Flow intervention work subject must exist in coordination",
                        )
                    })?;
                }
                FlowProjectInterventionSubjectKind::Claim => {
                    let claim = claims
                        .get(intervention.subject_id.as_str())
                        .ok_or_else(|| {
                            ContractError::new(
                                "unknown-flow-intervention-claim",
                                "Flow intervention claim subject must exist in coordination",
                            )
                        })?;
                    if intervention.kind == FlowProjectInterventionKind::StaleClaim
                        && claim.state != FlowWorkClaimState::Stale
                    {
                        return Err(ContractError::new(
                            "flow-stale-claim-intervention-without-stale-claim",
                            "Stale-claim intervention requires exact stale claim evidence",
                        ));
                    }
                }
                FlowProjectInterventionSubjectKind::Handoff => {
                    handoffs
                        .get(intervention.subject_id.as_str())
                        .ok_or_else(|| {
                            ContractError::new(
                                "unknown-flow-intervention-handoff",
                                "Flow intervention handoff subject must exist in its snapshot",
                            )
                        })?;
                }
                FlowProjectInterventionSubjectKind::Session => {
                    sessions
                        .get(intervention.subject_id.as_str())
                        .ok_or_else(|| {
                            ContractError::new(
                                "unknown-flow-intervention-session",
                                "Flow intervention session subject must exist in presence",
                            )
                        })?;
                }
                FlowProjectInterventionSubjectKind::HostAttachment => {
                    attachments
                        .get(intervention.subject_id.as_str())
                        .ok_or_else(|| {
                            ContractError::new(
                                "unknown-flow-intervention-host",
                                "Flow intervention host subject must exist in presence",
                            )
                        })?;
                }
                FlowProjectInterventionSubjectKind::ExternalEffect => {}
            }
            if matches!(
                intervention.kind,
                FlowProjectInterventionKind::Approval
                    | FlowProjectInterventionKind::HandoffReview
            ) && intervention.subject_kind != FlowProjectInterventionSubjectKind::Handoff
            {
                return Err(ContractError::new(
                    "flow-handoff-review-subject-mismatch",
                    "Approval and handoff-review interventions require an exact handoff subject",
                ));
            }
            if intervention.kind == FlowProjectInterventionKind::UncertainEffect
                && intervention.subject_kind
                    != FlowProjectInterventionSubjectKind::ExternalEffect
            {
                return Err(ContractError::new(
                    "flow-uncertain-effect-subject-mismatch",
                    "Uncertain-effect intervention requires an external-effect subject",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlowHandoffInterventionOperationId {
    #[serde(rename = "flow.project.handoffs.list")]
    HandoffsList,
    #[serde(rename = "flow.project.handoff.request")]
    HandoffRequest,
    #[serde(rename = "flow.project.handoff.decide")]
    HandoffDecide,
    #[serde(rename = "flow.project.handoff.observe")]
    HandoffObserve,
    #[serde(rename = "flow.project.handoff.cancel")]
    HandoffCancel,
    #[serde(rename = "flow.project.handoff.reconcile")]
    HandoffReconcile,
    #[serde(rename = "flow.project.interventions.list")]
    InterventionsList,
    #[serde(rename = "flow.project.intervention.raise")]
    InterventionRaise,
    #[serde(rename = "flow.project.intervention.acknowledge")]
    InterventionAcknowledge,
    #[serde(rename = "flow.project.intervention.decide")]
    InterventionDecide,
    #[serde(rename = "flow.project.intervention.resolve")]
    InterventionResolve,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowHandoffInterventionOperationScope {
    HandoffCollection,
    Handoff,
    InterventionCollection,
    Intervention,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowHandoffInterventionOperationIntent {
    Read,
    Manage,
    Observe,
    Reconcile,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowHandoffInterventionIdempotencyLaw {
    None,
    ExactRequest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowHandoffInterventionResultKind {
    HandoffPage,
    Handoff,
    InterventionPage,
    Intervention,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowHandoffInterventionOperationDescriptor {
    pub protocol: String,
    pub operation_id: FlowHandoffInterventionOperationId,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub scope: FlowHandoffInterventionOperationScope,
    pub intent: FlowHandoffInterventionOperationIntent,
    pub requires_project_id: bool,
    pub requires_entity_id: bool,
    pub requires_expected_project_revision: bool,
    pub idempotency: FlowHandoffInterventionIdempotencyLaw,
    pub result_kind: FlowHandoffInterventionResultKind,
    pub grants_application_authority: bool,
    pub deletes_durable_history: bool,
    pub repeats_transfer: bool,
    pub repeats_external_effects: bool,
}

impl FlowHandoffInterventionOperationDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_HANDOFF_INTERVENTION_OPERATION_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        if self.grants_application_authority
            || self.deletes_durable_history
            || self.repeats_transfer
            || self.repeats_external_effects
        {
            return Err(ContractError::new(
                "invalid-flow-handoff-operation-authority",
                "Flow handoff/intervention operations neither grant authority, delete history, repeat transfer, nor repeat effects",
            ));
        }
        if self != &canonical_operation(self.operation_id) {
            return Err(ContractError::new(
                "invalid-flow-handoff-intervention-operation",
                "Flow handoff/intervention operation metadata must match the closed catalogue",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowHandoffInterventionOperationCatalogue {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub operations: Vec<FlowHandoffInterventionOperationDescriptor>,
}

impl FlowHandoffInterventionOperationCatalogue {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_HANDOFF_INTERVENTION_OPERATION_CATALOGUE_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        let mut ids = BTreeSet::new();
        for operation in &self.operations {
            operation.validate()?;
            if !ids.insert(operation.operation_id) {
                return Err(ContractError::new(
                    "duplicate-flow-handoff-intervention-operation",
                    "Flow handoff/intervention operation identities must be unique",
                ));
            }
        }
        if self != &flow_handoff_intervention_operation_catalogue() {
            return Err(ContractError::new(
                "invalid-flow-handoff-intervention-operation-catalogue",
                "Flow handoff/intervention catalogue must match the exact current inventory",
            ));
        }
        Ok(())
    }
}

pub fn flow_handoff_intervention_operation_catalogue(
) -> FlowHandoffInterventionOperationCatalogue {
    FlowHandoffInterventionOperationCatalogue {
        protocol: FLOW_HANDOFF_INTERVENTION_OPERATION_CATALOGUE_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        operations: [
            FlowHandoffInterventionOperationId::HandoffsList,
            FlowHandoffInterventionOperationId::HandoffRequest,
            FlowHandoffInterventionOperationId::HandoffDecide,
            FlowHandoffInterventionOperationId::HandoffObserve,
            FlowHandoffInterventionOperationId::HandoffCancel,
            FlowHandoffInterventionOperationId::HandoffReconcile,
            FlowHandoffInterventionOperationId::InterventionsList,
            FlowHandoffInterventionOperationId::InterventionRaise,
            FlowHandoffInterventionOperationId::InterventionAcknowledge,
            FlowHandoffInterventionOperationId::InterventionDecide,
            FlowHandoffInterventionOperationId::InterventionResolve,
        ]
        .into_iter()
        .map(canonical_operation)
        .collect(),
    }
}

fn canonical_operation(
    operation_id: FlowHandoffInterventionOperationId,
) -> FlowHandoffInterventionOperationDescriptor {
    use FlowHandoffInterventionIdempotencyLaw::{ExactRequest, None};
    use FlowHandoffInterventionOperationIntent::{Manage, Observe, Read, Reconcile};
    use FlowHandoffInterventionOperationScope::{
        Handoff, HandoffCollection, Intervention, InterventionCollection,
    };
    use FlowHandoffInterventionResultKind::{
        Handoff as HandoffResult, HandoffPage, Intervention as InterventionResult,
        InterventionPage,
    };

    let (scope, intent, requires_entity_id, idempotency, result_kind) = match operation_id {
        FlowHandoffInterventionOperationId::HandoffsList => {
            (HandoffCollection, Read, false, None, HandoffPage)
        }
        FlowHandoffInterventionOperationId::HandoffRequest => (
            HandoffCollection,
            Manage,
            false,
            ExactRequest,
            HandoffResult,
        ),
        FlowHandoffInterventionOperationId::HandoffDecide
        | FlowHandoffInterventionOperationId::HandoffCancel => {
            (Handoff, Manage, true, ExactRequest, HandoffResult)
        }
        FlowHandoffInterventionOperationId::HandoffObserve => {
            (Handoff, Observe, true, ExactRequest, HandoffResult)
        }
        FlowHandoffInterventionOperationId::HandoffReconcile => {
            (Handoff, Reconcile, true, ExactRequest, HandoffResult)
        }
        FlowHandoffInterventionOperationId::InterventionsList => {
            (InterventionCollection, Read, false, None, InterventionPage)
        }
        FlowHandoffInterventionOperationId::InterventionRaise => (
            InterventionCollection,
            Manage,
            false,
            ExactRequest,
            InterventionResult,
        ),
        FlowHandoffInterventionOperationId::InterventionAcknowledge
        | FlowHandoffInterventionOperationId::InterventionDecide
        | FlowHandoffInterventionOperationId::InterventionResolve => (
            Intervention,
            Manage,
            true,
            ExactRequest,
            InterventionResult,
        ),
    };

    FlowHandoffInterventionOperationDescriptor {
        protocol: FLOW_HANDOFF_INTERVENTION_OPERATION_PROTOCOL.to_owned(),
        operation_id,
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        scope,
        intent,
        requires_project_id: true,
        requires_entity_id,
        requires_expected_project_revision: intent != Read,
        idempotency,
        result_kind,
        grants_application_authority: false,
        deletes_durable_history: false,
        repeats_transfer: false,
        repeats_external_effects: false,
    }
}

fn validate_request_actor<'a>(
    actor: &FlowProjectHandoffActor,
    required_capability: FlowAgentMandateCapability,
    members: &BTreeMap<&'a str, &'a crate::flow_participation::FlowProjectMember>,
    mandates: &BTreeMap<&'a str, &'a crate::flow_participation::FlowAgentMandate>,
    sessions: &BTreeMap<&'a str, &'a crate::flow_presence::FlowProjectSessionBinding>,
) -> Result<(), ContractError> {
    let member = members
        .get(actor.membership_id.as_str())
        .ok_or_else(|| {
            ContractError::new(
                "unknown-flow-handoff-actor",
                "Flow handoff/intervention actor must be a project member",
            )
        })?;
    if member.state != FlowProjectMemberState::Active {
        return Err(ContractError::new(
            "inactive-flow-handoff-actor",
            "Flow handoff/intervention requests require active membership",
        ));
    }
    match member.principal.kind {
        FlowProjectPrincipalKind::Person => {
            if actor.agent_mandate_id.is_some() {
                return Err(ContractError::new(
                    "person-flow-handoff-has-agent-mandate",
                    "Person handoff/intervention actor cannot reference an agent mandate",
                ));
            }
        }
        FlowProjectPrincipalKind::Agent => {
            let mandate_id = actor.agent_mandate_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "agent-flow-handoff-missing-mandate",
                    "Agent handoff/intervention actor requires an exact project mandate",
                )
            })?;
            let mandate = mandates.get(mandate_id).ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-handoff-mandate",
                    "Agent handoff/intervention mandate must exist in participation",
                )
            })?;
            if mandate.membership_id != member.membership_id
                || mandate.agent_id != member.principal.principal_id
                || mandate.state != FlowAgentMandateState::Active
                || !mandate.capabilities.contains(&required_capability)
            {
                return Err(ContractError::new(
                    "inactive-or-unauthorised-flow-handoff-agent",
                    "Agent handoff/intervention actor requires a matching active mandate capability",
                ));
            }
        }
    }
    if let Some(session_id) = actor.session_id.as_deref() {
        let session = sessions.get(session_id).ok_or_else(|| {
            ContractError::new(
                "unknown-flow-handoff-actor-session",
                "Flow handoff/intervention actor session must exist in presence",
            )
        })?;
        if session.membership_id != actor.membership_id
            || session.agent_mandate_id != actor.agent_mandate_id
            || session.presence_state != FlowSessionPresenceState::Connected
        {
            return Err(ContractError::new(
                "flow-handoff-actor-session-mismatch",
                "Flow handoff/intervention actor session must be connected and match the exact member and mandate",
            ));
        }
    }
    Ok(())
}

fn validate_handoff_target<'a>(
    handoff: &FlowProjectHandoff,
    members: &BTreeMap<&'a str, &'a crate::flow_participation::FlowProjectMember>,
    mandates: &BTreeMap<&'a str, &'a crate::flow_participation::FlowAgentMandate>,
    attachments: &BTreeMap<&'a str, &'a crate::flow_presence::FlowProjectHostAttachment>,
    sessions: &BTreeMap<&'a str, &'a crate::flow_presence::FlowProjectSessionBinding>,
) -> Result<(), ContractError> {
    match handoff.target.kind {
        FlowProjectHandoffTargetKind::Membership => {
            let member = members
                .get(handoff.target.target_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-handoff-target-member",
                        "Flow handoff target membership must exist in participation",
                    )
                })?;
            if member.state != FlowProjectMemberState::Active
                || member.membership_id == handoff.source_actor.membership_id
            {
                return Err(ContractError::new(
                    "invalid-flow-handoff-target-member",
                    "Flow handoff target membership must be active and distinct from the source",
                ));
            }
        }
        FlowProjectHandoffTargetKind::AgentMandate => {
            let mandate = mandates
                .get(handoff.target.target_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-handoff-target-mandate",
                        "Flow handoff target mandate must exist in participation",
                    )
                })?;
            let member = members
                .get(mandate.membership_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "orphaned-flow-handoff-target-mandate",
                        "Flow handoff target mandate must retain its project membership",
                    )
                })?;
            if mandate.state != FlowAgentMandateState::Active
                || member.state != FlowProjectMemberState::Active
                || handoff.source_actor.agent_mandate_id.as_deref()
                    == Some(mandate.mandate_id.as_str())
            {
                return Err(ContractError::new(
                    "invalid-flow-handoff-target-mandate",
                    "Flow handoff target mandate must be active and distinct from the source",
                ));
            }
        }
        FlowProjectHandoffTargetKind::HostAttachment => {
            let attachment = attachments
                .get(handoff.target.target_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-handoff-target-host",
                        "Flow handoff target host attachment must exist in presence",
                    )
                })?;
            if handoff.state.requires_ready_target()
                && (attachment.state != FlowProjectHostAttachmentState::Attached
                    || !matches!(
                        attachment.observation_state,
                        FlowHostObservationState::Ready | FlowHostObservationState::Degraded
                    ))
            {
                return Err(ContractError::new(
                    "unavailable-flow-handoff-target-host",
                    "Ready or later Flow handoff requires an attached ready or degraded target host",
                ));
            }
        }
        FlowProjectHandoffTargetKind::Session => {
            let session = sessions
                .get(handoff.target.target_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-handoff-target-session",
                        "Flow handoff target session must exist in presence",
                    )
                })?;
            if handoff.state.requires_ready_target()
                && session.presence_state != FlowSessionPresenceState::Connected
            {
                return Err(ContractError::new(
                    "unavailable-flow-handoff-target-session",
                    "Ready or later Flow handoff requires a connected target session",
                ));
            }
            if matches!(
                session.presence_state,
                FlowSessionPresenceState::Closed | FlowSessionPresenceState::Revoked
            ) {
                return Err(ContractError::new(
                    "terminal-flow-handoff-target-session",
                    "Flow handoff cannot target a closed or revoked session",
                ));
            }
            if session.membership_id == handoff.source_actor.membership_id
                && handoff.source_actor.session_id.as_deref() == Some(session.session_id.as_str())
            {
                return Err(ContractError::new(
                    "self-targeted-flow-handoff-session",
                    "Flow handoff cannot target its exact source session",
                ));
            }
        }
        FlowProjectHandoffTargetKind::Application => {}
    }
    Ok(())
}

fn require_active_human_coordinator<'a>(
    membership_id: &str,
    members: &BTreeMap<&'a str, &'a crate::flow_participation::FlowProjectMember>,
) -> Result<(), ContractError> {
    let member = members.get(membership_id).ok_or_else(|| {
        ContractError::new(
            "unknown-flow-intervention-human-actor",
            "Flow intervention human actor must be a project member",
        )
    })?;
    if member.state != FlowProjectMemberState::Active
        || member.principal.kind != FlowProjectPrincipalKind::Person
        || !matches!(
            member.role,
            FlowProjectMemberRole::Owner | FlowProjectMemberRole::Coordinator
        )
    {
        return Err(ContractError::new(
            "invalid-flow-intervention-human-actor",
            "Flow intervention acknowledgement, decision, and resolution require an active human owner or coordinator",
        ));
    }
    Ok(())
}

fn required_excluded_authority() -> BTreeSet<FlowExcludedAuthority> {
    BTreeSet::from([
        FlowExcludedAuthority::ApplicationAuthority,
        FlowExcludedAuthority::ProjectMembership,
        FlowExcludedAuthority::AgentMandate,
        FlowExcludedAuthority::ProviderCredentials,
        FlowExcludedAuthority::HostWideAuthority,
        FlowExcludedAuthority::WorkRuntimeState,
        FlowExcludedAuthority::ExternalEffectAuthority,
    ])
}

fn terminal_evidence_matches(
    handoff: &FlowProjectHandoff,
    code: FlowProjectHandoffTerminalCode,
    before_acceptance_only: bool,
) -> bool {
    handoff.terminal_at_unix_ms.is_some()
        && handoff.terminal_code == Some(code)
        && handoff.completed_at_unix_ms.is_none()
        && handoff.stale_at_unix_ms.is_none()
        && handoff.stale_reason.is_none()
        && (!before_acceptance_only
            || (handoff.accepted_at_unix_ms.is_none()
                && handoff.transfer_started_at_unix_ms.is_none()
                && handoff.received_at_unix_ms.is_none()))
}

fn suite_state_matches(flow: FlowProjectHandoffState, suite: SuiteHandoffState) -> bool {
    matches!(
        (flow, suite),
        (FlowProjectHandoffState::Prepared, SuiteHandoffState::Prepared)
            | (
                FlowProjectHandoffState::ApprovalRequired,
                SuiteHandoffState::ApprovalRequired
            )
            | (FlowProjectHandoffState::Ready, SuiteHandoffState::Ready)
            | (FlowProjectHandoffState::Accepted, SuiteHandoffState::Accepted)
            | (
                FlowProjectHandoffState::Transferring,
                SuiteHandoffState::Importing | SuiteHandoffState::Creating
            )
            | (FlowProjectHandoffState::Completed, SuiteHandoffState::Completed)
            | (FlowProjectHandoffState::Partial, SuiteHandoffState::Partial)
            | (FlowProjectHandoffState::Rejected, SuiteHandoffState::Rejected)
            | (FlowProjectHandoffState::Cancelled, SuiteHandoffState::Cancelled)
            | (FlowProjectHandoffState::Failed, SuiteHandoffState::Failed)
    )
}

fn same_application_handoff_request(
    existing: Option<&HandoffEnvelope>,
    candidate: Option<&HandoffEnvelope>,
) -> bool {
    match (existing, candidate) {
        (None, None) => true,
        (Some(existing), Some(candidate)) => {
            existing.idempotency_key == candidate.idempotency_key
                && existing.source == candidate.source
                && existing.target_application_id == candidate.target_application_id
                && existing.target_application_revision == candidate.target_application_revision
                && existing.target_owner_kind == candidate.target_owner_kind
                && existing.target_owner_id == candidate.target_owner_id
                && existing.operation == candidate.operation
                && existing.expected_result_kind == candidate.expected_result_kind
                && existing.request_digest == candidate.request_digest
        }
        _ => false,
    }
}

fn validate_intervention_subject(
    kind: FlowProjectInterventionSubjectKind,
    subject_id: &str,
) -> Result<(), ContractError> {
    let prefix = match kind {
        FlowProjectInterventionSubjectKind::Project => "project/",
        FlowProjectInterventionSubjectKind::Work => "work/",
        FlowProjectInterventionSubjectKind::Claim => "claim/",
        FlowProjectInterventionSubjectKind::Handoff => "handoff/",
        FlowProjectInterventionSubjectKind::Session => "session/",
        FlowProjectInterventionSubjectKind::HostAttachment => "attachment/",
        FlowProjectInterventionSubjectKind::ExternalEffect => "effect/",
    };
    validate_scoped_identifier(
        subject_id,
        prefix,
        MAX_TARGET_ID_BYTES,
        "invalid-flow-intervention-subject",
    )
}

fn intervention_kind_requires_decision(kind: FlowProjectInterventionKind) -> bool {
    matches!(
        kind,
        FlowProjectInterventionKind::Approval
            | FlowProjectInterventionKind::UncertainEffect
            | FlowProjectInterventionKind::HandoffReview
            | FlowProjectInterventionKind::Divergence
    )
}

fn validate_optional_actor_pair(
    timestamp: Option<u64>,
    actor: Option<&str>,
    code: &'static str,
) -> Result<(), ContractError> {
    if timestamp.is_some() == actor.is_some() {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow intervention timestamp and actor evidence must appear together",
        ))
    }
}

fn validate_optional_decision(intervention: &FlowProjectIntervention) -> Result<(), ContractError> {
    let fields = (
        intervention.decision.is_some(),
        intervention.decided_at_unix_ms.is_some(),
        intervention.decided_by_membership_id.is_some(),
    );
    if matches!(fields, (false, false, false) | (true, true, true)) {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-intervention-decision-evidence-mismatch",
            "Flow intervention decision, time, and human actor must appear together",
        ))
    }
}

fn validate_optional_resolution(
    intervention: &FlowProjectIntervention,
) -> Result<(), ContractError> {
    let fields = (
        intervention.resolution_reference.is_some(),
        intervention.resolved_at_unix_ms.is_some(),
        intervention.resolved_by_membership_id.is_some(),
    );
    if matches!(fields, (false, false, false) | (true, true, true)) {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-intervention-resolution-evidence-mismatch",
            "Flow intervention resolution reference, time, and human actor must appear together",
        ))
    }
}

fn ordered_optional_times(times: &[Option<u64>]) -> bool {
    let mut previous = None;
    for timestamp in times.iter().flatten() {
        if previous.is_some_and(|value| *timestamp < value) {
            return false;
        }
        previous = Some(*timestamp);
    }
    true
}

fn require_record_membership(
    project_id: &str,
    application_revision: &str,
    record_project_id: &str,
    record_application_revision: &str,
    code: &'static str,
) -> Result<(), ContractError> {
    if project_id == record_project_id && application_revision == record_application_revision {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow record belongs to a different project or application revision",
        ))
    }
}

fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-handoff-protocol-mismatch",
            "Flow handoff/intervention record uses an unsupported protocol",
        ))
    }
}

fn require_flow_application(
    application_id: CurrentApplicationId,
    application_revision: &str,
) -> Result<(), ContractError> {
    if application_id != CurrentApplicationId::Flow {
        return Err(ContractError::new(
            "invalid-flow-handoff-application",
            "Flow handoff/intervention records must be owned by the current Flow application",
        ));
    }
    if application_revision != CURRENT_SUITE_REVISION {
        return Err(ContractError::new(
            "flow-handoff-application-revision-mismatch",
            "Flow handoff/intervention records require the exact current application revision",
        ));
    }
    Ok(())
}

fn require_positive_revision(revision: u64, code: &'static str) -> Result<(), ContractError> {
    if revision > 0 {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow handoff/intervention revision must be positive",
        ))
    }
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
        Err(ContractError::new(
            code,
            "Flow handoff/intervention scoped identity is invalid",
        ))
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
            "invalid-flow-handoff-digest",
            "Flow handoff digest must be a lowercase SHA-256 digest",
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
            "Flow handoff/intervention text is outside its byte bound",
        ))
    }
}

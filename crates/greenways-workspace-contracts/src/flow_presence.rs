use crate::error::ContractError;
use crate::flow_participation::{
    FlowAgentMandateState, FlowProjectMemberRole, FlowProjectMemberState,
    FlowProjectParticipationSnapshot, FlowProjectPrincipalKind,
};
use crate::flow_work_coordination::{FlowWorkClaimState, FlowWorkCoordinationSnapshot};
use crate::suite::{CurrentApplicationId, CURRENT_SUITE_REVISION};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const FLOW_PROJECT_PRESENCE_PROTOCOL: &str =
    "greenways.flow.project-presence/0-alpha";
pub const FLOW_PROJECT_HOST_ATTACHMENT_PROTOCOL: &str =
    "greenways.flow.project-host-attachment/0-alpha";
pub const FLOW_PROJECT_SESSION_BINDING_PROTOCOL: &str =
    "greenways.flow.project-session-binding/0-alpha";
pub const FLOW_PRESENCE_RECONCILIATION_PROTOCOL: &str =
    "greenways.flow.presence-reconciliation/0-alpha";
pub const FLOW_PRESENCE_OPERATION_PROTOCOL: &str =
    "greenways.flow.presence-operation/0-alpha";
pub const FLOW_PRESENCE_OPERATION_CATALOGUE_PROTOCOL: &str =
    "greenways.flow.presence-operation-catalogue/0-alpha";

pub const FLOW_PROJECT_HOSTS_LIST_OPERATION: &str = "flow.project.hosts.list";
pub const FLOW_PROJECT_HOST_ATTACH_OPERATION: &str = "flow.project.host.attach";
pub const FLOW_PROJECT_HOST_OBSERVE_OPERATION: &str = "flow.project.host.observe";
pub const FLOW_PROJECT_HOST_DETACH_OPERATION: &str = "flow.project.host.detach";
pub const FLOW_PROJECT_SESSIONS_LIST_OPERATION: &str = "flow.project.sessions.list";
pub const FLOW_PROJECT_SESSION_ATTACH_OPERATION: &str = "flow.project.session.attach";
pub const FLOW_PROJECT_SESSION_OBSERVE_OPERATION: &str = "flow.project.session.observe";
pub const FLOW_PROJECT_SESSION_DISCONNECT_OPERATION: &str =
    "flow.project.session.disconnect";
pub const FLOW_PROJECT_SESSION_RECONCILE_OPERATION: &str =
    "flow.project.session.reconcile";

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_ATTACHMENT_ID_BYTES: usize = 256;
const MAX_HOST_ID_BYTES: usize = 256;
const MAX_SESSION_ID_BYTES: usize = 256;
const MAX_MEMBERSHIP_ID_BYTES: usize = 256;
const MAX_MANDATE_ID_BYTES: usize = 256;
const MAX_WORK_ID_BYTES: usize = 256;
const MAX_CLAIM_ID_BYTES: usize = 256;
const MAX_RECONCILIATION_ID_BYTES: usize = 256;
const MAX_HOST_ATTACHMENTS: usize = 256;
const MAX_SESSION_BINDINGS: usize = 1024;
const MAX_HOST_CAPABILITIES: usize = 16;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHostKind {
    Desktop,
    Cli,
    Browser,
    Api,
    Mcp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHostAttachmentState {
    Attached,
    Stale,
    Detached,
    Revoked,
    Expired,
}

impl FlowProjectHostAttachmentState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Attached,
                Self::Stale | Self::Detached | Self::Revoked | Self::Expired
            ) | (
                Self::Stale,
                Self::Attached | Self::Detached | Self::Revoked | Self::Expired
            )
        )
    }

    const fn is_current(self) -> bool {
        matches!(self, Self::Attached | Self::Stale)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowHostObservationState {
    Unknown,
    Offline,
    Connecting,
    Ready,
    Degraded,
    Draining,
    Stale,
    Revoked,
}

impl FlowHostObservationState {
    const fn can_carry_connected_session(self) -> bool {
        matches!(self, Self::Ready | Self::Degraded)
    }

    const fn requires_observation(self) -> bool {
        !matches!(self, Self::Unknown)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectHostCapability {
    ProjectRead,
    WorkRead,
    ClaimRead,
    SessionAttach,
    SessionObserve,
    SessionDisconnect,
    SessionReconcile,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectHostAttachment {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub attachment_id: String,
    pub revision: u64,
    pub host_id: String,
    pub host_generation: u64,
    pub host_kind: FlowProjectHostKind,
    pub state: FlowProjectHostAttachmentState,
    pub observation_state: FlowHostObservationState,
    pub observation_generation: u64,
    pub capability_revision: u64,
    pub capability_root: Option<String>,
    pub capabilities: Vec<FlowProjectHostCapability>,
    pub attached_by_membership_id: String,
    pub attached_at_unix_ms: u64,
    pub last_observed_at_unix_ms: Option<u64>,
    pub expires_at_unix_ms: Option<u64>,
    pub detached_at_unix_ms: Option<u64>,
    pub revoked_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
    pub exposes_host_wide_authority: bool,
    pub grants_execution_lease: bool,
}

impl FlowProjectHostAttachment {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_HOST_ATTACHMENT_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.attachment_id,
            "attachment/",
            MAX_ATTACHMENT_ID_BYTES,
            "invalid-flow-host-attachment-id",
        )?;
        validate_scoped_identifier(
            &self.host_id,
            "host/",
            MAX_HOST_ID_BYTES,
            "invalid-flow-host-id",
        )?;
        validate_scoped_identifier(
            &self.attached_by_membership_id,
            "membership/",
            MAX_MEMBERSHIP_ID_BYTES,
            "invalid-flow-membership-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-host-attachment-revision")?;
        require_positive_revision(self.host_generation, "invalid-flow-host-generation")?;
        require_positive_revision(
            self.observation_generation,
            "invalid-flow-host-observation-generation",
        )?;
        require_positive_revision(
            self.capability_revision,
            "invalid-flow-host-capability-revision",
        )?;
        if self.capabilities.is_empty()
            || self.capabilities.len() > MAX_HOST_CAPABILITIES
            || self.capabilities.iter().collect::<BTreeSet<_>>().len()
                != self.capabilities.len()
        {
            return Err(ContractError::new(
                "invalid-flow-host-capabilities",
                "Flow project host capabilities must be bounded, non-empty, and unique",
            ));
        }
        if let Some(root) = &self.capability_root {
            validate_digest(root)?;
        }
        if self.attached_at_unix_ms == 0
            || self
                .last_observed_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
            || self
                .expires_at_unix_ms
                .is_some_and(|value| value <= self.attached_at_unix_ms)
            || self
                .detached_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
            || self
                .revoked_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
        {
            return Err(ContractError::new(
                "invalid-flow-host-attachment-time",
                "Flow project host attachment timestamps must be positive and monotonic",
            ));
        }
        if self.observation_state.requires_observation()
            != self.last_observed_at_unix_ms.is_some()
        {
            return Err(ContractError::new(
                "flow-host-observation-time-mismatch",
                "Observed Flow host states require matching observation evidence",
            ));
        }
        let evidence_matches_state = match self.state {
            FlowProjectHostAttachmentState::Attached => {
                self.detached_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
                    && self.observation_state != FlowHostObservationState::Revoked
            }
            FlowProjectHostAttachmentState::Stale => {
                self.detached_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
                    && self.observation_state == FlowHostObservationState::Stale
            }
            FlowProjectHostAttachmentState::Detached => {
                self.detached_at_unix_ms.is_some()
                    && self.revoked_at_unix_ms.is_none()
                    && matches!(
                        self.observation_state,
                        FlowHostObservationState::Unknown | FlowHostObservationState::Offline
                    )
            }
            FlowProjectHostAttachmentState::Revoked => {
                self.revoked_at_unix_ms.is_some()
                    && self.detached_at_unix_ms.is_none()
                    && self.observation_state == FlowHostObservationState::Revoked
            }
            FlowProjectHostAttachmentState::Expired => {
                self.expires_at_unix_ms.is_some()
                    && self.detached_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
                    && matches!(
                        self.observation_state,
                        FlowHostObservationState::Unknown
                            | FlowHostObservationState::Offline
                            | FlowHostObservationState::Stale
                    )
            }
        };
        if !evidence_matches_state {
            return Err(ContractError::new(
                "flow-host-attachment-state-evidence-mismatch",
                "Flow project host attachment state requires matching lifecycle evidence",
            ));
        }
        if self.authority_transfer
            || self.exposes_host_wide_authority
            || self.grants_execution_lease
        {
            return Err(ContractError::new(
                "flow-host-attachment-authority-expansion",
                "Project host attachment neither transfers authority, exposes host-wide state, nor grants execution",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowSessionPresenceState {
    Unknown,
    Attached,
    Connected,
    Disconnected,
    Stale,
    Closed,
    Revoked,
}

impl FlowSessionPresenceState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Unknown,
                Self::Attached
                    | Self::Connected
                    | Self::Disconnected
                    | Self::Stale
                    | Self::Closed
                    | Self::Revoked
            ) | (
                Self::Attached,
                Self::Connected
                    | Self::Disconnected
                    | Self::Stale
                    | Self::Closed
                    | Self::Revoked
            ) | (
                Self::Connected,
                Self::Disconnected | Self::Stale | Self::Closed | Self::Revoked
            ) | (
                Self::Disconnected,
                Self::Connected | Self::Stale | Self::Closed | Self::Revoked
            ) | (
                Self::Stale,
                Self::Connected | Self::Disconnected | Self::Closed | Self::Revoked
            )
        )
    }

    const fn is_current_binding(self) -> bool {
        !matches!(self, Self::Closed | Self::Revoked)
    }

    const fn requires_unknown_activity(self) -> bool {
        !matches!(self, Self::Connected)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowSessionActivityState {
    Unknown,
    Idle,
    Generating,
    WaitingForUser,
    ResponseReady,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectSessionBinding {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub session_id: String,
    pub revision: u64,
    pub session_generation: u64,
    pub observation_generation: u64,
    pub host_attachment_id: String,
    pub membership_id: String,
    pub agent_mandate_id: Option<String>,
    pub work_id: Option<String>,
    pub claim_id: Option<String>,
    pub presence_state: FlowSessionPresenceState,
    pub activity_state: FlowSessionActivityState,
    pub attached_at_unix_ms: u64,
    pub last_observed_at_unix_ms: Option<u64>,
    pub disconnected_at_unix_ms: Option<u64>,
    pub stale_at_unix_ms: Option<u64>,
    pub closed_at_unix_ms: Option<u64>,
    pub revoked_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
    pub carries_provider_credentials: bool,
    pub carries_private_provider_reference: bool,
    pub copies_work_runtime_state: bool,
    pub mutates_work_outcome: bool,
}

impl FlowProjectSessionBinding {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_SESSION_BINDING_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.session_id,
            "session/",
            MAX_SESSION_ID_BYTES,
            "invalid-flow-session-id",
        )?;
        validate_scoped_identifier(
            &self.host_attachment_id,
            "attachment/",
            MAX_ATTACHMENT_ID_BYTES,
            "invalid-flow-host-attachment-id",
        )?;
        validate_scoped_identifier(
            &self.membership_id,
            "membership/",
            MAX_MEMBERSHIP_ID_BYTES,
            "invalid-flow-membership-id",
        )?;
        if let Some(mandate_id) = &self.agent_mandate_id {
            validate_scoped_identifier(
                mandate_id,
                "mandate/",
                MAX_MANDATE_ID_BYTES,
                "invalid-flow-mandate-id",
            )?;
        }
        if let Some(work_id) = &self.work_id {
            validate_scoped_identifier(
                work_id,
                "work/",
                MAX_WORK_ID_BYTES,
                "invalid-flow-work-id",
            )?;
        }
        if let Some(claim_id) = &self.claim_id {
            validate_scoped_identifier(
                claim_id,
                "claim/",
                MAX_CLAIM_ID_BYTES,
                "invalid-flow-claim-id",
            )?;
            if self.work_id.is_none() {
                return Err(ContractError::new(
                    "flow-session-claim-without-work",
                    "A Flow session claim binding requires an exact work identity",
                ));
            }
        }
        require_positive_revision(self.revision, "invalid-flow-session-revision")?;
        require_positive_revision(
            self.session_generation,
            "invalid-flow-session-generation",
        )?;
        require_positive_revision(
            self.observation_generation,
            "invalid-flow-session-observation-generation",
        )?;
        if self.attached_at_unix_ms == 0
            || self
                .last_observed_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
            || self
                .disconnected_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
            || self
                .stale_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
            || self
                .closed_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
            || self
                .revoked_at_unix_ms
                .is_some_and(|value| value < self.attached_at_unix_ms)
        {
            return Err(ContractError::new(
                "invalid-flow-session-time",
                "Flow project session timestamps must be positive and monotonic",
            ));
        }
        if self.presence_state.requires_unknown_activity()
            && self.activity_state != FlowSessionActivityState::Unknown
        {
            return Err(ContractError::new(
                "flow-session-activity-without-connected-presence",
                "Only a connected Flow session may expose current activity",
            ));
        }
        let evidence_matches_state = match self.presence_state {
            FlowSessionPresenceState::Unknown => {
                self.disconnected_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.closed_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowSessionPresenceState::Attached => {
                self.last_observed_at_unix_ms.is_none()
                    && self.disconnected_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.closed_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowSessionPresenceState::Connected => {
                self.last_observed_at_unix_ms.is_some()
                    && self.disconnected_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.closed_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowSessionPresenceState::Disconnected => {
                self.last_observed_at_unix_ms.is_some()
                    && self.disconnected_at_unix_ms.is_some()
                    && self.stale_at_unix_ms.is_none()
                    && self.closed_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowSessionPresenceState::Stale => {
                self.last_observed_at_unix_ms.is_some()
                    && self.disconnected_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_some()
                    && self.closed_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowSessionPresenceState::Closed => {
                self.closed_at_unix_ms.is_some() && self.revoked_at_unix_ms.is_none()
            }
            FlowSessionPresenceState::Revoked => {
                self.revoked_at_unix_ms.is_some() && self.closed_at_unix_ms.is_none()
            }
        };
        if !evidence_matches_state {
            return Err(ContractError::new(
                "flow-session-state-evidence-mismatch",
                "Flow session presence state requires matching observation or terminal evidence",
            ));
        }
        if self.authority_transfer
            || self.carries_provider_credentials
            || self.carries_private_provider_reference
            || self.copies_work_runtime_state
            || self.mutates_work_outcome
        {
            return Err(ContractError::new(
                "flow-session-authority-or-state-expansion",
                "Flow session bindings carry no credentials, provider references, authority, Work state, or work outcome mutation",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowPresenceReconciliationState {
    Current,
    Stale,
    Divergent,
    ResyncRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowPresenceReconciliation {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub reconciliation_id: String,
    pub generation: u64,
    pub previous_generation: Option<u64>,
    pub state: FlowPresenceReconciliationState,
    pub started_at_unix_ms: u64,
    pub completed_at_unix_ms: u64,
    pub repeats_provider_work: bool,
    pub repeats_external_effects: bool,
    pub mutates_work_outcome: bool,
    pub authority_transfer: bool,
}

impl FlowPresenceReconciliation {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PRESENCE_RECONCILIATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.reconciliation_id,
            "reconciliation/",
            MAX_RECONCILIATION_ID_BYTES,
            "invalid-flow-reconciliation-id",
        )?;
        require_positive_revision(
            self.generation,
            "invalid-flow-presence-reconciliation-generation",
        )?;
        if self
            .previous_generation
            .is_some_and(|value| value == 0 || value >= self.generation)
        {
            return Err(ContractError::new(
                "invalid-flow-presence-previous-generation",
                "Flow presence reconciliation previous generation must be positive and earlier",
            ));
        }
        if self.started_at_unix_ms == 0
            || self.completed_at_unix_ms < self.started_at_unix_ms
        {
            return Err(ContractError::new(
                "invalid-flow-presence-reconciliation-time",
                "Flow presence reconciliation timestamps must be positive and monotonic",
            ));
        }
        if self.repeats_provider_work
            || self.repeats_external_effects
            || self.mutates_work_outcome
            || self.authority_transfer
        {
            return Err(ContractError::new(
                "flow-presence-reconciliation-side-effect",
                "Flow presence reconciliation updates evidence only and cannot repeat work, effects, authority, or outcomes",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectPresenceSnapshot {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub project_revision: u64,
    pub snapshot_generation: u64,
    pub observed_at_unix_ms: u64,
    pub reconciliation: FlowPresenceReconciliation,
    pub host_attachments: Vec<FlowProjectHostAttachment>,
    pub sessions: Vec<FlowProjectSessionBinding>,
}

impl FlowProjectPresenceSnapshot {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_PRESENCE_PROTOCOL)?;
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
            "invalid-flow-presence-snapshot-generation",
        )?;
        if self.observed_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-presence-observation-time",
                "Flow project presence observation time must be positive",
            ));
        }
        if self.host_attachments.len() > MAX_HOST_ATTACHMENTS
            || self.sessions.len() > MAX_SESSION_BINDINGS
        {
            return Err(ContractError::new(
                "flow-presence-collection-limit",
                "Flow project presence collections exceed their bounds",
            ));
        }
        self.reconciliation.validate()?;
        require_record_membership(
            &self.project_id,
            &self.application_revision,
            &self.reconciliation.project_id,
            &self.reconciliation.application_revision,
            "flow-presence-reconciliation-project-mismatch",
        )?;
        if self.reconciliation.generation != self.snapshot_generation
            || self.reconciliation.completed_at_unix_ms > self.observed_at_unix_ms
        {
            return Err(ContractError::new(
                "flow-presence-reconciliation-snapshot-mismatch",
                "Flow presence reconciliation must describe the exact snapshot generation",
            ));
        }

        let mut attachments_by_id = BTreeMap::new();
        let mut current_hosts = BTreeSet::new();
        for attachment in &self.host_attachments {
            attachment.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &attachment.project_id,
                &attachment.application_revision,
                "flow-host-attachment-project-mismatch",
            )?;
            if attachment.observation_generation > self.snapshot_generation {
                return Err(ContractError::new(
                    "future-flow-host-observation",
                    "Flow host observation generation cannot exceed its snapshot",
                ));
            }
            if attachment.state.is_current()
                && attachment
                    .expires_at_unix_ms
                    .is_some_and(|value| value <= self.observed_at_unix_ms)
            {
                return Err(ContractError::new(
                    "expired-current-flow-host-attachment",
                    "Current Flow host attachment cannot be expired at observation time",
                ));
            }
            if attachments_by_id
                .insert(attachment.attachment_id.as_str(), attachment)
                .is_some()
            {
                return Err(ContractError::new(
                    "duplicate-flow-host-attachment-id",
                    "Flow host attachment identities must be unique",
                ));
            }
            if attachment.state.is_current()
                && !current_hosts.insert(attachment.host_id.as_str())
            {
                return Err(ContractError::new(
                    "duplicate-current-flow-host",
                    "One Flow project may have only one current attachment per host identity",
                ));
            }
        }

        let mut session_generations = BTreeSet::new();
        let mut current_sessions = BTreeSet::new();
        for session in &self.sessions {
            session.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &session.project_id,
                &session.application_revision,
                "flow-session-project-mismatch",
            )?;
            if session.observation_generation > self.snapshot_generation {
                return Err(ContractError::new(
                    "future-flow-session-observation",
                    "Flow session observation generation cannot exceed its snapshot",
                ));
            }
            if !session_generations
                .insert((session.session_id.as_str(), session.session_generation))
            {
                return Err(ContractError::new(
                    "duplicate-flow-session-generation",
                    "Flow session generations must be unique",
                ));
            }
            if session.presence_state.is_current_binding()
                && !current_sessions.insert(session.session_id.as_str())
            {
                return Err(ContractError::new(
                    "duplicate-current-flow-session",
                    "One Flow session identity may have only one current binding",
                ));
            }
            let attachment = attachments_by_id
                .get(session.host_attachment_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-session-host-attachment",
                        "Flow session binding must reference a host attachment in its snapshot",
                    )
                })?;
            if session.presence_state.is_current_binding() && !attachment.state.is_current() {
                return Err(ContractError::new(
                    "current-flow-session-on-terminal-host",
                    "Current Flow session binding requires a current project host attachment",
                ));
            }
            if session.presence_state == FlowSessionPresenceState::Connected
                && !attachment.observation_state.can_carry_connected_session()
            {
                return Err(ContractError::new(
                    "connected-flow-session-on-unavailable-host",
                    "Connected Flow session requires a ready or degraded observed host",
                ));
            }
        }

        if self.reconciliation.state == FlowPresenceReconciliationState::Stale
            && !self.host_attachments.iter().any(|attachment| {
                attachment.state == FlowProjectHostAttachmentState::Stale
                    || matches!(
                        attachment.observation_state,
                        FlowHostObservationState::Unknown | FlowHostObservationState::Stale
                    )
            })
            && !self.sessions.iter().any(|session| {
                matches!(
                    session.presence_state,
                    FlowSessionPresenceState::Unknown | FlowSessionPresenceState::Stale
                )
            })
        {
            return Err(ContractError::new(
                "flow-presence-stale-without-stale-evidence",
                "Stale Flow reconciliation requires stale or unknown host/session evidence",
            ));
        }
        Ok(())
    }

    pub fn validate_against_context(
        &self,
        participation: &FlowProjectParticipationSnapshot,
        coordination: &FlowWorkCoordinationSnapshot,
    ) -> Result<(), ContractError> {
        self.validate()?;
        participation.validate()?;
        coordination.validate()?;
        if self.project_id != participation.project_id
            || self.project_id != coordination.project_id
            || self.project_revision != participation.project_revision
            || self.project_revision != coordination.project_revision
            || self.application_revision != participation.application_revision
            || self.application_revision != coordination.application_revision
        {
            return Err(ContractError::new(
                "flow-presence-context-mismatch",
                "Flow presence, participation, and work coordination must describe the same project revision",
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

        for attachment in &self.host_attachments {
            let actor = members
                .get(attachment.attached_by_membership_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-host-attachment-actor",
                        "Flow project host attachment actor must be a project member",
                    )
                })?;
            if attachment.state.is_current()
                && (actor.state != FlowProjectMemberState::Active
                    || actor.principal.kind != FlowProjectPrincipalKind::Person
                    || !matches!(
                        actor.role,
                        FlowProjectMemberRole::Owner | FlowProjectMemberRole::Coordinator
                    ))
            {
                return Err(ContractError::new(
                    "invalid-flow-host-attachment-actor",
                    "Current Flow host attachment requires an active human owner or coordinator",
                ));
            }
        }

        for session in &self.sessions {
            let member = members.get(session.membership_id.as_str()).ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-session-member",
                    "Flow session binding must reference a project membership",
                )
            })?;
            if session.presence_state.is_current_binding()
                && member.state != FlowProjectMemberState::Active
            {
                return Err(ContractError::new(
                    "inactive-flow-session-member",
                    "Current Flow session binding requires active project membership",
                ));
            }

            match member.principal.kind {
                FlowProjectPrincipalKind::Person => {
                    if session.agent_mandate_id.is_some() {
                        return Err(ContractError::new(
                            "person-flow-session-has-agent-mandate",
                            "A person session cannot reference an agent mandate",
                        ));
                    }
                }
                FlowProjectPrincipalKind::Agent => {
                    let mandate_id = session.agent_mandate_id.as_deref().ok_or_else(|| {
                        ContractError::new(
                            "agent-flow-session-missing-mandate",
                            "An agent session requires an exact project mandate",
                        )
                    })?;
                    let mandate = mandates.get(mandate_id).ok_or_else(|| {
                        ContractError::new(
                            "unknown-flow-session-mandate",
                            "Flow agent session mandate must exist in project participation",
                        )
                    })?;
                    if mandate.membership_id != member.membership_id
                        || mandate.agent_id != member.principal.principal_id
                    {
                        return Err(ContractError::new(
                            "flow-session-mandate-principal-mismatch",
                            "Flow session mandate must match the exact agent membership",
                        ));
                    }
                    if session.presence_state.is_current_binding()
                        && mandate.state != FlowAgentMandateState::Active
                    {
                        return Err(ContractError::new(
                            "inactive-flow-session-mandate",
                            "Current Flow agent session requires an active project mandate",
                        ));
                    }
                }
            }

            if let Some(work_id) = session.work_id.as_deref() {
                work.get(work_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-session-work",
                        "Flow session work must exist in the exact work coordination snapshot",
                    )
                })?;
            }
            if let Some(claim_id) = session.claim_id.as_deref() {
                let claim = claims.get(claim_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-session-claim",
                        "Flow session claim must exist in the exact work coordination snapshot",
                    )
                })?;
                if session.work_id.as_deref() != Some(claim.work_id.as_str())
                    || session.membership_id != claim.claimant_membership_id
                    || session.agent_mandate_id != claim.agent_mandate_id
                {
                    return Err(ContractError::new(
                        "flow-session-claim-binding-mismatch",
                        "Flow session claim must match its exact work, membership, and mandate",
                    ));
                }
                if session.presence_state == FlowSessionPresenceState::Connected
                    && !matches!(
                        claim.state,
                        FlowWorkClaimState::Proposed | FlowWorkClaimState::Active
                    )
                {
                    return Err(ContractError::new(
                        "connected-flow-session-has-terminal-claim",
                        "Connected Flow session cannot present a terminal work claim as current",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlowPresenceOperationId {
    #[serde(rename = "flow.project.hosts.list")]
    HostsList,
    #[serde(rename = "flow.project.host.attach")]
    HostAttach,
    #[serde(rename = "flow.project.host.observe")]
    HostObserve,
    #[serde(rename = "flow.project.host.detach")]
    HostDetach,
    #[serde(rename = "flow.project.sessions.list")]
    SessionsList,
    #[serde(rename = "flow.project.session.attach")]
    SessionAttach,
    #[serde(rename = "flow.project.session.observe")]
    SessionObserve,
    #[serde(rename = "flow.project.session.disconnect")]
    SessionDisconnect,
    #[serde(rename = "flow.project.session.reconcile")]
    SessionReconcile,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowPresenceOperationScope {
    HostCollection,
    HostAttachment,
    SessionCollection,
    SessionBinding,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowPresenceOperationIntent {
    Read,
    Manage,
    Observe,
    Reconcile,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowPresenceIdempotencyLaw {
    None,
    ExactRequest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowPresenceResultKind {
    HostPage,
    HostAttachment,
    SessionPage,
    SessionBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowPresenceOperationDescriptor {
    pub protocol: String,
    pub operation_id: FlowPresenceOperationId,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub scope: FlowPresenceOperationScope,
    pub intent: FlowPresenceOperationIntent,
    pub requires_project_id: bool,
    pub requires_entity_id: bool,
    pub requires_expected_project_revision: bool,
    pub idempotency: FlowPresenceIdempotencyLaw,
    pub result_kind: FlowPresenceResultKind,
    pub grants_application_authority: bool,
    pub grants_execution_lease: bool,
    pub carries_provider_credentials: bool,
    pub repeats_provider_work: bool,
    pub mutates_work_outcome: bool,
}

impl FlowPresenceOperationDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PRESENCE_OPERATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        if self.grants_application_authority
            || self.grants_execution_lease
            || self.carries_provider_credentials
            || self.repeats_provider_work
            || self.mutates_work_outcome
        {
            return Err(ContractError::new(
                "invalid-flow-presence-operation-authority",
                "Flow presence operations neither grant authority or execution nor carry credentials, repeat provider work, or mutate work outcomes",
            ));
        }
        if self != &canonical_operation(self.operation_id) {
            return Err(ContractError::new(
                "invalid-flow-presence-operation",
                "Flow presence operation metadata must match the closed catalogue",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowPresenceOperationCatalogue {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub operations: Vec<FlowPresenceOperationDescriptor>,
}

impl FlowPresenceOperationCatalogue {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_PRESENCE_OPERATION_CATALOGUE_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        let mut ids = BTreeSet::new();
        for operation in &self.operations {
            operation.validate()?;
            if !ids.insert(operation.operation_id) {
                return Err(ContractError::new(
                    "duplicate-flow-presence-operation",
                    "Flow presence operation identities must be unique",
                ));
            }
        }
        if self != &flow_presence_operation_catalogue() {
            return Err(ContractError::new(
                "invalid-flow-presence-operation-catalogue",
                "Flow presence catalogue must match the exact current inventory",
            ));
        }
        Ok(())
    }
}

pub fn flow_presence_operation_catalogue() -> FlowPresenceOperationCatalogue {
    FlowPresenceOperationCatalogue {
        protocol: FLOW_PRESENCE_OPERATION_CATALOGUE_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        operations: [
            FlowPresenceOperationId::HostsList,
            FlowPresenceOperationId::HostAttach,
            FlowPresenceOperationId::HostObserve,
            FlowPresenceOperationId::HostDetach,
            FlowPresenceOperationId::SessionsList,
            FlowPresenceOperationId::SessionAttach,
            FlowPresenceOperationId::SessionObserve,
            FlowPresenceOperationId::SessionDisconnect,
            FlowPresenceOperationId::SessionReconcile,
        ]
        .into_iter()
        .map(canonical_operation)
        .collect(),
    }
}

fn canonical_operation(operation_id: FlowPresenceOperationId) -> FlowPresenceOperationDescriptor {
    use FlowPresenceIdempotencyLaw::{ExactRequest, None};
    use FlowPresenceOperationIntent::{Manage, Observe, Read, Reconcile};
    use FlowPresenceOperationScope::{
        HostAttachment, HostCollection, SessionBinding, SessionCollection,
    };
    use FlowPresenceResultKind::{
        HostAttachment as HostAttachmentResult, HostPage,
        SessionBinding as SessionBindingResult, SessionPage,
    };

    let (
        scope,
        intent,
        requires_entity_id,
        requires_expected_project_revision,
        idempotency,
        result_kind,
    ) = match operation_id {
        FlowPresenceOperationId::HostsList => {
            (HostCollection, Read, false, false, None, HostPage)
        }
        FlowPresenceOperationId::HostAttach => (
            HostCollection,
            Manage,
            false,
            true,
            ExactRequest,
            HostAttachmentResult,
        ),
        FlowPresenceOperationId::HostObserve => (
            HostAttachment,
            Observe,
            true,
            true,
            ExactRequest,
            HostAttachmentResult,
        ),
        FlowPresenceOperationId::HostDetach => (
            HostAttachment,
            Manage,
            true,
            true,
            ExactRequest,
            HostAttachmentResult,
        ),
        FlowPresenceOperationId::SessionsList => {
            (SessionCollection, Read, false, false, None, SessionPage)
        }
        FlowPresenceOperationId::SessionAttach => (
            SessionCollection,
            Manage,
            false,
            true,
            ExactRequest,
            SessionBindingResult,
        ),
        FlowPresenceOperationId::SessionObserve => (
            SessionBinding,
            Observe,
            true,
            true,
            ExactRequest,
            SessionBindingResult,
        ),
        FlowPresenceOperationId::SessionDisconnect => (
            SessionBinding,
            Manage,
            true,
            true,
            ExactRequest,
            SessionBindingResult,
        ),
        FlowPresenceOperationId::SessionReconcile => (
            SessionBinding,
            Reconcile,
            true,
            true,
            ExactRequest,
            SessionBindingResult,
        ),
    };

    FlowPresenceOperationDescriptor {
        protocol: FLOW_PRESENCE_OPERATION_PROTOCOL.to_owned(),
        operation_id,
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        scope,
        intent,
        requires_project_id: true,
        requires_entity_id,
        requires_expected_project_revision,
        idempotency,
        result_kind,
        grants_application_authority: false,
        grants_execution_lease: false,
        carries_provider_credentials: false,
        repeats_provider_work: false,
        mutates_work_outcome: false,
    }
}

fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-presence-protocol-mismatch",
            "Flow presence record uses an unsupported protocol",
        ))
    }
}

fn require_flow_application(
    application_id: CurrentApplicationId,
    application_revision: &str,
) -> Result<(), ContractError> {
    if application_id != CurrentApplicationId::Flow {
        return Err(ContractError::new(
            "invalid-flow-presence-application",
            "Flow presence records must be owned by the current Flow application",
        ));
    }
    if application_revision != CURRENT_SUITE_REVISION {
        return Err(ContractError::new(
            "flow-presence-application-revision-mismatch",
            "Flow presence records require the exact current application revision",
        ));
    }
    Ok(())
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
            "Flow presence record belongs to a different project or application revision",
        ))
    }
}

fn require_positive_revision(revision: u64, code: &'static str) -> Result<(), ContractError> {
    if revision > 0 {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow presence revision or generation must be positive",
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
            "invalid-flow-host-capability-root",
            "Flow host capability root must be a lowercase SHA-256 digest",
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
            "Flow presence scoped identity is invalid",
        ))
    }
}

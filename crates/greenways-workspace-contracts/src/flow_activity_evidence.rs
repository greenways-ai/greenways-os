use crate::error::ContractError;
use crate::flow_handoff_intervention::{
    FlowProjectHandoffActor, FlowProjectHandoffInterventionSnapshot,
};
use crate::flow_participation::{
    FlowAgentMandateCapability, FlowAgentMandateState, FlowProjectMemberRole,
    FlowProjectMemberState, FlowProjectParticipationSnapshot, FlowProjectPrincipalKind,
};
use crate::flow_presence::{FlowProjectPresenceSnapshot, FlowSessionPresenceState};
use crate::flow_work_coordination::{FlowWorkClaimState, FlowWorkCoordinationSnapshot};
use crate::suite::{
    CurrentApplicationId, ReferenceAuthorityState, ReferenceFreshness, SharedReference,
    CURRENT_SUITE_REVISION,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const FLOW_PROJECT_ACTIVITY_EVIDENCE_PROTOCOL: &str =
    "greenways.flow.project-activity-evidence/0-alpha";
pub const FLOW_PROJECT_ARTIFACT_PROTOCOL: &str = "greenways.flow.project-artifact/0-alpha";
pub const FLOW_EXTERNAL_READBACK_PROTOCOL: &str = "greenways.flow.external-readback/0-alpha";
pub const FLOW_PROJECT_ACTIVITY_PROTOCOL: &str = "greenways.flow.project-activity/0-alpha";
pub const FLOW_ACTIVITY_EVIDENCE_OPERATION_PROTOCOL: &str =
    "greenways.flow.activity-evidence-operation/0-alpha";
pub const FLOW_ACTIVITY_EVIDENCE_OPERATION_CATALOGUE_PROTOCOL: &str =
    "greenways.flow.activity-evidence-operation-catalogue/0-alpha";

pub const FLOW_PROJECT_ARTIFACTS_LIST_OPERATION: &str = "flow.project.artifacts.list";
pub const FLOW_PROJECT_ARTIFACT_REPORT_OPERATION: &str = "flow.project.artifact.report";
pub const FLOW_PROJECT_ARTIFACT_SELECT_OPERATION: &str = "flow.project.artifact.select";
pub const FLOW_PROJECT_ARTIFACT_REJECT_OPERATION: &str = "flow.project.artifact.reject";
pub const FLOW_PROJECT_EXTERNAL_READBACKS_LIST_OPERATION: &str =
    "flow.project.external-readbacks.list";
pub const FLOW_PROJECT_EXTERNAL_READBACK_OBSERVE_OPERATION: &str =
    "flow.project.external-readback.observe";
pub const FLOW_PROJECT_EXTERNAL_READBACK_VERIFY_OPERATION: &str =
    "flow.project.external-readback.verify";
pub const FLOW_PROJECT_EXTERNAL_READBACK_MARK_UNCERTAIN_OPERATION: &str =
    "flow.project.external-readback.mark-uncertain";
pub const FLOW_PROJECT_ACTIVITY_LIST_OPERATION: &str = "flow.project.activity.list";

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_ARTIFACT_ID_BYTES: usize = 256;
const MAX_READBACK_ID_BYTES: usize = 256;
const MAX_ACTIVITY_ID_BYTES: usize = 256;
const MAX_WORK_ID_BYTES: usize = 256;
const MAX_CLAIM_ID_BYTES: usize = 256;
const MAX_HANDOFF_ID_BYTES: usize = 256;
const MAX_INTERVENTION_ID_BYTES: usize = 256;
const MAX_EFFECT_ID_BYTES: usize = 256;
const MAX_MEMBERSHIP_ID_BYTES: usize = 256;
const MAX_SUBJECT_ID_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 180;
const MAX_SUMMARY_BYTES: usize = 400;
const MAX_DETAIL_BYTES: usize = 1000;
const MAX_ARTIFACTS: usize = 512;
const MAX_READBACKS: usize = 512;
const MAX_ACTIVITY: usize = 4096;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectArtifactKind {
    Document,
    Code,
    Dataset,
    Image,
    Media,
    Decision,
    Report,
    ExecutionOutput,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectArtifactState {
    Reported,
    Available,
    Selected,
    Rejected,
    VerificationPending,
    Verified,
    VerificationFailed,
    Superseded,
}

impl FlowProjectArtifactState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Reported,
                Self::Available | Self::Rejected | Self::Superseded
            ) | (
                Self::Available,
                Self::Selected | Self::Rejected | Self::Superseded
            ) | (
                Self::Selected,
                Self::VerificationPending | Self::Rejected | Self::Superseded
            ) | (
                Self::VerificationPending,
                Self::Verified | Self::VerificationFailed | Self::Superseded
            ) | (Self::VerificationFailed, Self::VerificationPending | Self::Superseded)
                | (Self::Verified, Self::Superseded)
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectArtifact {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub artifact_id: String,
    pub revision: u64,
    pub kind: FlowProjectArtifactKind,
    pub title: String,
    pub summary: Option<String>,
    pub producer: FlowProjectHandoffActor,
    pub work_id: String,
    pub claim_id: Option<String>,
    pub state: FlowProjectArtifactState,
    pub reported_at_unix_ms: u64,
    pub available_at_unix_ms: Option<u64>,
    pub exact_root: Option<String>,
    pub artifact_reference: Option<SharedReference>,
    pub selected_at_unix_ms: Option<u64>,
    pub selected_by_membership_id: Option<String>,
    pub rejected_at_unix_ms: Option<u64>,
    pub rejected_by_membership_id: Option<String>,
    pub superseded_at_unix_ms: Option<u64>,
    pub superseded_by_artifact_id: Option<String>,
    pub verification_readback_id: Option<String>,
    pub verified_at_unix_ms: Option<u64>,
    pub verification_failed_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
    pub contains_artifact_bytes: bool,
    pub carries_provider_credentials: bool,
    pub carries_private_provider_reference: bool,
    pub copies_work_runtime_state: bool,
}

impl FlowProjectArtifact {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_ARTIFACT_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.artifact_id,
            "artifact/",
            MAX_ARTIFACT_ID_BYTES,
            "invalid-flow-artifact-id",
        )?;
        validate_scoped_identifier(
            &self.work_id,
            "work/",
            MAX_WORK_ID_BYTES,
            "invalid-flow-artifact-work-id",
        )?;
        if let Some(claim_id) = &self.claim_id {
            validate_scoped_identifier(
                claim_id,
                "claim/",
                MAX_CLAIM_ID_BYTES,
                "invalid-flow-artifact-claim-id",
            )?;
        }
        require_positive_revision(self.revision, "invalid-flow-artifact-revision")?;
        validate_text(&self.title, MAX_TITLE_BYTES, "invalid-flow-artifact-title")?;
        if let Some(summary) = &self.summary {
            validate_text(
                summary,
                MAX_SUMMARY_BYTES,
                "invalid-flow-artifact-summary",
            )?;
        }
        self.producer.validate()?;
        if self.reported_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-artifact-time",
                "Flow artifact report time must be positive",
            ));
        }
        for timestamp in [
            self.available_at_unix_ms,
            self.selected_at_unix_ms,
            self.rejected_at_unix_ms,
            self.superseded_at_unix_ms,
            self.verified_at_unix_ms,
            self.verification_failed_at_unix_ms,
        ]
        .into_iter()
        .flatten()
        {
            if timestamp < self.reported_at_unix_ms {
                return Err(ContractError::new(
                    "invalid-flow-artifact-time",
                    "Flow artifact lifecycle evidence cannot predate its report",
                ));
            }
        }
        validate_optional_actor_pair(
            self.selected_at_unix_ms,
            self.selected_by_membership_id.as_deref(),
            "flow-artifact-selection-evidence-mismatch",
        )?;
        validate_optional_actor_pair(
            self.rejected_at_unix_ms,
            self.rejected_by_membership_id.as_deref(),
            "flow-artifact-rejection-evidence-mismatch",
        )?;
        validate_optional_actor_pair(
            self.superseded_at_unix_ms,
            self.superseded_by_artifact_id.as_deref(),
            "flow-artifact-supersession-evidence-mismatch",
        )?;
        for membership_id in [
            self.selected_by_membership_id.as_deref(),
            self.rejected_by_membership_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            validate_scoped_identifier(
                membership_id,
                "membership/",
                MAX_MEMBERSHIP_ID_BYTES,
                "invalid-flow-artifact-human-actor",
            )?;
        }
        if let Some(artifact_id) = &self.superseded_by_artifact_id {
            validate_scoped_identifier(
                artifact_id,
                "artifact/",
                MAX_ARTIFACT_ID_BYTES,
                "invalid-flow-artifact-supersession",
            )?;
            if artifact_id == &self.artifact_id {
                return Err(ContractError::new(
                    "self-superseded-flow-artifact",
                    "Flow artifact cannot supersede itself",
                ));
            }
        }
        if let Some(readback_id) = &self.verification_readback_id {
            validate_scoped_identifier(
                readback_id,
                "readback/",
                MAX_READBACK_ID_BYTES,
                "invalid-flow-artifact-readback-id",
            )?;
        }
        validate_artifact_available_evidence(self)?;

        let state_evidence_is_valid = match self.state {
            FlowProjectArtifactState::Reported => {
                !has_available_evidence(self)
                    && self.selected_at_unix_ms.is_none()
                    && self.rejected_at_unix_ms.is_none()
                    && self.superseded_at_unix_ms.is_none()
                    && self.verification_readback_id.is_none()
                    && self.verified_at_unix_ms.is_none()
                    && self.verification_failed_at_unix_ms.is_none()
            }
            FlowProjectArtifactState::Available => {
                has_complete_available_evidence(self)
                    && self.selected_at_unix_ms.is_none()
                    && self.rejected_at_unix_ms.is_none()
                    && self.superseded_at_unix_ms.is_none()
                    && self.verification_readback_id.is_none()
                    && self.verified_at_unix_ms.is_none()
                    && self.verification_failed_at_unix_ms.is_none()
            }
            FlowProjectArtifactState::Selected => {
                has_complete_available_evidence(self)
                    && self.selected_at_unix_ms.is_some()
                    && self.rejected_at_unix_ms.is_none()
                    && self.superseded_at_unix_ms.is_none()
                    && self.verification_readback_id.is_none()
                    && self.verified_at_unix_ms.is_none()
                    && self.verification_failed_at_unix_ms.is_none()
            }
            FlowProjectArtifactState::Rejected => {
                optional_available_evidence_is_consistent(self)
                    && self.selected_at_unix_ms.is_none()
                    && self.rejected_at_unix_ms.is_some()
                    && self.superseded_at_unix_ms.is_none()
                    && self.verification_readback_id.is_none()
                    && self.verified_at_unix_ms.is_none()
                    && self.verification_failed_at_unix_ms.is_none()
            }
            FlowProjectArtifactState::VerificationPending => {
                has_complete_available_evidence(self)
                    && self.selected_at_unix_ms.is_some()
                    && self.rejected_at_unix_ms.is_none()
                    && self.superseded_at_unix_ms.is_none()
                    && self.verification_readback_id.is_some()
                    && self.verified_at_unix_ms.is_none()
                    && self.verification_failed_at_unix_ms.is_none()
            }
            FlowProjectArtifactState::Verified => {
                has_complete_available_evidence(self)
                    && self.selected_at_unix_ms.is_some()
                    && self.rejected_at_unix_ms.is_none()
                    && self.superseded_at_unix_ms.is_none()
                    && self.verification_readback_id.is_some()
                    && self.verified_at_unix_ms.is_some()
                    && self.verification_failed_at_unix_ms.is_none()
            }
            FlowProjectArtifactState::VerificationFailed => {
                has_complete_available_evidence(self)
                    && self.selected_at_unix_ms.is_some()
                    && self.rejected_at_unix_ms.is_none()
                    && self.superseded_at_unix_ms.is_none()
                    && self.verification_readback_id.is_some()
                    && self.verified_at_unix_ms.is_none()
                    && self.verification_failed_at_unix_ms.is_some()
            }
            FlowProjectArtifactState::Superseded => {
                has_complete_available_evidence(self)
                    && self.rejected_at_unix_ms.is_none()
                    && self.superseded_at_unix_ms.is_some()
                    && self.verification_failed_at_unix_ms.is_none()
                    && self.verified_at_unix_ms.is_none()
            }
        };
        if !state_evidence_is_valid {
            return Err(ContractError::new(
                "flow-artifact-state-evidence-mismatch",
                "Flow artifact state requires exact availability, selection, rejection, supersession, and verification evidence",
            ));
        }
        if self.authority_transfer
            || self.contains_artifact_bytes
            || self.carries_provider_credentials
            || self.carries_private_provider_reference
            || self.copies_work_runtime_state
        {
            return Err(ContractError::new(
                "flow-artifact-authority-or-payload-expansion",
                "Flow artifact records cannot carry bytes, credentials, private provider references, Work runtime state, or application authority",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowExternalReadbackState {
    Requested,
    ProviderAccepted,
    Observed,
    Verified,
    Uncertain,
    Failed,
    Rejected,
    Revoked,
}

impl FlowExternalReadbackState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Requested,
                Self::ProviderAccepted
                    | Self::Observed
                    | Self::Uncertain
                    | Self::Failed
                    | Self::Rejected
            ) | (
                Self::ProviderAccepted,
                Self::Observed | Self::Uncertain | Self::Failed | Self::Rejected
            ) | (
                Self::Observed,
                Self::Verified | Self::Uncertain | Self::Failed | Self::Rejected
            ) | (Self::Uncertain, Self::Observed | Self::Failed | Self::Rejected)
                | (Self::Verified, Self::Revoked)
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowReadbackVerificationMethod {
    AuthoritativeReadback,
    SignedReceipt,
    DigestMatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowExternalReadback {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub readback_id: String,
    pub revision: u64,
    pub effect_id: String,
    pub effect_digest: String,
    pub work_id: Option<String>,
    pub artifact_id: Option<String>,
    pub handoff_id: Option<String>,
    pub observer: FlowProjectHandoffActor,
    pub state: FlowExternalReadbackState,
    pub summary: String,
    pub detail: Option<String>,
    pub requested_at_unix_ms: u64,
    pub provider_accepted_at_unix_ms: Option<u64>,
    pub observed_at_unix_ms: Option<u64>,
    pub verified_at_unix_ms: Option<u64>,
    pub uncertain_at_unix_ms: Option<u64>,
    pub terminal_at_unix_ms: Option<u64>,
    pub verification_method: Option<FlowReadbackVerificationMethod>,
    pub readback_reference: Option<SharedReference>,
    pub authority_transfer: bool,
    pub carries_provider_credentials: bool,
    pub carries_private_provider_reference: bool,
    pub repeats_provider_work: bool,
    pub repeats_external_effect: bool,
}

impl FlowExternalReadback {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_EXTERNAL_READBACK_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.readback_id,
            "readback/",
            MAX_READBACK_ID_BYTES,
            "invalid-flow-readback-id",
        )?;
        validate_scoped_identifier(
            &self.effect_id,
            "effect/",
            MAX_EFFECT_ID_BYTES,
            "invalid-flow-effect-id",
        )?;
        validate_digest(&self.effect_digest)?;
        require_positive_revision(self.revision, "invalid-flow-readback-revision")?;
        if let Some(work_id) = &self.work_id {
            validate_scoped_identifier(
                work_id,
                "work/",
                MAX_WORK_ID_BYTES,
                "invalid-flow-readback-work-id",
            )?;
        }
        if let Some(artifact_id) = &self.artifact_id {
            validate_scoped_identifier(
                artifact_id,
                "artifact/",
                MAX_ARTIFACT_ID_BYTES,
                "invalid-flow-readback-artifact-id",
            )?;
        }
        if let Some(handoff_id) = &self.handoff_id {
            validate_scoped_identifier(
                handoff_id,
                "handoff/",
                MAX_HANDOFF_ID_BYTES,
                "invalid-flow-readback-handoff-id",
            )?;
        }
        self.observer.validate()?;
        validate_text(
            &self.summary,
            MAX_SUMMARY_BYTES,
            "invalid-flow-readback-summary",
        )?;
        if let Some(detail) = &self.detail {
            validate_text(
                detail,
                MAX_DETAIL_BYTES,
                "invalid-flow-readback-detail",
            )?;
        }
        if self.requested_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-readback-time",
                "Flow external read-back request time must be positive",
            ));
        }
        for timestamp in [
            self.provider_accepted_at_unix_ms,
            self.observed_at_unix_ms,
            self.verified_at_unix_ms,
            self.uncertain_at_unix_ms,
            self.terminal_at_unix_ms,
        ]
        .into_iter()
        .flatten()
        {
            if timestamp < self.requested_at_unix_ms {
                return Err(ContractError::new(
                    "invalid-flow-readback-time",
                    "Flow external read-back lifecycle evidence cannot predate its request",
                ));
            }
        }
        if self
            .verified_at_unix_ms
            .zip(self.observed_at_unix_ms)
            .is_some_and(|(verified, observed)| verified < observed)
        {
            return Err(ContractError::new(
                "invalid-flow-readback-time-order",
                "Flow read-back verification cannot predate observation",
            ));
        }
        validate_readback_reference(self)?;

        let state_evidence_is_valid = match self.state {
            FlowExternalReadbackState::Requested => {
                self.provider_accepted_at_unix_ms.is_none()
                    && self.observed_at_unix_ms.is_none()
                    && self.verified_at_unix_ms.is_none()
                    && self.uncertain_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.verification_method.is_none()
                    && self.readback_reference.is_none()
            }
            FlowExternalReadbackState::ProviderAccepted => {
                self.provider_accepted_at_unix_ms.is_some()
                    && self.observed_at_unix_ms.is_none()
                    && self.verified_at_unix_ms.is_none()
                    && self.uncertain_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.verification_method.is_none()
                    && self.readback_reference.is_none()
            }
            FlowExternalReadbackState::Observed => {
                self.observed_at_unix_ms.is_some()
                    && self.verified_at_unix_ms.is_none()
                    && self.uncertain_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.verification_method.is_none()
                    && self.readback_reference.is_some()
            }
            FlowExternalReadbackState::Verified => {
                self.observed_at_unix_ms.is_some()
                    && self.verified_at_unix_ms.is_some()
                    && self.uncertain_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_none()
                    && self.verification_method.is_some()
                    && self.readback_reference.is_some()
            }
            FlowExternalReadbackState::Uncertain => {
                self.verified_at_unix_ms.is_none()
                    && self.uncertain_at_unix_ms.is_some()
                    && self.terminal_at_unix_ms.is_none()
                    && self.verification_method.is_none()
                    && (self.observed_at_unix_ms.is_some()
                        == self.readback_reference.is_some())
            }
            FlowExternalReadbackState::Failed
            | FlowExternalReadbackState::Rejected
            | FlowExternalReadbackState::Revoked => {
                self.verified_at_unix_ms.is_none()
                    && self.uncertain_at_unix_ms.is_none()
                    && self.terminal_at_unix_ms.is_some()
                    && self.verification_method.is_none()
                    && (self.observed_at_unix_ms.is_some()
                        == self.readback_reference.is_some())
            }
        };
        if !state_evidence_is_valid {
            return Err(ContractError::new(
                "flow-readback-state-evidence-mismatch",
                "Flow external read-back state requires exact provider, observation, verification, uncertainty, or terminal evidence",
            ));
        }
        if self.state == FlowExternalReadbackState::Verified {
            let reference = self
                .readback_reference
                .as_ref()
                .expect("verified state checked the reference");
            if reference.exact_root.is_none()
                || reference.freshness != ReferenceFreshness::Current
                || reference.authority_state != ReferenceAuthorityState::Observed
            {
                return Err(ContractError::new(
                    "flow-readback-verification-insufficient",
                    "Verified external effect requires an exact current authoritative read-back observation",
                ));
            }
        }
        if self.authority_transfer
            || self.carries_provider_credentials
            || self.carries_private_provider_reference
            || self.repeats_provider_work
            || self.repeats_external_effect
        {
            return Err(ContractError::new(
                "flow-readback-authority-or-effect-expansion",
                "Flow read-back records cannot transfer authority, carry provider secrets, repeat provider work, or repeat external effects",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectActivityKind {
    MembershipChanged,
    MandateChanged,
    HostObserved,
    SessionObserved,
    WorkChanged,
    ClaimChanged,
    HandoffChanged,
    InterventionChanged,
    ArtifactReported,
    ArtifactSelected,
    ExternalReadbackObserved,
    ExternalEffectVerified,
    ReconciliationObserved,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectActivitySubjectKind {
    Project,
    Membership,
    Mandate,
    HostAttachment,
    Session,
    Work,
    Claim,
    Handoff,
    Intervention,
    Artifact,
    ExternalReadback,
    Reconciliation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectActivityEntry {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub activity_id: String,
    pub sequence: u64,
    pub kind: FlowProjectActivityKind,
    pub subject_kind: FlowProjectActivitySubjectKind,
    pub subject_id: String,
    pub actor: Option<FlowProjectHandoffActor>,
    pub causal_predecessor_activity_id: Option<String>,
    pub event_digest: String,
    pub occurred_at_unix_ms: u64,
    pub recorded_at_unix_ms: u64,
    pub reference: Option<SharedReference>,
    pub summary: String,
    pub authority_transfer: bool,
    pub mutates_source_record: bool,
    pub repeats_work_runtime: bool,
    pub repeats_handoff_transfer: bool,
    pub repeats_provider_work: bool,
    pub repeats_external_effect: bool,
}

impl FlowProjectActivityEntry {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_ACTIVITY_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.activity_id,
            "activity/",
            MAX_ACTIVITY_ID_BYTES,
            "invalid-flow-activity-id",
        )?;
        require_positive_revision(self.sequence, "invalid-flow-activity-sequence")?;
        validate_activity_subject(self.subject_kind, &self.subject_id)?;
        if let Some(actor) = &self.actor {
            actor.validate()?;
        }
        if let Some(predecessor) = &self.causal_predecessor_activity_id {
            validate_scoped_identifier(
                predecessor,
                "activity/",
                MAX_ACTIVITY_ID_BYTES,
                "invalid-flow-activity-predecessor",
            )?;
            if predecessor == &self.activity_id {
                return Err(ContractError::new(
                    "self-referential-flow-activity",
                    "Flow activity cannot be its own causal predecessor",
                ));
            }
        }
        validate_digest(&self.event_digest)?;
        if self.occurred_at_unix_ms == 0
            || self.recorded_at_unix_ms < self.occurred_at_unix_ms
        {
            return Err(ContractError::new(
                "invalid-flow-activity-time",
                "Flow activity occurrence and recording times must be positive and monotonic",
            ));
        }
        if let Some(reference) = &self.reference {
            reference.validate()?;
            if reference.application_revision != self.application_revision {
                return Err(ContractError::new(
                    "flow-activity-reference-revision-mismatch",
                    "Flow activity references require the exact current application revision",
                ));
            }
        }
        validate_text(
            &self.summary,
            MAX_SUMMARY_BYTES,
            "invalid-flow-activity-summary",
        )?;
        if !activity_kind_matches_subject(self.kind, self.subject_kind) {
            return Err(ContractError::new(
                "flow-activity-kind-subject-mismatch",
                "Flow activity kind must match its closed subject class",
            ));
        }
        if self.authority_transfer
            || self.mutates_source_record
            || self.repeats_work_runtime
            || self.repeats_handoff_transfer
            || self.repeats_provider_work
            || self.repeats_external_effect
        {
            return Err(ContractError::new(
                "flow-activity-authority-or-effect-expansion",
                "Flow activity is append-only evidence and cannot mutate source authority or repeat work, transfer, provider work, or external effects",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectActivityEvidenceSnapshot {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub project_revision: u64,
    pub snapshot_generation: u64,
    pub observed_at_unix_ms: u64,
    pub artifacts: Vec<FlowProjectArtifact>,
    pub external_readbacks: Vec<FlowExternalReadback>,
    pub activity: Vec<FlowProjectActivityEntry>,
    pub rebuilds_projection_only: bool,
    pub repeats_provider_work: bool,
    pub repeats_work_runtime: bool,
    pub repeats_handoff_transfer: bool,
    pub repeats_external_effects: bool,
    pub authority_transfer: bool,
}

impl FlowProjectActivityEvidenceSnapshot {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_ACTIVITY_EVIDENCE_PROTOCOL)?;
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
            "invalid-flow-activity-snapshot-generation",
        )?;
        if self.observed_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-activity-observation-time",
                "Flow activity/evidence observation time must be positive",
            ));
        }
        if self.artifacts.len() > MAX_ARTIFACTS
            || self.external_readbacks.len() > MAX_READBACKS
            || self.activity.len() > MAX_ACTIVITY
        {
            return Err(ContractError::new(
                "flow-activity-evidence-collection-limit",
                "Flow activity/evidence collections exceed their bounds",
            ));
        }
        if !self.rebuilds_projection_only
            || self.repeats_provider_work
            || self.repeats_work_runtime
            || self.repeats_handoff_transfer
            || self.repeats_external_effects
            || self.authority_transfer
        {
            return Err(ContractError::new(
                "flow-activity-rebuild-side-effect",
                "Flow activity/evidence snapshots rebuild projections only and cannot repeat work, transfer, provider work, effects, or authority",
            ));
        }

        let mut artifact_by_id = BTreeMap::new();
        for artifact in &self.artifacts {
            artifact.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &artifact.project_id,
                &artifact.application_revision,
                "flow-artifact-project-mismatch",
            )?;
            if artifact_by_id
                .insert(artifact.artifact_id.as_str(), artifact)
                .is_some()
            {
                return Err(ContractError::new(
                    "duplicate-flow-artifact-id",
                    "Flow artifact identities must be unique within a snapshot",
                ));
            }
            if artifact.reported_at_unix_ms > self.observed_at_unix_ms
                || artifact
                    .available_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || artifact
                    .selected_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || artifact
                    .rejected_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || artifact
                    .superseded_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || artifact
                    .verified_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || artifact
                    .verification_failed_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
            {
                return Err(ContractError::new(
                    "future-flow-artifact-evidence",
                    "Flow artifact evidence cannot be newer than its snapshot",
                ));
            }
        }

        let mut readback_by_id = BTreeMap::new();
        for readback in &self.external_readbacks {
            readback.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &readback.project_id,
                &readback.application_revision,
                "flow-readback-project-mismatch",
            )?;
            if readback_by_id
                .insert(readback.readback_id.as_str(), readback)
                .is_some()
            {
                return Err(ContractError::new(
                    "duplicate-flow-readback-id",
                    "Flow external read-back identities must be unique within a snapshot",
                ));
            }
            if readback.requested_at_unix_ms > self.observed_at_unix_ms
                || readback
                    .provider_accepted_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || readback
                    .observed_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || readback
                    .verified_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || readback
                    .uncertain_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
                || readback
                    .terminal_at_unix_ms
                    .is_some_and(|value| value > self.observed_at_unix_ms)
            {
                return Err(ContractError::new(
                    "future-flow-readback-evidence",
                    "Flow external read-back evidence cannot be newer than its snapshot",
                ));
            }
            if let Some(artifact_id) = readback.artifact_id.as_deref() {
                artifact_by_id.get(artifact_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-readback-artifact",
                        "Flow external read-back artifact must exist in the exact snapshot",
                    )
                })?;
            }
        }

        for artifact in &self.artifacts {
            if let Some(readback_id) = artifact.verification_readback_id.as_deref() {
                let readback = readback_by_id.get(readback_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-artifact-verification-readback",
                        "Flow artifact verification must reference an exact external read-back",
                    )
                })?;
                if readback.artifact_id.as_deref() != Some(artifact.artifact_id.as_str()) {
                    return Err(ContractError::new(
                        "flow-artifact-readback-mismatch",
                        "Flow artifact and external read-back must reference each other exactly",
                    ));
                }
                let readback_state_matches = match artifact.state {
                    FlowProjectArtifactState::VerificationPending => matches!(
                        readback.state,
                        FlowExternalReadbackState::Requested
                            | FlowExternalReadbackState::ProviderAccepted
                            | FlowExternalReadbackState::Observed
                            | FlowExternalReadbackState::Uncertain
                    ),
                    FlowProjectArtifactState::Verified => {
                        readback.state == FlowExternalReadbackState::Verified
                    }
                    FlowProjectArtifactState::VerificationFailed => matches!(
                        readback.state,
                        FlowExternalReadbackState::Failed
                            | FlowExternalReadbackState::Rejected
                            | FlowExternalReadbackState::Revoked
                    ),
                    _ => true,
                };
                if !readback_state_matches {
                    return Err(ContractError::new(
                        "flow-artifact-readback-state-mismatch",
                        "Flow artifact verification state must match its exact external read-back evidence",
                    ));
                }
            }
            if let Some(superseding_id) = artifact.superseded_by_artifact_id.as_deref() {
                artifact_by_id.get(superseding_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-superseding-artifact",
                        "Flow superseding artifact must exist in the exact snapshot",
                    )
                })?;
            }
        }

        let mut activity_ids = BTreeSet::new();
        let mut event_digests = BTreeSet::new();
        let mut seen_activity_ids = BTreeSet::new();
        let mut previous_sequence = None;
        for entry in &self.activity {
            entry.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &entry.project_id,
                &entry.application_revision,
                "flow-activity-project-mismatch",
            )?;
            if !activity_ids.insert(entry.activity_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-activity-id",
                    "Flow activity identities must be unique",
                ));
            }
            if !event_digests.insert(entry.event_digest.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-activity-event",
                    "Flow append history cannot record the same immutable event twice",
                ));
            }
            if previous_sequence.is_some_and(|value| entry.sequence <= value) {
                return Err(ContractError::new(
                    "unordered-flow-activity-sequence",
                    "Flow project activity sequence must be strictly increasing",
                ));
            }
            previous_sequence = Some(entry.sequence);
            if entry.recorded_at_unix_ms > self.observed_at_unix_ms {
                return Err(ContractError::new(
                    "future-flow-activity-evidence",
                    "Flow activity cannot be recorded after its snapshot observation",
                ));
            }
            if let Some(predecessor) = entry.causal_predecessor_activity_id.as_deref() {
                if !seen_activity_ids.contains(predecessor) {
                    return Err(ContractError::new(
                        "unknown-or-forward-flow-activity-predecessor",
                        "Flow activity causal predecessor must already exist earlier in the append stream",
                    ));
                }
            }
            seen_activity_ids.insert(entry.activity_id.as_str());
        }

        for artifact in self.artifacts.iter().filter(|artifact| {
            matches!(
                artifact.state,
                FlowProjectArtifactState::Selected
                    | FlowProjectArtifactState::VerificationPending
                    | FlowProjectArtifactState::Verified
                    | FlowProjectArtifactState::VerificationFailed
            )
        }) {
            if !self.activity.iter().any(|entry| {
                entry.kind == FlowProjectActivityKind::ArtifactSelected
                    && entry.subject_kind == FlowProjectActivitySubjectKind::Artifact
                    && entry.subject_id == artifact.artifact_id
            }) {
                return Err(ContractError::new(
                    "flow-selected-artifact-without-activity",
                    "Selected Flow artifact requires attributable append activity",
                ));
            }
        }
        for readback in self
            .external_readbacks
            .iter()
            .filter(|readback| readback.state == FlowExternalReadbackState::Verified)
        {
            if !self.activity.iter().any(|entry| {
                entry.kind == FlowProjectActivityKind::ExternalEffectVerified
                    && entry.subject_kind == FlowProjectActivitySubjectKind::ExternalReadback
                    && entry.subject_id == readback.readback_id
            }) {
                return Err(ContractError::new(
                    "flow-verified-effect-without-activity",
                    "Verified Flow external effect requires attributable append activity",
                ));
            }
        }
        Ok(())
    }

    pub fn validate_against_context(
        &self,
        participation: &FlowProjectParticipationSnapshot,
        coordination: &FlowWorkCoordinationSnapshot,
        presence: &FlowProjectPresenceSnapshot,
        handoffs: &FlowProjectHandoffInterventionSnapshot,
    ) -> Result<(), ContractError> {
        self.validate()?;
        participation.validate()?;
        coordination.validate_against_participation(participation)?;
        presence.validate_against_context(participation, coordination)?;
        handoffs.validate_against_context(participation, coordination, presence)?;
        if self.project_id != participation.project_id
            || self.project_id != coordination.project_id
            || self.project_id != presence.project_id
            || self.project_id != handoffs.project_id
            || self.project_revision != participation.project_revision
            || self.project_revision != coordination.project_revision
            || self.project_revision != presence.project_revision
            || self.project_revision != handoffs.project_revision
            || self.application_revision != participation.application_revision
            || self.application_revision != coordination.application_revision
            || self.application_revision != presence.application_revision
            || self.application_revision != handoffs.application_revision
        {
            return Err(ContractError::new(
                "flow-activity-evidence-context-mismatch",
                "Flow activity/evidence and all coordination snapshots must describe the same project revision",
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
        let sessions = presence
            .sessions
            .iter()
            .map(|session| (session.session_id.as_str(), session))
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
        let handoff_by_id = handoffs
            .handoffs
            .iter()
            .map(|handoff| (handoff.handoff_id.as_str(), handoff))
            .collect::<BTreeMap<_, _>>();
        let intervention_by_id = handoffs
            .interventions
            .iter()
            .map(|intervention| (intervention.intervention_id.as_str(), intervention))
            .collect::<BTreeMap<_, _>>();
        let artifact_by_id = self
            .artifacts
            .iter()
            .map(|artifact| (artifact.artifact_id.as_str(), artifact))
            .collect::<BTreeMap<_, _>>();
        let readback_by_id = self
            .external_readbacks
            .iter()
            .map(|readback| (readback.readback_id.as_str(), readback))
            .collect::<BTreeMap<_, _>>();

        for artifact in &self.artifacts {
            validate_actor(
                &artifact.producer,
                FlowAgentMandateCapability::ArtifactReport,
                &members,
                &mandates,
                &sessions,
            )?;
            work.get(artifact.work_id.as_str()).ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-artifact-work",
                    "Flow artifact work must exist in the exact coordination snapshot",
                )
            })?;
            if let Some(claim_id) = artifact.claim_id.as_deref() {
                let claim = claims.get(claim_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-artifact-claim",
                        "Flow artifact claim must exist in the exact coordination snapshot",
                    )
                })?;
                if claim.work_id != artifact.work_id
                    || claim.claimant_membership_id != artifact.producer.membership_id
                    || claim.agent_mandate_id != artifact.producer.agent_mandate_id
                    || !matches!(claim.state, FlowWorkClaimState::Proposed | FlowWorkClaimState::Active)
                {
                    return Err(ContractError::new(
                        "flow-artifact-claim-context-mismatch",
                        "Flow artifact claim must match its work and exact current producer",
                    ));
                }
            }
            for human_actor in [
                artifact.selected_by_membership_id.as_deref(),
                artifact.rejected_by_membership_id.as_deref(),
            ]
            .into_iter()
            .flatten()
            {
                require_active_human_coordinator(human_actor, &members)?;
            }
        }

        for readback in &self.external_readbacks {
            validate_actor(
                &readback.observer,
                FlowAgentMandateCapability::EvidenceObserve,
                &members,
                &mandates,
                &sessions,
            )?;
            if let Some(work_id) = readback.work_id.as_deref() {
                work.get(work_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-readback-work",
                        "Flow read-back work must exist in the exact coordination snapshot",
                    )
                })?;
            }
            if let Some(artifact_id) = readback.artifact_id.as_deref() {
                artifact_by_id.get(artifact_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-readback-artifact",
                        "Flow read-back artifact must exist in the exact evidence snapshot",
                    )
                })?;
            }
            if let Some(handoff_id) = readback.handoff_id.as_deref() {
                handoff_by_id.get(handoff_id).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-readback-handoff",
                        "Flow read-back handoff must exist in the exact handoff snapshot",
                    )
                })?;
            }
        }

        let member_ids = members.keys().copied().collect::<BTreeSet<_>>();
        let mandate_ids = mandates.keys().copied().collect::<BTreeSet<_>>();
        let attachment_ids = presence
            .host_attachments
            .iter()
            .map(|attachment| attachment.attachment_id.as_str())
            .collect::<BTreeSet<_>>();
        let session_ids = sessions.keys().copied().collect::<BTreeSet<_>>();
        let work_ids = work.keys().copied().collect::<BTreeSet<_>>();
        let claim_ids = claims.keys().copied().collect::<BTreeSet<_>>();
        let handoff_ids = handoff_by_id.keys().copied().collect::<BTreeSet<_>>();
        let intervention_ids = intervention_by_id.keys().copied().collect::<BTreeSet<_>>();
        let artifact_ids = artifact_by_id.keys().copied().collect::<BTreeSet<_>>();
        let readback_ids = readback_by_id.keys().copied().collect::<BTreeSet<_>>();

        for entry in &self.activity {
            if let Some(actor) = &entry.actor {
                validate_actor(
                    actor,
                    FlowAgentMandateCapability::EvidenceObserve,
                    &members,
                    &mandates,
                    &sessions,
                )?;
            }
            let subject_exists = match entry.subject_kind {
                FlowProjectActivitySubjectKind::Project => entry.subject_id == self.project_id,
                FlowProjectActivitySubjectKind::Membership => {
                    member_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Mandate => {
                    mandate_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::HostAttachment => {
                    attachment_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Session => {
                    session_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Work => {
                    work_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Claim => {
                    claim_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Handoff => {
                    handoff_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Intervention => {
                    intervention_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Artifact => {
                    artifact_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::ExternalReadback => {
                    readback_ids.contains(entry.subject_id.as_str())
                }
                FlowProjectActivitySubjectKind::Reconciliation => {
                    entry.subject_id == handoffs.reconciliation.reconciliation_id
                }
            };
            if !subject_exists {
                return Err(ContractError::new(
                    "unknown-flow-activity-subject",
                    "Flow activity subject must resolve in the exact project snapshots",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlowActivityEvidenceOperationId {
    #[serde(rename = "flow.project.artifacts.list")]
    ArtifactsList,
    #[serde(rename = "flow.project.artifact.report")]
    ArtifactReport,
    #[serde(rename = "flow.project.artifact.select")]
    ArtifactSelect,
    #[serde(rename = "flow.project.artifact.reject")]
    ArtifactReject,
    #[serde(rename = "flow.project.external-readbacks.list")]
    ExternalReadbacksList,
    #[serde(rename = "flow.project.external-readback.observe")]
    ExternalReadbackObserve,
    #[serde(rename = "flow.project.external-readback.verify")]
    ExternalReadbackVerify,
    #[serde(rename = "flow.project.external-readback.mark-uncertain")]
    ExternalReadbackMarkUncertain,
    #[serde(rename = "flow.project.activity.list")]
    ActivityList,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowActivityEvidenceOperationScope {
    ArtifactCollection,
    Artifact,
    ExternalReadbackCollection,
    ExternalReadback,
    ActivityCollection,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowActivityEvidenceOperationIntent {
    Read,
    Manage,
    Observe,
    Verify,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowActivityEvidenceIdempotencyLaw {
    None,
    ExactRequest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowActivityEvidenceResultKind {
    ArtifactPage,
    Artifact,
    ExternalReadbackPage,
    ExternalReadback,
    ActivityPage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowActivityEvidenceOperationDescriptor {
    pub protocol: String,
    pub operation_id: FlowActivityEvidenceOperationId,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub scope: FlowActivityEvidenceOperationScope,
    pub intent: FlowActivityEvidenceOperationIntent,
    pub requires_project_id: bool,
    pub requires_entity_id: bool,
    pub requires_expected_project_revision: bool,
    pub idempotency: FlowActivityEvidenceIdempotencyLaw,
    pub result_kind: FlowActivityEvidenceResultKind,
    pub grants_application_authority: bool,
    pub deletes_durable_history: bool,
    pub repeats_provider_work: bool,
    pub repeats_work_runtime: bool,
    pub repeats_handoff_transfer: bool,
    pub repeats_external_effects: bool,
}

impl FlowActivityEvidenceOperationDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_ACTIVITY_EVIDENCE_OPERATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        if self.grants_application_authority
            || self.deletes_durable_history
            || self.repeats_provider_work
            || self.repeats_work_runtime
            || self.repeats_handoff_transfer
            || self.repeats_external_effects
        {
            return Err(ContractError::new(
                "invalid-flow-activity-operation-authority",
                "Flow activity/evidence operations neither grant authority, delete history, nor repeat work, transfers, providers, or effects",
            ));
        }
        if self != &canonical_operation(self.operation_id) {
            return Err(ContractError::new(
                "invalid-flow-activity-evidence-operation",
                "Flow activity/evidence operation metadata must match the closed catalogue",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowActivityEvidenceOperationCatalogue {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub operations: Vec<FlowActivityEvidenceOperationDescriptor>,
}

impl FlowActivityEvidenceOperationCatalogue {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_ACTIVITY_EVIDENCE_OPERATION_CATALOGUE_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        let mut operation_ids = BTreeSet::new();
        for operation in &self.operations {
            operation.validate()?;
            if !operation_ids.insert(operation.operation_id) {
                return Err(ContractError::new(
                    "duplicate-flow-activity-evidence-operation",
                    "Flow activity/evidence operation identities must be unique",
                ));
            }
        }
        if self != &flow_activity_evidence_operation_catalogue() {
            return Err(ContractError::new(
                "invalid-flow-activity-evidence-operation-catalogue",
                "Flow activity/evidence catalogue must match the exact current inventory",
            ));
        }
        Ok(())
    }
}

pub fn flow_activity_evidence_operation_catalogue() -> FlowActivityEvidenceOperationCatalogue {
    FlowActivityEvidenceOperationCatalogue {
        protocol: FLOW_ACTIVITY_EVIDENCE_OPERATION_CATALOGUE_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        operations: [
            FlowActivityEvidenceOperationId::ArtifactsList,
            FlowActivityEvidenceOperationId::ArtifactReport,
            FlowActivityEvidenceOperationId::ArtifactSelect,
            FlowActivityEvidenceOperationId::ArtifactReject,
            FlowActivityEvidenceOperationId::ExternalReadbacksList,
            FlowActivityEvidenceOperationId::ExternalReadbackObserve,
            FlowActivityEvidenceOperationId::ExternalReadbackVerify,
            FlowActivityEvidenceOperationId::ExternalReadbackMarkUncertain,
            FlowActivityEvidenceOperationId::ActivityList,
        ]
        .into_iter()
        .map(canonical_operation)
        .collect(),
    }
}

fn canonical_operation(
    operation_id: FlowActivityEvidenceOperationId,
) -> FlowActivityEvidenceOperationDescriptor {
    use FlowActivityEvidenceIdempotencyLaw::{ExactRequest, None};
    use FlowActivityEvidenceOperationIntent::{Manage, Observe, Read, Verify};
    use FlowActivityEvidenceOperationScope::{
        ActivityCollection, Artifact, ArtifactCollection, ExternalReadback,
        ExternalReadbackCollection,
    };
    use FlowActivityEvidenceResultKind::{
        ActivityPage, Artifact as ArtifactResult, ArtifactPage,
        ExternalReadback as ExternalReadbackResult, ExternalReadbackPage,
    };

    let (scope, intent, requires_entity_id, idempotency, result_kind) = match operation_id {
        FlowActivityEvidenceOperationId::ArtifactsList => {
            (ArtifactCollection, Read, false, None, ArtifactPage)
        }
        FlowActivityEvidenceOperationId::ArtifactReport => (
            ArtifactCollection,
            Manage,
            false,
            ExactRequest,
            ArtifactResult,
        ),
        FlowActivityEvidenceOperationId::ArtifactSelect
        | FlowActivityEvidenceOperationId::ArtifactReject => {
            (Artifact, Manage, true, ExactRequest, ArtifactResult)
        }
        FlowActivityEvidenceOperationId::ExternalReadbacksList => (
            ExternalReadbackCollection,
            Read,
            false,
            None,
            ExternalReadbackPage,
        ),
        FlowActivityEvidenceOperationId::ExternalReadbackObserve
        | FlowActivityEvidenceOperationId::ExternalReadbackMarkUncertain => (
            ExternalReadback,
            Observe,
            true,
            ExactRequest,
            ExternalReadbackResult,
        ),
        FlowActivityEvidenceOperationId::ExternalReadbackVerify => (
            ExternalReadback,
            Verify,
            true,
            ExactRequest,
            ExternalReadbackResult,
        ),
        FlowActivityEvidenceOperationId::ActivityList => {
            (ActivityCollection, Read, false, None, ActivityPage)
        }
    };

    FlowActivityEvidenceOperationDescriptor {
        protocol: FLOW_ACTIVITY_EVIDENCE_OPERATION_PROTOCOL.to_owned(),
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
        repeats_provider_work: false,
        repeats_work_runtime: false,
        repeats_handoff_transfer: false,
        repeats_external_effects: false,
    }
}

fn validate_actor<'a>(
    actor: &FlowProjectHandoffActor,
    required_capability: FlowAgentMandateCapability,
    members: &BTreeMap<&'a str, &'a crate::flow_participation::FlowProjectMember>,
    mandates: &BTreeMap<&'a str, &'a crate::flow_participation::FlowAgentMandate>,
    sessions: &BTreeMap<&'a str, &'a crate::flow_presence::FlowProjectSessionBinding>,
) -> Result<(), ContractError> {
    let member = members.get(actor.membership_id.as_str()).ok_or_else(|| {
        ContractError::new(
            "unknown-flow-evidence-actor",
            "Flow artifact/evidence actor must be a project member",
        )
    })?;
    if member.state != FlowProjectMemberState::Active {
        return Err(ContractError::new(
            "inactive-flow-evidence-actor",
            "Flow artifact/evidence actions require active project membership",
        ));
    }
    match member.principal.kind {
        FlowProjectPrincipalKind::Person => {
            if actor.agent_mandate_id.is_some() {
                return Err(ContractError::new(
                    "person-flow-evidence-has-agent-mandate",
                    "Person artifact/evidence actor cannot reference an agent mandate",
                ));
            }
        }
        FlowProjectPrincipalKind::Agent => {
            let mandate_id = actor.agent_mandate_id.as_deref().ok_or_else(|| {
                ContractError::new(
                    "agent-flow-evidence-missing-mandate",
                    "Agent artifact/evidence actor requires an exact project mandate",
                )
            })?;
            let mandate = mandates.get(mandate_id).ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-evidence-mandate",
                    "Agent artifact/evidence mandate must exist in participation",
                )
            })?;
            if mandate.membership_id != member.membership_id
                || mandate.agent_id != member.principal.principal_id
                || mandate.state != FlowAgentMandateState::Active
                || !mandate.capabilities.contains(&required_capability)
            {
                return Err(ContractError::new(
                    "inactive-or-unauthorised-flow-evidence-agent",
                    "Agent artifact/evidence actor requires a matching active mandate capability",
                ));
            }
        }
    }
    if let Some(session_id) = actor.session_id.as_deref() {
        let session = sessions.get(session_id).ok_or_else(|| {
            ContractError::new(
                "unknown-flow-evidence-session",
                "Flow artifact/evidence actor session must exist in presence",
            )
        })?;
        if session.membership_id != actor.membership_id
            || session.agent_mandate_id != actor.agent_mandate_id
            || session.presence_state != FlowSessionPresenceState::Connected
        {
            return Err(ContractError::new(
                "flow-evidence-session-mismatch",
                "Flow artifact/evidence session must be connected and match the exact member and mandate",
            ));
        }
    }
    Ok(())
}

fn require_active_human_coordinator<'a>(
    membership_id: &str,
    members: &BTreeMap<&'a str, &'a crate::flow_participation::FlowProjectMember>,
) -> Result<(), ContractError> {
    let member = members.get(membership_id).ok_or_else(|| {
        ContractError::new(
            "unknown-flow-artifact-human-actor",
            "Flow artifact human actor must be a project member",
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
            "invalid-flow-artifact-human-actor",
            "Flow artifact selection and rejection require an active human owner or coordinator",
        ));
    }
    Ok(())
}

fn validate_artifact_available_evidence(
    artifact: &FlowProjectArtifact,
) -> Result<(), ContractError> {
    if let Some(root) = &artifact.exact_root {
        validate_digest(root)?;
    }
    if let Some(reference) = &artifact.artifact_reference {
        reference.validate()?;
        if reference.application_id != CurrentApplicationId::Flow
            || reference.application_revision != artifact.application_revision
            || reference.owner_application_id != CurrentApplicationId::Flow
            || reference.owner_kind != "project"
            || reference.owner_id != artifact.project_id
            || reference.record_kind != "artifact"
            || reference.logical_id != artifact.artifact_id
            || reference.exact_root != artifact.exact_root
            || reference.freshness != ReferenceFreshness::Current
            || reference.authority_state != ReferenceAuthorityState::Observed
        {
            return Err(ContractError::new(
                "invalid-flow-artifact-reference",
                "Flow artifact reference must be an exact current Flow-owned project observation",
            ));
        }
    }
    Ok(())
}

fn has_available_evidence(artifact: &FlowProjectArtifact) -> bool {
    artifact.available_at_unix_ms.is_some()
        || artifact.exact_root.is_some()
        || artifact.artifact_reference.is_some()
}

fn has_complete_available_evidence(artifact: &FlowProjectArtifact) -> bool {
    artifact.available_at_unix_ms.is_some()
        && artifact.exact_root.is_some()
        && artifact.artifact_reference.is_some()
}

fn optional_available_evidence_is_consistent(artifact: &FlowProjectArtifact) -> bool {
    !has_available_evidence(artifact) || has_complete_available_evidence(artifact)
}

fn validate_readback_reference(readback: &FlowExternalReadback) -> Result<(), ContractError> {
    if let Some(reference) = &readback.readback_reference {
        reference.validate()?;
        if reference.application_revision != readback.application_revision
            || reference.record_kind != "external-readback"
            || reference.logical_id != readback.readback_id
        {
            return Err(ContractError::new(
                "invalid-flow-readback-reference",
                "Flow external read-back reference must identify the exact current observation",
            ));
        }
    }
    Ok(())
}

fn activity_kind_matches_subject(
    kind: FlowProjectActivityKind,
    subject_kind: FlowProjectActivitySubjectKind,
) -> bool {
    matches!(
        (kind, subject_kind),
        (
            FlowProjectActivityKind::MembershipChanged,
            FlowProjectActivitySubjectKind::Membership
        ) | (
            FlowProjectActivityKind::MandateChanged,
            FlowProjectActivitySubjectKind::Mandate
        ) | (
            FlowProjectActivityKind::HostObserved,
            FlowProjectActivitySubjectKind::HostAttachment
        ) | (
            FlowProjectActivityKind::SessionObserved,
            FlowProjectActivitySubjectKind::Session
        ) | (
            FlowProjectActivityKind::WorkChanged,
            FlowProjectActivitySubjectKind::Work
        ) | (
            FlowProjectActivityKind::ClaimChanged,
            FlowProjectActivitySubjectKind::Claim
        ) | (
            FlowProjectActivityKind::HandoffChanged,
            FlowProjectActivitySubjectKind::Handoff
        ) | (
            FlowProjectActivityKind::InterventionChanged,
            FlowProjectActivitySubjectKind::Intervention
        ) | (
            FlowProjectActivityKind::ArtifactReported,
            FlowProjectActivitySubjectKind::Artifact
        ) | (
            FlowProjectActivityKind::ArtifactSelected,
            FlowProjectActivitySubjectKind::Artifact
        ) | (
            FlowProjectActivityKind::ExternalReadbackObserved,
            FlowProjectActivitySubjectKind::ExternalReadback
        ) | (
            FlowProjectActivityKind::ExternalEffectVerified,
            FlowProjectActivitySubjectKind::ExternalReadback
        ) | (
            FlowProjectActivityKind::ReconciliationObserved,
            FlowProjectActivitySubjectKind::Reconciliation
        )
    )
}

fn validate_activity_subject(
    kind: FlowProjectActivitySubjectKind,
    subject_id: &str,
) -> Result<(), ContractError> {
    let prefix = match kind {
        FlowProjectActivitySubjectKind::Project => "project/",
        FlowProjectActivitySubjectKind::Membership => "membership/",
        FlowProjectActivitySubjectKind::Mandate => "mandate/",
        FlowProjectActivitySubjectKind::HostAttachment => "attachment/",
        FlowProjectActivitySubjectKind::Session => "session/",
        FlowProjectActivitySubjectKind::Work => "work/",
        FlowProjectActivitySubjectKind::Claim => "claim/",
        FlowProjectActivitySubjectKind::Handoff => "handoff/",
        FlowProjectActivitySubjectKind::Intervention => "intervention/",
        FlowProjectActivitySubjectKind::Artifact => "artifact/",
        FlowProjectActivitySubjectKind::ExternalReadback => "readback/",
        FlowProjectActivitySubjectKind::Reconciliation => "handoff-reconciliation/",
    };
    validate_scoped_identifier(
        subject_id,
        prefix,
        MAX_SUBJECT_ID_BYTES,
        "invalid-flow-activity-subject",
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
            "Flow artifact lifecycle timestamp and actor evidence must appear together",
        ))
    }
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
            "Flow activity/evidence record belongs to a different project or application revision",
        ))
    }
}

fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-activity-evidence-protocol-mismatch",
            "Flow activity/evidence record uses an unsupported protocol",
        ))
    }
}

fn require_flow_application(
    application_id: CurrentApplicationId,
    application_revision: &str,
) -> Result<(), ContractError> {
    if application_id != CurrentApplicationId::Flow {
        return Err(ContractError::new(
            "invalid-flow-activity-application",
            "Flow activity/evidence records must be owned by the current Flow application",
        ));
    }
    if application_revision != CURRENT_SUITE_REVISION {
        return Err(ContractError::new(
            "flow-activity-application-revision-mismatch",
            "Flow activity/evidence records require the exact current application revision",
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
            "Flow activity/evidence revision must be positive",
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
            "Flow activity/evidence scoped identity is invalid",
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
            "invalid-flow-activity-evidence-digest",
            "Flow activity/evidence digest must be a lowercase SHA-256 digest",
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
            "Flow activity/evidence text is outside its byte bound",
        ))
    }
}

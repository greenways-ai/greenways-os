use crate::error::ContractError;
use crate::flow::{FlowWorkReference, FlowWorkState, FLOW_WORK_REFERENCE_PROTOCOL};
use crate::flow_participation::{
    FlowAgentMandateCapability, FlowAgentMandateState, FlowProjectMemberRole,
    FlowProjectMemberState, FlowProjectParticipationSnapshot, FlowProjectPrincipalKind,
};
use crate::suite::{CurrentApplicationId, CURRENT_SUITE_REVISION};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const FLOW_WORK_COORDINATION_PROTOCOL: &str =
    "greenways.flow.work-coordination/0-alpha";
pub const FLOW_WORK_DEPENDENCY_PROTOCOL: &str =
    "greenways.flow.work-dependency/0-alpha";
pub const FLOW_WORK_ASSIGNMENT_PROTOCOL: &str =
    "greenways.flow.work-assignment/0-alpha";
pub const FLOW_WORK_CLAIM_PROTOCOL: &str = "greenways.flow.work-claim/0-alpha";
pub const FLOW_WORK_COORDINATION_OPERATION_PROTOCOL: &str =
    "greenways.flow.work-coordination-operation/0-alpha";
pub const FLOW_WORK_COORDINATION_OPERATION_CATALOGUE_PROTOCOL: &str =
    "greenways.flow.work-coordination-operation-catalogue/0-alpha";

pub const FLOW_WORK_DEPENDENCIES_LIST_OPERATION: &str = "flow.work.dependencies.list";
pub const FLOW_WORK_DEPENDENCY_ADD_OPERATION: &str = "flow.work.dependency.add";
pub const FLOW_WORK_DEPENDENCY_UPDATE_OPERATION: &str = "flow.work.dependency.update";
pub const FLOW_WORK_ASSIGNMENTS_LIST_OPERATION: &str = "flow.work.assignments.list";
pub const FLOW_WORK_ASSIGN_OPERATION: &str = "flow.work.assign";
pub const FLOW_WORK_ASSIGNMENT_DECIDE_OPERATION: &str = "flow.work.assignment.decide";
pub const FLOW_WORK_ASSIGNMENT_RELEASE_OPERATION: &str = "flow.work.assignment.release";
pub const FLOW_WORK_CLAIMS_LIST_OPERATION: &str = "flow.work.claims.list";
pub const FLOW_WORK_CLAIM_OPERATION: &str = "flow.work.claim";
pub const FLOW_WORK_CLAIM_RELEASE_OPERATION: &str = "flow.work.claim.release";
pub const FLOW_WORK_CLAIM_RECONCILE_OPERATION: &str = "flow.work.claim.reconcile";

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_WORK_ID_BYTES: usize = 256;
const MAX_DEPENDENCY_ID_BYTES: usize = 256;
const MAX_ASSIGNMENT_ID_BYTES: usize = 256;
const MAX_CLAIM_ID_BYTES: usize = 256;
const MAX_MEMBERSHIP_ID_BYTES: usize = 256;
const MAX_MANDATE_ID_BYTES: usize = 256;
const MAX_WORK_ITEMS: usize = 512;
const MAX_DEPENDENCIES: usize = 2048;
const MAX_ASSIGNMENTS: usize = 1024;
const MAX_CLAIMS: usize = 2048;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkDependencyKind {
    Blocks,
    RequiresContext,
    RequiresArtifact,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkDependencyState {
    Proposed,
    Active,
    Satisfied,
    Waived,
    Cancelled,
}

impl FlowWorkDependencyState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Proposed,
                Self::Active | Self::Satisfied | Self::Waived | Self::Cancelled
            ) | (
                Self::Active,
                Self::Satisfied | Self::Waived | Self::Cancelled
            )
        )
    }

    const fn participates_in_graph(self) -> bool {
        matches!(self, Self::Proposed | Self::Active)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWorkDependency {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub dependency_id: String,
    pub revision: u64,
    pub work_id: String,
    pub depends_on_work_id: String,
    pub kind: FlowWorkDependencyKind,
    pub state: FlowWorkDependencyState,
    pub created_at_unix_ms: u64,
    pub resolved_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
}

impl FlowWorkDependency {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_WORK_DEPENDENCY_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.dependency_id,
            "dependency/",
            MAX_DEPENDENCY_ID_BYTES,
            "invalid-flow-dependency-id",
        )?;
        validate_scoped_identifier(
            &self.work_id,
            "work/",
            MAX_WORK_ID_BYTES,
            "invalid-flow-work-id",
        )?;
        validate_scoped_identifier(
            &self.depends_on_work_id,
            "work/",
            MAX_WORK_ID_BYTES,
            "invalid-flow-work-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-dependency-revision")?;
        if self.work_id == self.depends_on_work_id {
            return Err(ContractError::new(
                "self-referential-flow-dependency",
                "Flow work cannot depend on itself",
            ));
        }
        if self.created_at_unix_ms == 0
            || self
                .resolved_at_unix_ms
                .is_some_and(|value| value < self.created_at_unix_ms)
        {
            return Err(ContractError::new(
                "invalid-flow-dependency-time",
                "Flow dependency timestamps must be positive and monotonic",
            ));
        }
        let evidence_matches_state = match self.state {
            FlowWorkDependencyState::Proposed | FlowWorkDependencyState::Active => {
                self.resolved_at_unix_ms.is_none()
            }
            FlowWorkDependencyState::Satisfied
            | FlowWorkDependencyState::Waived
            | FlowWorkDependencyState::Cancelled => self.resolved_at_unix_ms.is_some(),
        };
        if !evidence_matches_state {
            return Err(ContractError::new(
                "flow-dependency-state-time-mismatch",
                "Flow dependency state requires matching resolution evidence",
            ));
        }
        reject_authority_transfer(
            self.authority_transfer,
            "flow-dependency-authority-transfer",
            "Flow dependencies do not transfer application authority",
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkAssignmentState {
    Proposed,
    Assigned,
    Accepted,
    Declined,
    Released,
    Revoked,
    Expired,
}

impl FlowWorkAssignmentState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Proposed,
                Self::Assigned | Self::Declined | Self::Revoked | Self::Expired
            ) | (
                Self::Assigned,
                Self::Accepted | Self::Declined | Self::Revoked | Self::Expired
            ) | (
                Self::Accepted,
                Self::Released | Self::Revoked | Self::Expired
            )
        )
    }

    const fn is_current(self) -> bool {
        matches!(self, Self::Proposed | Self::Assigned | Self::Accepted)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWorkAssignment {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub assignment_id: String,
    pub revision: u64,
    pub work_id: String,
    pub assignee_membership_id: String,
    pub assigned_by_membership_id: String,
    pub state: FlowWorkAssignmentState,
    pub assigned_at_unix_ms: u64,
    pub responded_at_unix_ms: Option<u64>,
    pub expires_at_unix_ms: Option<u64>,
    pub released_at_unix_ms: Option<u64>,
    pub revoked_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
}

impl FlowWorkAssignment {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_WORK_ASSIGNMENT_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.assignment_id,
            "assignment/",
            MAX_ASSIGNMENT_ID_BYTES,
            "invalid-flow-assignment-id",
        )?;
        validate_scoped_identifier(
            &self.work_id,
            "work/",
            MAX_WORK_ID_BYTES,
            "invalid-flow-work-id",
        )?;
        validate_scoped_identifier(
            &self.assignee_membership_id,
            "membership/",
            MAX_MEMBERSHIP_ID_BYTES,
            "invalid-flow-membership-id",
        )?;
        validate_scoped_identifier(
            &self.assigned_by_membership_id,
            "membership/",
            MAX_MEMBERSHIP_ID_BYTES,
            "invalid-flow-membership-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-assignment-revision")?;
        if self.assigned_at_unix_ms == 0
            || self
                .responded_at_unix_ms
                .is_some_and(|value| value < self.assigned_at_unix_ms)
            || self
                .expires_at_unix_ms
                .is_some_and(|value| value <= self.assigned_at_unix_ms)
            || self
                .released_at_unix_ms
                .is_some_and(|value| value < self.assigned_at_unix_ms)
            || self
                .revoked_at_unix_ms
                .is_some_and(|value| value < self.assigned_at_unix_ms)
        {
            return Err(ContractError::new(
                "invalid-flow-assignment-time",
                "Flow assignment timestamps must be positive and monotonic",
            ));
        }
        let evidence_matches_state = match self.state {
            FlowWorkAssignmentState::Proposed | FlowWorkAssignmentState::Assigned => {
                self.responded_at_unix_ms.is_none()
                    && self.released_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowWorkAssignmentState::Accepted | FlowWorkAssignmentState::Declined => {
                self.responded_at_unix_ms.is_some()
                    && self.released_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowWorkAssignmentState::Released => {
                self.responded_at_unix_ms.is_some()
                    && self.released_at_unix_ms.is_some()
                    && self.revoked_at_unix_ms.is_none()
            }
            FlowWorkAssignmentState::Revoked => self.revoked_at_unix_ms.is_some(),
            FlowWorkAssignmentState::Expired => {
                self.expires_at_unix_ms.is_some()
                    && self.released_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
        };
        if !evidence_matches_state {
            return Err(ContractError::new(
                "flow-assignment-state-time-mismatch",
                "Flow assignment state requires matching response or terminal evidence",
            ));
        }
        reject_authority_transfer(
            self.authority_transfer,
            "flow-assignment-authority-transfer",
            "Flow assignments do not transfer application authority",
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkClaimState {
    Proposed,
    Active,
    Released,
    Expired,
    Revoked,
    Stale,
}

impl FlowWorkClaimState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Proposed,
                Self::Active | Self::Expired | Self::Revoked
            ) | (
                Self::Active,
                Self::Released | Self::Expired | Self::Revoked | Self::Stale
            )
        )
    }

    const fn is_current(self) -> bool {
        matches!(self, Self::Proposed | Self::Active)
    }

    const fn is_active(self) -> bool {
        matches!(self, Self::Active)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkClaimContention {
    None,
    Contended,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkClaimStaleReason {
    LeaseExpired,
    MandateRevoked,
    MembershipRevoked,
    ProjectRevisionChanged,
    Superseded,
    ObservationLost,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWorkClaim {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub claim_id: String,
    pub revision: u64,
    pub work_id: String,
    pub claimant_membership_id: String,
    pub agent_mandate_id: Option<String>,
    pub state: FlowWorkClaimState,
    pub contention: FlowWorkClaimContention,
    pub lease_generation: u64,
    pub proposed_at_unix_ms: u64,
    pub activated_at_unix_ms: Option<u64>,
    pub last_observed_at_unix_ms: Option<u64>,
    pub expires_at_unix_ms: u64,
    pub released_at_unix_ms: Option<u64>,
    pub revoked_at_unix_ms: Option<u64>,
    pub stale_at_unix_ms: Option<u64>,
    pub stale_reason: Option<FlowWorkClaimStaleReason>,
    pub authority_transfer: bool,
    pub copies_work_runtime_state: bool,
}

impl FlowWorkClaim {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_WORK_CLAIM_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.claim_id,
            "claim/",
            MAX_CLAIM_ID_BYTES,
            "invalid-flow-claim-id",
        )?;
        validate_scoped_identifier(
            &self.work_id,
            "work/",
            MAX_WORK_ID_BYTES,
            "invalid-flow-work-id",
        )?;
        validate_scoped_identifier(
            &self.claimant_membership_id,
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
        require_positive_revision(self.revision, "invalid-flow-claim-revision")?;
        require_positive_revision(self.lease_generation, "invalid-flow-lease-generation")?;
        if self.proposed_at_unix_ms == 0
            || self.expires_at_unix_ms <= self.proposed_at_unix_ms
            || self
                .activated_at_unix_ms
                .is_some_and(|value| value < self.proposed_at_unix_ms)
            || self
                .last_observed_at_unix_ms
                .is_some_and(|value| value < self.proposed_at_unix_ms)
            || self
                .released_at_unix_ms
                .is_some_and(|value| value < self.proposed_at_unix_ms)
            || self
                .revoked_at_unix_ms
                .is_some_and(|value| value < self.proposed_at_unix_ms)
            || self
                .stale_at_unix_ms
                .is_some_and(|value| value < self.proposed_at_unix_ms)
        {
            return Err(ContractError::new(
                "invalid-flow-claim-time",
                "Flow claim timestamps must be positive and monotonic",
            ));
        }
        if let Some(activated_at) = self.activated_at_unix_ms {
            if self
                .last_observed_at_unix_ms
                .is_some_and(|value| value < activated_at)
                || self
                    .released_at_unix_ms
                    .is_some_and(|value| value < activated_at)
                || self
                    .stale_at_unix_ms
                    .is_some_and(|value| value < activated_at)
            {
                return Err(ContractError::new(
                    "invalid-flow-claim-time",
                    "Flow active claim evidence cannot predate activation",
                ));
            }
        }
        let evidence_matches_state = match self.state {
            FlowWorkClaimState::Proposed => {
                self.activated_at_unix_ms.is_none()
                    && self.last_observed_at_unix_ms.is_none()
                    && self.released_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
            }
            FlowWorkClaimState::Active => {
                self.activated_at_unix_ms.is_some()
                    && self.last_observed_at_unix_ms.is_some()
                    && self.released_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
                    && self
                        .last_observed_at_unix_ms
                        .is_some_and(|value| value < self.expires_at_unix_ms)
            }
            FlowWorkClaimState::Released => {
                self.activated_at_unix_ms.is_some()
                    && self.last_observed_at_unix_ms.is_some()
                    && self.released_at_unix_ms.is_some()
                    && self.revoked_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
            }
            FlowWorkClaimState::Expired => {
                self.released_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
            }
            FlowWorkClaimState::Revoked => {
                self.revoked_at_unix_ms.is_some()
                    && self.released_at_unix_ms.is_none()
                    && self.stale_at_unix_ms.is_none()
                    && self.stale_reason.is_none()
            }
            FlowWorkClaimState::Stale => {
                self.activated_at_unix_ms.is_some()
                    && self.last_observed_at_unix_ms.is_some()
                    && self.stale_at_unix_ms.is_some()
                    && self.stale_reason.is_some()
                    && self.released_at_unix_ms.is_none()
                    && self.revoked_at_unix_ms.is_none()
            }
        };
        if !evidence_matches_state {
            return Err(ContractError::new(
                "flow-claim-state-time-mismatch",
                "Flow claim state requires matching lease and terminal evidence",
            ));
        }
        if !self.state.is_active() && self.contention != FlowWorkClaimContention::None {
            return Err(ContractError::new(
                "invalid-flow-claim-contention",
                "Only active Flow claims may be marked contended",
            ));
        }
        if self.authority_transfer || self.copies_work_runtime_state {
            return Err(ContractError::new(
                "flow-claim-authority-or-runtime-copy",
                "Flow claims neither transfer authority nor copy Hara Work runtime state",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWorkCoordinationSnapshot {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub project_revision: u64,
    pub work: Vec<FlowWorkReference>,
    pub dependencies: Vec<FlowWorkDependency>,
    pub assignments: Vec<FlowWorkAssignment>,
    pub claims: Vec<FlowWorkClaim>,
}

impl FlowWorkCoordinationSnapshot {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_WORK_COORDINATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        require_positive_revision(self.project_revision, "invalid-flow-project-revision")?;
        if self.work.len() > MAX_WORK_ITEMS
            || self.dependencies.len() > MAX_DEPENDENCIES
            || self.assignments.len() > MAX_ASSIGNMENTS
            || self.claims.len() > MAX_CLAIMS
        {
            return Err(ContractError::new(
                "flow-work-coordination-limit",
                "Flow work coordination collections exceed their bounds",
            ));
        }

        let mut work_by_id = BTreeMap::new();
        for work in &self.work {
            work.validate()?;
            if work.protocol != FLOW_WORK_REFERENCE_PROTOCOL
                || work.application_revision != self.application_revision
                || work.project_id != self.project_id
            {
                return Err(ContractError::new(
                    "flow-coordination-work-mismatch",
                    "Flow coordination work must match the exact project and application revision",
                ));
            }
            if work_by_id.insert(work.work_id.as_str(), work).is_some() {
                return Err(ContractError::new(
                    "duplicate-flow-coordination-work",
                    "Flow coordination work identities must be unique",
                ));
            }
        }

        let mut dependency_ids = BTreeSet::new();
        let mut dependency_edges = BTreeSet::new();
        let mut graph = self
            .work
            .iter()
            .map(|work| (work.work_id.clone(), Vec::<String>::new()))
            .collect::<BTreeMap<_, _>>();
        for dependency in &self.dependencies {
            dependency.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &dependency.project_id,
                &dependency.application_revision,
                "flow-dependency-project-mismatch",
            )?;
            let work = work_by_id.get(dependency.work_id.as_str()).ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-dependency-work",
                    "Flow dependency must reference work in its coordination snapshot",
                )
            })?;
            work_by_id
                .get(dependency.depends_on_work_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-dependency-prerequisite",
                        "Flow dependency prerequisite must be in the coordination snapshot",
                    )
                })?;
            if !dependency_ids.insert(dependency.dependency_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-dependency-id",
                    "Flow dependency identities must be unique",
                ));
            }
            if !dependency_edges.insert((
                dependency.work_id.as_str(),
                dependency.depends_on_work_id.as_str(),
            )) {
                return Err(ContractError::new(
                    "duplicate-flow-dependency-edge",
                    "Flow dependency edges must be unique",
                ));
            }
            if dependency.state.participates_in_graph() {
                if is_terminal_work_state(work.state) {
                    return Err(ContractError::new(
                        "terminal-work-has-current-dependency",
                        "Terminal Flow work cannot retain a current dependency",
                    ));
                }
                graph
                    .get_mut(&dependency.work_id)
                    .expect("all dependency work should be present")
                    .push(dependency.depends_on_work_id.clone());
            }
        }
        if dependency_graph_has_cycle(&graph) {
            return Err(ContractError::new(
                "cyclic-flow-work-dependency",
                "Current Flow work dependencies must be acyclic",
            ));
        }

        let mut assignment_ids = BTreeSet::new();
        let mut current_assignment_work = BTreeSet::new();
        for assignment in &self.assignments {
            assignment.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &assignment.project_id,
                &assignment.application_revision,
                "flow-assignment-project-mismatch",
            )?;
            let work = work_by_id.get(assignment.work_id.as_str()).ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-assignment-work",
                    "Flow assignment must reference work in its coordination snapshot",
                )
            })?;
            if !assignment_ids.insert(assignment.assignment_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-assignment-id",
                    "Flow assignment identities must be unique",
                ));
            }
            if assignment.state.is_current() {
                if is_terminal_work_state(work.state) {
                    return Err(ContractError::new(
                        "terminal-work-has-current-assignment",
                        "Terminal Flow work cannot retain a current assignment",
                    ));
                }
                if !current_assignment_work.insert(assignment.work_id.as_str()) {
                    return Err(ContractError::new(
                        "duplicate-current-flow-assignment",
                        "Flow work may have only one current assignment",
                    ));
                }
            }
        }

        let mut claim_ids = BTreeSet::new();
        let mut lease_generations = BTreeSet::new();
        let mut active_claimants = BTreeSet::new();
        let mut active_claims_by_work: BTreeMap<&str, Vec<&FlowWorkClaim>> = BTreeMap::new();
        for claim in &self.claims {
            claim.validate()?;
            require_record_membership(
                &self.project_id,
                &self.application_revision,
                &claim.project_id,
                &claim.application_revision,
                "flow-claim-project-mismatch",
            )?;
            let work = work_by_id.get(claim.work_id.as_str()).ok_or_else(|| {
                ContractError::new(
                    "unknown-flow-claim-work",
                    "Flow claim must reference work in its coordination snapshot",
                )
            })?;
            if !claim_ids.insert(claim.claim_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-claim-id",
                    "Flow claim identities must be unique",
                ));
            }
            if !lease_generations.insert((claim.work_id.as_str(), claim.lease_generation)) {
                return Err(ContractError::new(
                    "duplicate-flow-lease-generation",
                    "Flow claim lease generations must be unique per work item",
                ));
            }
            if claim.state.is_current() && is_terminal_work_state(work.state) {
                return Err(ContractError::new(
                    "terminal-work-has-current-claim",
                    "Terminal Flow work cannot retain a current claim",
                ));
            }
            if claim.state.is_active() {
                if !active_claimants.insert((
                    claim.work_id.as_str(),
                    claim.claimant_membership_id.as_str(),
                )) {
                    return Err(ContractError::new(
                        "duplicate-active-flow-claimant",
                        "One Flow membership cannot hold two active claims on the same work",
                    ));
                }
                active_claims_by_work
                    .entry(claim.work_id.as_str())
                    .or_default()
                    .push(claim);
            }
        }
        for claims in active_claims_by_work.values() {
            let expected = if claims.len() > 1 {
                FlowWorkClaimContention::Contended
            } else {
                FlowWorkClaimContention::None
            };
            if claims.iter().any(|claim| claim.contention != expected) {
                return Err(ContractError::new(
                    "flow-claim-contention-mismatch",
                    "Flow active claim contention must match the observed overlap",
                ));
            }
        }
        Ok(())
    }

    pub fn validate_against_participation(
        &self,
        participation: &FlowProjectParticipationSnapshot,
    ) -> Result<(), ContractError> {
        self.validate()?;
        participation.validate()?;
        if self.project_id != participation.project_id
            || self.project_revision != participation.project_revision
            || self.application_revision != participation.application_revision
        {
            return Err(ContractError::new(
                "flow-work-participation-mismatch",
                "Flow work coordination and participation must describe the same project revision",
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

        for assignment in &self.assignments {
            let assignee = members
                .get(assignment.assignee_membership_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-assignment-assignee",
                        "Flow assignment assignee must be a project member",
                    )
                })?;
            let assigner = members
                .get(assignment.assigned_by_membership_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-assignment-assigner",
                        "Flow assignment actor must be a project member",
                    )
                })?;
            if assignment.state.is_current() {
                let assignee_state_is_valid = match assignment.state {
                    FlowWorkAssignmentState::Proposed => matches!(
                        assignee.state,
                        FlowProjectMemberState::Invited | FlowProjectMemberState::Active
                    ),
                    FlowWorkAssignmentState::Assigned | FlowWorkAssignmentState::Accepted => {
                        assignee.state == FlowProjectMemberState::Active
                    }
                    _ => true,
                };
                if !assignee_state_is_valid {
                    return Err(ContractError::new(
                        "flow-assignment-assignee-state-mismatch",
                        "Current Flow assignments require a compatible current assignee",
                    ));
                }
                if assigner.state != FlowProjectMemberState::Active
                    || assigner.principal.kind != FlowProjectPrincipalKind::Person
                    || !matches!(
                        assigner.role,
                        FlowProjectMemberRole::Owner | FlowProjectMemberRole::Coordinator
                    )
                {
                    return Err(ContractError::new(
                        "invalid-flow-assignment-actor",
                        "Current Flow assignments require an active human owner or coordinator",
                    ));
                }
            }
        }

        for claim in &self.claims {
            let member = members
                .get(claim.claimant_membership_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-claimant",
                        "Flow claim must reference a project membership",
                    )
                })?;
            match member.principal.kind {
                FlowProjectPrincipalKind::Person => {
                    if claim.agent_mandate_id.is_some() {
                        return Err(ContractError::new(
                            "person-flow-claim-has-agent-mandate",
                            "A person claim cannot reference an agent mandate",
                        ));
                    }
                    if claim.state.is_current() && member.state != FlowProjectMemberState::Active {
                        return Err(ContractError::new(
                            "inactive-person-flow-claim",
                            "A current person claim requires active project membership",
                        ));
                    }
                }
                FlowProjectPrincipalKind::Agent => {
                    let mandate_id = claim.agent_mandate_id.as_deref().ok_or_else(|| {
                        ContractError::new(
                            "agent-flow-claim-missing-mandate",
                            "An agent claim requires an exact project mandate reference",
                        )
                    })?;
                    let mandate = mandates.get(mandate_id).ok_or_else(|| {
                        ContractError::new(
                            "unknown-flow-claim-mandate",
                            "An agent claim mandate must exist in project participation",
                        )
                    })?;
                    if mandate.membership_id != member.membership_id
                        || mandate.agent_id != member.principal.principal_id
                    {
                        return Err(ContractError::new(
                            "flow-claim-mandate-principal-mismatch",
                            "Flow claim mandate must match its agent membership",
                        ));
                    }
                    if claim.state.is_current()
                        && (member.state != FlowProjectMemberState::Active
                            || mandate.state != FlowAgentMandateState::Active
                            || !mandate
                                .capabilities
                                .contains(&FlowAgentMandateCapability::WorkClaim))
                    {
                        return Err(ContractError::new(
                            "inactive-or-unauthorised-flow-agent-claim",
                            "A current agent claim requires active membership and a work-claim mandate",
                        ));
                    }
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlowWorkCoordinationOperationId {
    #[serde(rename = "flow.work.dependencies.list")]
    DependenciesList,
    #[serde(rename = "flow.work.dependency.add")]
    DependencyAdd,
    #[serde(rename = "flow.work.dependency.update")]
    DependencyUpdate,
    #[serde(rename = "flow.work.assignments.list")]
    AssignmentsList,
    #[serde(rename = "flow.work.assign")]
    Assign,
    #[serde(rename = "flow.work.assignment.decide")]
    AssignmentDecide,
    #[serde(rename = "flow.work.assignment.release")]
    AssignmentRelease,
    #[serde(rename = "flow.work.claims.list")]
    ClaimsList,
    #[serde(rename = "flow.work.claim")]
    Claim,
    #[serde(rename = "flow.work.claim.release")]
    ClaimRelease,
    #[serde(rename = "flow.work.claim.reconcile")]
    ClaimReconcile,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkCoordinationOperationScope {
    DependencyCollection,
    Dependency,
    AssignmentCollection,
    Assignment,
    ClaimCollection,
    Claim,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkCoordinationOperationIntent {
    Read,
    Manage,
    Reconcile,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkCoordinationIdempotencyLaw {
    None,
    ExactRequest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkCoordinationResultKind {
    DependencyPage,
    Dependency,
    AssignmentPage,
    Assignment,
    ClaimPage,
    Claim,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWorkCoordinationOperationDescriptor {
    pub protocol: String,
    pub operation_id: FlowWorkCoordinationOperationId,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub scope: FlowWorkCoordinationOperationScope,
    pub intent: FlowWorkCoordinationOperationIntent,
    pub requires_project_id: bool,
    pub requires_work_id: bool,
    pub requires_entity_id: bool,
    pub requires_expected_project_revision: bool,
    pub idempotency: FlowWorkCoordinationIdempotencyLaw,
    pub result_kind: FlowWorkCoordinationResultKind,
    pub grants_application_authority: bool,
    pub deletes_durable_history: bool,
    pub copies_work_runtime_state: bool,
}

impl FlowWorkCoordinationOperationDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_WORK_COORDINATION_OPERATION_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        if self.grants_application_authority
            || self.deletes_durable_history
            || self.copies_work_runtime_state
        {
            return Err(ContractError::new(
                "invalid-flow-work-operation-authority",
                "Flow work operations neither grant authority, delete history, nor copy Work runtime state",
            ));
        }
        if self != &canonical_operation(self.operation_id) {
            return Err(ContractError::new(
                "invalid-flow-work-coordination-operation",
                "Flow work coordination operation metadata must match the closed catalogue",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWorkCoordinationOperationCatalogue {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub operations: Vec<FlowWorkCoordinationOperationDescriptor>,
}

impl FlowWorkCoordinationOperationCatalogue {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_WORK_COORDINATION_OPERATION_CATALOGUE_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        let mut ids = BTreeSet::new();
        for operation in &self.operations {
            operation.validate()?;
            if !ids.insert(operation.operation_id) {
                return Err(ContractError::new(
                    "duplicate-flow-work-coordination-operation",
                    "Flow work coordination operation identities must be unique",
                ));
            }
        }
        if self != &flow_work_coordination_operation_catalogue() {
            return Err(ContractError::new(
                "invalid-flow-work-coordination-operation-catalogue",
                "Flow work coordination catalogue must match the exact current inventory",
            ));
        }
        Ok(())
    }
}

pub fn flow_work_coordination_operation_catalogue() -> FlowWorkCoordinationOperationCatalogue {
    FlowWorkCoordinationOperationCatalogue {
        protocol: FLOW_WORK_COORDINATION_OPERATION_CATALOGUE_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        operations: [
            FlowWorkCoordinationOperationId::DependenciesList,
            FlowWorkCoordinationOperationId::DependencyAdd,
            FlowWorkCoordinationOperationId::DependencyUpdate,
            FlowWorkCoordinationOperationId::AssignmentsList,
            FlowWorkCoordinationOperationId::Assign,
            FlowWorkCoordinationOperationId::AssignmentDecide,
            FlowWorkCoordinationOperationId::AssignmentRelease,
            FlowWorkCoordinationOperationId::ClaimsList,
            FlowWorkCoordinationOperationId::Claim,
            FlowWorkCoordinationOperationId::ClaimRelease,
            FlowWorkCoordinationOperationId::ClaimReconcile,
        ]
        .into_iter()
        .map(canonical_operation)
        .collect(),
    }
}

fn canonical_operation(
    operation_id: FlowWorkCoordinationOperationId,
) -> FlowWorkCoordinationOperationDescriptor {
    use FlowWorkCoordinationIdempotencyLaw::{ExactRequest, None};
    use FlowWorkCoordinationOperationIntent::{Manage, Read, Reconcile};
    use FlowWorkCoordinationOperationScope::{
        Assignment, AssignmentCollection, Claim, ClaimCollection, Dependency, DependencyCollection,
    };
    use FlowWorkCoordinationResultKind::{
        Assignment as AssignmentResult, AssignmentPage, Claim as ClaimResult, ClaimPage,
        Dependency as DependencyResult, DependencyPage,
    };

    let (
        scope,
        intent,
        requires_entity_id,
        requires_expected_project_revision,
        idempotency,
        result_kind,
    ) = match operation_id {
        FlowWorkCoordinationOperationId::DependenciesList => (
            DependencyCollection,
            Read,
            false,
            false,
            None,
            DependencyPage,
        ),
        FlowWorkCoordinationOperationId::DependencyAdd => (
            DependencyCollection,
            Manage,
            false,
            true,
            ExactRequest,
            DependencyResult,
        ),
        FlowWorkCoordinationOperationId::DependencyUpdate => (
            Dependency,
            Manage,
            true,
            true,
            ExactRequest,
            DependencyResult,
        ),
        FlowWorkCoordinationOperationId::AssignmentsList => (
            AssignmentCollection,
            Read,
            false,
            false,
            None,
            AssignmentPage,
        ),
        FlowWorkCoordinationOperationId::Assign => (
            AssignmentCollection,
            Manage,
            false,
            true,
            ExactRequest,
            AssignmentResult,
        ),
        FlowWorkCoordinationOperationId::AssignmentDecide
        | FlowWorkCoordinationOperationId::AssignmentRelease => (
            Assignment,
            Manage,
            true,
            true,
            ExactRequest,
            AssignmentResult,
        ),
        FlowWorkCoordinationOperationId::ClaimsList => {
            (ClaimCollection, Read, false, false, None, ClaimPage)
        }
        FlowWorkCoordinationOperationId::Claim => (
            ClaimCollection,
            Manage,
            false,
            true,
            ExactRequest,
            ClaimResult,
        ),
        FlowWorkCoordinationOperationId::ClaimRelease => (
            Claim,
            Manage,
            true,
            true,
            ExactRequest,
            ClaimResult,
        ),
        FlowWorkCoordinationOperationId::ClaimReconcile => (
            Claim,
            Reconcile,
            true,
            true,
            ExactRequest,
            ClaimResult,
        ),
    };

    FlowWorkCoordinationOperationDescriptor {
        protocol: FLOW_WORK_COORDINATION_OPERATION_PROTOCOL.to_owned(),
        operation_id,
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        scope,
        intent,
        requires_project_id: true,
        requires_work_id: true,
        requires_entity_id,
        requires_expected_project_revision,
        idempotency,
        result_kind,
        grants_application_authority: false,
        deletes_durable_history: false,
        copies_work_runtime_state: false,
    }
}

fn dependency_graph_has_cycle(graph: &BTreeMap<String, Vec<String>>) -> bool {
    fn visit(
        node: &str,
        graph: &BTreeMap<String, Vec<String>>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> bool {
        if visited.contains(node) {
            return false;
        }
        if !visiting.insert(node.to_owned()) {
            return true;
        }
        if let Some(next_nodes) = graph.get(node) {
            for next in next_nodes {
                if visit(next, graph, visiting, visited) {
                    return true;
                }
            }
        }
        visiting.remove(node);
        visited.insert(node.to_owned());
        false
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    graph
        .keys()
        .any(|node| visit(node, graph, &mut visiting, &mut visited))
}

fn is_terminal_work_state(state: FlowWorkState) -> bool {
    matches!(
        state,
        FlowWorkState::Completed | FlowWorkState::Cancelled | FlowWorkState::Failed
    )
}

fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-work-coordination-protocol-mismatch",
            "Flow work coordination record uses an unsupported protocol",
        ))
    }
}

fn require_flow_application(
    application_id: CurrentApplicationId,
    application_revision: &str,
) -> Result<(), ContractError> {
    if application_id != CurrentApplicationId::Flow {
        return Err(ContractError::new(
            "invalid-flow-work-coordination-application",
            "Flow work coordination records must be owned by the current Flow application",
        ));
    }
    if application_revision != CURRENT_SUITE_REVISION {
        return Err(ContractError::new(
            "flow-work-coordination-revision-mismatch",
            "Flow work coordination records require the exact current application revision",
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
            "Flow work coordination record belongs to a different project or application revision",
        ))
    }
}

fn require_positive_revision(revision: u64, code: &'static str) -> Result<(), ContractError> {
    if revision > 0 {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow work coordination revision must be positive",
        ))
    }
}

fn reject_authority_transfer(
    authority_transfer: bool,
    code: &'static str,
    message: &'static str,
) -> Result<(), ContractError> {
    if authority_transfer {
        Err(ContractError::new(code, message))
    } else {
        Ok(())
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
            "Flow work coordination scoped identity is invalid",
        ))
    }
}

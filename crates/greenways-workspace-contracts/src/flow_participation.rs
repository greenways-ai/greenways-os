use crate::error::ContractError;
use crate::suite::{CurrentApplicationId, CURRENT_SUITE_REVISION};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const FLOW_PROJECT_PARTICIPATION_PROTOCOL: &str =
    "greenways.flow.project-participation/0-alpha";
pub const FLOW_PROJECT_MEMBER_PROTOCOL: &str = "greenways.flow.project-member/0-alpha";
pub const FLOW_AGENT_MANDATE_PROTOCOL: &str = "greenways.flow.agent-mandate/0-alpha";
pub const FLOW_PARTICIPATION_OPERATION_PROTOCOL: &str =
    "greenways.flow.participation-operation/0-alpha";
pub const FLOW_PARTICIPATION_OPERATION_CATALOGUE_PROTOCOL: &str =
    "greenways.flow.participation-operation-catalogue/0-alpha";

pub const FLOW_PROJECT_MEMBERS_LIST_OPERATION: &str = "flow.project.members.list";
pub const FLOW_PROJECT_MEMBER_ADD_OPERATION: &str = "flow.project.member.add";
pub const FLOW_PROJECT_MEMBER_UPDATE_OPERATION: &str = "flow.project.member.update";
pub const FLOW_PROJECT_MEMBER_REMOVE_OPERATION: &str = "flow.project.member.remove";
pub const FLOW_PROJECT_AGENTS_LIST_OPERATION: &str = "flow.project.agents.list";
pub const FLOW_PROJECT_AGENT_ADD_OPERATION: &str = "flow.project.agent.add";
pub const FLOW_PROJECT_AGENT_UPDATE_OPERATION: &str = "flow.project.agent.update";
pub const FLOW_PROJECT_AGENT_REVOKE_OPERATION: &str = "flow.project.agent.revoke";

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_MEMBERSHIP_ID_BYTES: usize = 256;
const MAX_MANDATE_ID_BYTES: usize = 256;
const MAX_PRINCIPAL_ID_BYTES: usize = 256;
const MAX_PROJECT_MEMBERS: usize = 256;
const MAX_AGENT_MANDATES: usize = 256;
const MAX_MANDATE_CAPABILITIES: usize = 16;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectPrincipalKind {
    Person,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectPrincipalReference {
    pub kind: FlowProjectPrincipalKind,
    pub principal_id: String,
    pub identity_revision: u64,
}

impl FlowProjectPrincipalReference {
    pub fn validate(&self) -> Result<(), ContractError> {
        let prefix = match self.kind {
            FlowProjectPrincipalKind::Person => "person/",
            FlowProjectPrincipalKind::Agent => "agent/",
        };
        validate_scoped_identifier(
            &self.principal_id,
            prefix,
            MAX_PRINCIPAL_ID_BYTES,
            "invalid-flow-project-principal",
        )?;
        require_positive_revision(self.identity_revision, "invalid-flow-principal-revision")
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectMemberRole {
    Owner,
    Coordinator,
    Contributor,
    Observer,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectMemberState {
    Invited,
    Active,
    Suspended,
    Revoked,
    Expired,
}

impl FlowProjectMemberState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Invited, Self::Active | Self::Revoked | Self::Expired)
                | (
                    Self::Active,
                    Self::Suspended | Self::Revoked | Self::Expired
                )
                | (
                    Self::Suspended,
                    Self::Active | Self::Revoked | Self::Expired
                )
        )
    }

    const fn is_current(self) -> bool {
        matches!(self, Self::Invited | Self::Active | Self::Suspended)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectMember {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub membership_id: String,
    pub revision: u64,
    pub principal: FlowProjectPrincipalReference,
    pub role: FlowProjectMemberRole,
    pub state: FlowProjectMemberState,
    pub invited_at_unix_ms: u64,
    pub activated_at_unix_ms: Option<u64>,
    pub expires_at_unix_ms: Option<u64>,
    pub revoked_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
}

impl FlowProjectMember {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_MEMBER_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.membership_id,
            "membership/",
            MAX_MEMBERSHIP_ID_BYTES,
            "invalid-flow-membership-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-membership-revision")?;
        self.principal.validate()?;

        if self.role == FlowProjectMemberRole::Owner
            && self.principal.kind != FlowProjectPrincipalKind::Person
        {
            return Err(ContractError::new(
                "agent-cannot-own-flow-project",
                "A Flow project owner must reference a person identity",
            ));
        }
        if self.invited_at_unix_ms == 0 {
            return Err(ContractError::new(
                "invalid-flow-membership-time",
                "Flow project invitation time must be positive",
            ));
        }
        if self
            .activated_at_unix_ms
            .is_some_and(|value| value < self.invited_at_unix_ms)
            || self
                .expires_at_unix_ms
                .is_some_and(|value| value <= self.invited_at_unix_ms)
            || self
                .revoked_at_unix_ms
                .is_some_and(|value| value < self.invited_at_unix_ms)
        {
            return Err(ContractError::new(
                "invalid-flow-membership-time",
                "Flow project membership timestamps must be monotonic",
            ));
        }

        let times_are_valid = match self.state {
            FlowProjectMemberState::Invited => {
                self.activated_at_unix_ms.is_none() && self.revoked_at_unix_ms.is_none()
            }
            FlowProjectMemberState::Active | FlowProjectMemberState::Suspended => {
                self.activated_at_unix_ms.is_some() && self.revoked_at_unix_ms.is_none()
            }
            FlowProjectMemberState::Revoked => self.revoked_at_unix_ms.is_some(),
            FlowProjectMemberState::Expired => {
                self.expires_at_unix_ms.is_some() && self.revoked_at_unix_ms.is_none()
            }
        };
        if !times_are_valid {
            return Err(ContractError::new(
                "flow-membership-state-time-mismatch",
                "Flow project membership state requires matching lifecycle evidence",
            ));
        }
        if self.authority_transfer {
            return Err(ContractError::new(
                "flow-membership-authority-transfer",
                "Flow project membership does not transfer application authority",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum FlowAgentMandateCapability {
    ProjectRead,
    WorkRead,
    WorkCreate,
    WorkUpdate,
    WorkTransition,
    BuildoutRead,
    BuildoutCreate,
    BuildoutUpdate,
    BuildoutTransition,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowAgentMandateState {
    Proposed,
    Active,
    Suspended,
    Revoked,
    Expired,
}

impl FlowAgentMandateState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Proposed, Self::Active | Self::Revoked | Self::Expired)
                | (
                    Self::Active,
                    Self::Suspended | Self::Revoked | Self::Expired
                )
                | (
                    Self::Suspended,
                    Self::Active | Self::Revoked | Self::Expired
                )
        )
    }

    const fn is_current(self) -> bool {
        matches!(self, Self::Proposed | Self::Active | Self::Suspended)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowAgentMandate {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub mandate_id: String,
    pub revision: u64,
    pub membership_id: String,
    pub agent_id: String,
    pub state: FlowAgentMandateState,
    pub capabilities: Vec<FlowAgentMandateCapability>,
    pub valid_from_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
    pub revoked_at_unix_ms: Option<u64>,
    pub authority_transfer: bool,
}

impl FlowAgentMandate {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_AGENT_MANDATE_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.mandate_id,
            "mandate/",
            MAX_MANDATE_ID_BYTES,
            "invalid-flow-mandate-id",
        )?;
        validate_scoped_identifier(
            &self.membership_id,
            "membership/",
            MAX_MEMBERSHIP_ID_BYTES,
            "invalid-flow-membership-id",
        )?;
        validate_scoped_identifier(
            &self.agent_id,
            "agent/",
            MAX_PRINCIPAL_ID_BYTES,
            "invalid-flow-agent-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-mandate-revision")?;

        if self.capabilities.is_empty()
            || self.capabilities.len() > MAX_MANDATE_CAPABILITIES
            || self.capabilities.iter().collect::<BTreeSet<_>>().len() != self.capabilities.len()
        {
            return Err(ContractError::new(
                "invalid-flow-mandate-capabilities",
                "Flow agent mandate capabilities must be bounded, non-empty, and unique",
            ));
        }
        if self.valid_from_unix_ms == 0
            || self
                .expires_at_unix_ms
                .is_some_and(|value| value <= self.valid_from_unix_ms)
            || self
                .revoked_at_unix_ms
                .is_some_and(|value| value < self.valid_from_unix_ms)
        {
            return Err(ContractError::new(
                "invalid-flow-mandate-time",
                "Flow agent mandate timestamps must be positive and monotonic",
            ));
        }
        let times_are_valid = match self.state {
            FlowAgentMandateState::Proposed
            | FlowAgentMandateState::Active
            | FlowAgentMandateState::Suspended => self.revoked_at_unix_ms.is_none(),
            FlowAgentMandateState::Revoked => self.revoked_at_unix_ms.is_some(),
            FlowAgentMandateState::Expired => {
                self.expires_at_unix_ms.is_some() && self.revoked_at_unix_ms.is_none()
            }
        };
        if !times_are_valid {
            return Err(ContractError::new(
                "flow-mandate-state-time-mismatch",
                "Flow agent mandate state requires matching lifecycle evidence",
            ));
        }
        if self.authority_transfer {
            return Err(ContractError::new(
                "flow-mandate-authority-transfer",
                "Flow agent mandates do not transfer application or provider authority",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectParticipationSnapshot {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub project_revision: u64,
    pub members: Vec<FlowProjectMember>,
    pub agent_mandates: Vec<FlowAgentMandate>,
}

impl FlowProjectParticipationSnapshot {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_PARTICIPATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        require_positive_revision(self.project_revision, "invalid-flow-project-revision")?;
        if self.members.is_empty() || self.members.len() > MAX_PROJECT_MEMBERS {
            return Err(ContractError::new(
                "invalid-flow-project-members",
                "Flow project participation requires a bounded non-empty member list",
            ));
        }
        if self.agent_mandates.len() > MAX_AGENT_MANDATES {
            return Err(ContractError::new(
                "too-many-flow-agent-mandates",
                "Flow project agent mandate collection exceeds its bound",
            ));
        }

        let mut members_by_id = BTreeMap::new();
        let mut principals = BTreeSet::new();
        let mut active_human_owners = 0usize;
        for member in &self.members {
            member.validate()?;
            require_project_membership(
                &self.project_id,
                &member.project_id,
                "cross-project-flow-membership",
            )?;
            if member.application_revision != self.application_revision {
                return Err(ContractError::new(
                    "flow-membership-revision-mismatch",
                    "Flow membership application revision must match its project",
                ));
            }
            if members_by_id
                .insert(member.membership_id.as_str(), member)
                .is_some()
            {
                return Err(ContractError::new(
                    "duplicate-flow-membership-id",
                    "Flow membership identities must be unique within a project",
                ));
            }
            if !principals.insert((
                member.principal.kind,
                member.principal.principal_id.as_str(),
            )) {
                return Err(ContractError::new(
                    "duplicate-flow-project-principal",
                    "A person or agent may appear only once in a Flow project participation snapshot",
                ));
            }
            if member.principal.kind == FlowProjectPrincipalKind::Person
                && member.role == FlowProjectMemberRole::Owner
                && member.state == FlowProjectMemberState::Active
            {
                active_human_owners += 1;
            }
        }
        if active_human_owners == 0 {
            return Err(ContractError::new(
                "missing-active-human-flow-owner",
                "A current Flow project participation snapshot requires an active human owner",
            ));
        }

        let mut mandate_ids = BTreeSet::new();
        let mut current_mandates = BTreeSet::new();
        for mandate in &self.agent_mandates {
            mandate.validate()?;
            require_project_membership(
                &self.project_id,
                &mandate.project_id,
                "cross-project-flow-mandate",
            )?;
            if mandate.application_revision != self.application_revision {
                return Err(ContractError::new(
                    "flow-mandate-revision-mismatch",
                    "Flow mandate application revision must match its project",
                ));
            }
            if !mandate_ids.insert(mandate.mandate_id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-flow-mandate-id",
                    "Flow mandate identities must be unique within a project",
                ));
            }
            let member = members_by_id
                .get(mandate.membership_id.as_str())
                .ok_or_else(|| {
                    ContractError::new(
                        "orphaned-flow-agent-mandate",
                        "Flow agent mandate must reference a project membership",
                    )
                })?;
            if member.principal.kind != FlowProjectPrincipalKind::Agent
                || member.principal.principal_id != mandate.agent_id
            {
                return Err(ContractError::new(
                    "flow-agent-mandate-principal-mismatch",
                    "Flow agent mandate must match its agent membership identity",
                ));
            }
            if mandate.state.is_current()
                && !current_mandates.insert(mandate.membership_id.as_str())
            {
                return Err(ContractError::new(
                    "duplicate-current-flow-agent-mandate",
                    "A Flow agent membership may have only one current mandate",
                ));
            }
            let membership_state_is_valid = match mandate.state {
                FlowAgentMandateState::Proposed => matches!(
                    member.state,
                    FlowProjectMemberState::Invited | FlowProjectMemberState::Active
                ),
                FlowAgentMandateState::Active => member.state == FlowProjectMemberState::Active,
                FlowAgentMandateState::Suspended => matches!(
                    member.state,
                    FlowProjectMemberState::Active | FlowProjectMemberState::Suspended
                ),
                FlowAgentMandateState::Revoked | FlowAgentMandateState::Expired => true,
            };
            if !membership_state_is_valid
                || (!member.state.is_current() && mandate.state.is_current())
            {
                return Err(ContractError::new(
                    "flow-agent-mandate-membership-state-mismatch",
                    "Current Flow agent mandates require a compatible current membership",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlowParticipationOperationId {
    #[serde(rename = "flow.project.members.list")]
    MembersList,
    #[serde(rename = "flow.project.member.add")]
    MemberAdd,
    #[serde(rename = "flow.project.member.update")]
    MemberUpdate,
    #[serde(rename = "flow.project.member.remove")]
    MemberRemove,
    #[serde(rename = "flow.project.agents.list")]
    AgentsList,
    #[serde(rename = "flow.project.agent.add")]
    AgentAdd,
    #[serde(rename = "flow.project.agent.update")]
    AgentUpdate,
    #[serde(rename = "flow.project.agent.revoke")]
    AgentRevoke,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowParticipationOperationScope {
    MemberCollection,
    Member,
    AgentCollection,
    AgentMandate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowParticipationOperationIntent {
    Read,
    Manage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowParticipationIdempotencyLaw {
    None,
    ExactRequest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowParticipationResultKind {
    MemberPage,
    Member,
    AgentPage,
    AgentMandate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowParticipationOperationDescriptor {
    pub protocol: String,
    pub operation_id: FlowParticipationOperationId,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub scope: FlowParticipationOperationScope,
    pub intent: FlowParticipationOperationIntent,
    pub requires_project_id: bool,
    pub requires_entity_id: bool,
    pub requires_expected_project_revision: bool,
    pub idempotency: FlowParticipationIdempotencyLaw,
    pub result_kind: FlowParticipationResultKind,
    pub grants_application_authority: bool,
    pub deletes_durable_history: bool,
}

impl FlowParticipationOperationDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PARTICIPATION_OPERATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        if self.grants_application_authority || self.deletes_durable_history {
            return Err(ContractError::new(
                "invalid-flow-participation-operation-authority",
                "Flow participation operations neither grant authority nor delete history",
            ));
        }
        if self != &canonical_operation(self.operation_id) {
            return Err(ContractError::new(
                "invalid-flow-participation-operation",
                "Flow participation operation metadata must match the closed catalogue",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowParticipationOperationCatalogue {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub operations: Vec<FlowParticipationOperationDescriptor>,
}

impl FlowParticipationOperationCatalogue {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(
            &self.protocol,
            FLOW_PARTICIPATION_OPERATION_CATALOGUE_PROTOCOL,
        )?;
        require_flow_application(self.application_id, &self.application_revision)?;
        let mut ids = BTreeSet::new();
        for operation in &self.operations {
            operation.validate()?;
            if !ids.insert(operation.operation_id) {
                return Err(ContractError::new(
                    "duplicate-flow-participation-operation",
                    "Flow participation operation identities must be unique",
                ));
            }
        }
        if self != &flow_participation_operation_catalogue() {
            return Err(ContractError::new(
                "invalid-flow-participation-operation-catalogue",
                "Flow participation catalogue must match the exact current inventory",
            ));
        }
        Ok(())
    }
}

pub fn flow_participation_operation_catalogue() -> FlowParticipationOperationCatalogue {
    FlowParticipationOperationCatalogue {
        protocol: FLOW_PARTICIPATION_OPERATION_CATALOGUE_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        operations: [
            FlowParticipationOperationId::MembersList,
            FlowParticipationOperationId::MemberAdd,
            FlowParticipationOperationId::MemberUpdate,
            FlowParticipationOperationId::MemberRemove,
            FlowParticipationOperationId::AgentsList,
            FlowParticipationOperationId::AgentAdd,
            FlowParticipationOperationId::AgentUpdate,
            FlowParticipationOperationId::AgentRevoke,
        ]
        .into_iter()
        .map(canonical_operation)
        .collect(),
    }
}

fn canonical_operation(
    operation_id: FlowParticipationOperationId,
) -> FlowParticipationOperationDescriptor {
    use FlowParticipationIdempotencyLaw::{ExactRequest, None};
    use FlowParticipationOperationIntent::{Manage, Read};
    use FlowParticipationOperationScope::{
        AgentCollection, AgentMandate, Member, MemberCollection,
    };
    use FlowParticipationResultKind::Member as MemberResult;
    use FlowParticipationResultKind::{AgentMandate as AgentResult, AgentPage, MemberPage};

    let (
        scope,
        intent,
        requires_entity_id,
        requires_expected_project_revision,
        idempotency,
        result_kind,
    ) = match operation_id {
        FlowParticipationOperationId::MembersList => {
            (MemberCollection, Read, false, false, None, MemberPage)
        }
        FlowParticipationOperationId::MemberAdd => (
            MemberCollection,
            Manage,
            false,
            true,
            ExactRequest,
            MemberResult,
        ),
        FlowParticipationOperationId::MemberUpdate | FlowParticipationOperationId::MemberRemove => {
            (Member, Manage, true, true, ExactRequest, MemberResult)
        }
        FlowParticipationOperationId::AgentsList => {
            (AgentCollection, Read, false, false, None, AgentPage)
        }
        FlowParticipationOperationId::AgentAdd => (
            AgentCollection,
            Manage,
            false,
            true,
            ExactRequest,
            AgentResult,
        ),
        FlowParticipationOperationId::AgentUpdate | FlowParticipationOperationId::AgentRevoke => {
            (AgentMandate, Manage, true, true, ExactRequest, AgentResult)
        }
    };

    FlowParticipationOperationDescriptor {
        protocol: FLOW_PARTICIPATION_OPERATION_PROTOCOL.to_owned(),
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
        deletes_durable_history: false,
    }
}

fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-participation-protocol-mismatch",
            "Flow participation record uses an unsupported protocol",
        ))
    }
}

fn require_flow_application(
    application_id: CurrentApplicationId,
    application_revision: &str,
) -> Result<(), ContractError> {
    if application_id != CurrentApplicationId::Flow {
        return Err(ContractError::new(
            "invalid-flow-participation-application",
            "Flow participation records must be owned by the current Flow application",
        ));
    }
    if application_revision != CURRENT_SUITE_REVISION {
        return Err(ContractError::new(
            "flow-participation-revision-mismatch",
            "Flow participation records require the exact current application revision",
        ));
    }
    Ok(())
}

fn require_project_membership(
    project_id: &str,
    member_project_id: &str,
    code: &'static str,
) -> Result<(), ContractError> {
    if project_id == member_project_id {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow participation record belongs to a different project",
        ))
    }
}

fn require_positive_revision(revision: u64, code: &'static str) -> Result<(), ContractError> {
    if revision > 0 {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow participation revision must be positive",
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
            "Flow participation scoped identity is invalid",
        ))
    }
}

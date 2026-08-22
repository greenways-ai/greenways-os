use crate::error::ContractError;
use crate::suite::{CurrentApplicationId, SharedReference, CURRENT_SUITE_REVISION};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const FLOW_PROJECT_PROTOCOL: &str = "greenways.flow.project/0-alpha";
pub const FLOW_WORK_REFERENCE_PROTOCOL: &str = "greenways.flow.work-reference/0-alpha";
pub const FLOW_BUILDOUT_REFERENCE_PROTOCOL: &str = "greenways.flow.buildout-reference/0-alpha";
pub const FLOW_OPERATION_PROTOCOL: &str = "greenways.flow.operation/0-alpha";
pub const FLOW_OPERATION_CATALOGUE_PROTOCOL: &str = "greenways.flow.operation-catalogue/0-alpha";

pub const FLOW_PROJECT_LIST_OPERATION: &str = "flow.project.list";
pub const FLOW_PROJECT_GET_OPERATION: &str = "flow.project.get";
pub const FLOW_PROJECT_CREATE_OPERATION: &str = "flow.project.create";
pub const FLOW_PROJECT_UPDATE_OPERATION: &str = "flow.project.update";
pub const FLOW_PROJECT_TRANSITION_OPERATION: &str = "flow.project.transition";
pub const FLOW_WORK_LIST_OPERATION: &str = "flow.work.list";
pub const FLOW_WORK_GET_OPERATION: &str = "flow.work.get";
pub const FLOW_WORK_CREATE_OPERATION: &str = "flow.work.create";
pub const FLOW_WORK_UPDATE_OPERATION: &str = "flow.work.update";
pub const FLOW_WORK_TRANSITION_OPERATION: &str = "flow.work.transition";
pub const FLOW_BUILDOUT_LIST_OPERATION: &str = "flow.buildout.list";
pub const FLOW_BUILDOUT_GET_OPERATION: &str = "flow.buildout.get";
pub const FLOW_BUILDOUT_CREATE_OPERATION: &str = "flow.buildout.create";
pub const FLOW_BUILDOUT_UPDATE_OPERATION: &str = "flow.buildout.update";
pub const FLOW_BUILDOUT_TRANSITION_OPERATION: &str = "flow.buildout.transition";

const MAX_PROJECT_ID_BYTES: usize = 256;
const MAX_WORK_ID_BYTES: usize = 256;
const MAX_BUILDOUT_ID_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 160;
const MAX_SUMMARY_BYTES: usize = 400;
const MAX_PROJECT_REFERENCES: usize = 64;
const MAX_PROJECT_WORK: usize = 512;
const MAX_PROJECT_BUILDOUTS: usize = 128;
const MAX_BUILDOUT_WORK: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowProjectState {
    Draft,
    Active,
    Paused,
    Review,
    Completed,
    Cancelled,
}

impl FlowProjectState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft, Self::Active | Self::Cancelled)
                | (
                    Self::Active,
                    Self::Paused | Self::Review | Self::Completed | Self::Cancelled
                )
                | (Self::Paused, Self::Active | Self::Cancelled)
                | (
                    Self::Review,
                    Self::Active | Self::Paused | Self::Completed | Self::Cancelled
                )
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowWorkState {
    Planned,
    Ready,
    Running,
    Blocked,
    Review,
    Completed,
    Cancelled,
    Failed,
}

impl FlowWorkState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Planned, Self::Ready | Self::Cancelled)
                | (Self::Ready, Self::Running | Self::Blocked | Self::Cancelled)
                | (
                    Self::Running,
                    Self::Blocked | Self::Review | Self::Completed | Self::Cancelled | Self::Failed
                )
                | (
                    Self::Blocked,
                    Self::Ready | Self::Running | Self::Cancelled | Self::Failed
                )
                | (
                    Self::Review,
                    Self::Running | Self::Blocked | Self::Completed | Self::Cancelled
                )
        )
    }

    const fn allows_project_completion(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowBuildoutState {
    Planned,
    Active,
    Blocked,
    Review,
    Completed,
    Cancelled,
    Failed,
}

impl FlowBuildoutState {
    pub const fn allows_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Planned, Self::Active | Self::Cancelled)
                | (
                    Self::Active,
                    Self::Blocked | Self::Review | Self::Completed | Self::Cancelled | Self::Failed
                )
                | (
                    Self::Blocked,
                    Self::Active | Self::Review | Self::Cancelled | Self::Failed
                )
                | (
                    Self::Review,
                    Self::Active | Self::Blocked | Self::Completed | Self::Cancelled
                )
        )
    }

    const fn allows_project_completion(self) -> bool {
        matches!(self, Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowWorkReference {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub work_id: String,
    pub revision: u64,
    pub title: String,
    pub summary: Option<String>,
    pub state: FlowWorkState,
    pub buildout_id: Option<String>,
    pub exact_root: Option<String>,
}

impl FlowWorkReference {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_WORK_REFERENCE_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.work_id,
            "work/",
            MAX_WORK_ID_BYTES,
            "invalid-flow-work-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-work-revision")?;
        validate_text(&self.title, MAX_TITLE_BYTES, "invalid-flow-work-title")?;
        if let Some(summary) = &self.summary {
            validate_text(summary, MAX_SUMMARY_BYTES, "invalid-flow-work-summary")?;
        }
        if let Some(buildout_id) = &self.buildout_id {
            validate_scoped_identifier(
                buildout_id,
                "buildout/",
                MAX_BUILDOUT_ID_BYTES,
                "invalid-flow-buildout-id",
            )?;
        }
        if let Some(root) = &self.exact_root {
            validate_digest(root)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowBuildoutReference {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub buildout_id: String,
    pub revision: u64,
    pub title: String,
    pub summary: Option<String>,
    pub state: FlowBuildoutState,
    pub work_ids: Vec<String>,
    pub exact_root: Option<String>,
}

impl FlowBuildoutReference {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_BUILDOUT_REFERENCE_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        validate_scoped_identifier(
            &self.buildout_id,
            "buildout/",
            MAX_BUILDOUT_ID_BYTES,
            "invalid-flow-buildout-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-buildout-revision")?;
        validate_text(&self.title, MAX_TITLE_BYTES, "invalid-flow-buildout-title")?;
        if let Some(summary) = &self.summary {
            validate_text(summary, MAX_SUMMARY_BYTES, "invalid-flow-buildout-summary")?;
        }
        if self.work_ids.is_empty() || self.work_ids.len() > MAX_BUILDOUT_WORK {
            return Err(ContractError::new(
                "invalid-flow-buildout-work",
                "Flow buildout must contain a bounded non-empty work list",
            ));
        }
        let mut work_ids = BTreeSet::new();
        for work_id in &self.work_ids {
            validate_scoped_identifier(
                work_id,
                "work/",
                MAX_WORK_ID_BYTES,
                "invalid-flow-work-id",
            )?;
            if !work_ids.insert(work_id) {
                return Err(ContractError::new(
                    "duplicate-flow-buildout-work",
                    "Flow buildout work identities must be unique",
                ));
            }
        }
        if let Some(root) = &self.exact_root {
            validate_digest(root)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProjectSnapshot {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub project_id: String,
    pub revision: u64,
    pub title: String,
    pub summary: Option<String>,
    pub state: FlowProjectState,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub source_references: Vec<SharedReference>,
    pub evidence_references: Vec<SharedReference>,
    pub work: Vec<FlowWorkReference>,
    pub buildouts: Vec<FlowBuildoutReference>,
}

impl FlowProjectSnapshot {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_PROJECT_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        validate_scoped_identifier(
            &self.project_id,
            "project/",
            MAX_PROJECT_ID_BYTES,
            "invalid-flow-project-id",
        )?;
        require_positive_revision(self.revision, "invalid-flow-project-revision")?;
        validate_text(&self.title, MAX_TITLE_BYTES, "invalid-flow-project-title")?;
        if let Some(summary) = &self.summary {
            validate_text(summary, MAX_SUMMARY_BYTES, "invalid-flow-project-summary")?;
        }
        if self.created_at_unix_ms == 0
            || self.updated_at_unix_ms == 0
            || self.updated_at_unix_ms < self.created_at_unix_ms
        {
            return Err(ContractError::new(
                "invalid-flow-project-time",
                "Flow project timestamps must be positive and monotonic",
            ));
        }
        if self.source_references.len() > MAX_PROJECT_REFERENCES
            || self.evidence_references.len() > MAX_PROJECT_REFERENCES
        {
            return Err(ContractError::new(
                "too-many-flow-project-references",
                "Flow project reference collections exceed their bounds",
            ));
        }
        if self.work.len() > MAX_PROJECT_WORK {
            return Err(ContractError::new(
                "too-much-flow-project-work",
                "Flow project work collection exceeds its bound",
            ));
        }
        if self.buildouts.len() > MAX_PROJECT_BUILDOUTS {
            return Err(ContractError::new(
                "too-many-flow-project-buildouts",
                "Flow project buildout collection exceeds its bound",
            ));
        }

        validate_shared_references(
            self.source_references
                .iter()
                .chain(self.evidence_references.iter()),
        )?;

        let mut work_by_id = BTreeMap::new();
        for work in &self.work {
            work.validate()?;
            require_project_membership(
                &self.project_id,
                &work.project_id,
                "cross-project-flow-work",
            )?;
            if work.application_revision != self.application_revision {
                return Err(ContractError::new(
                    "flow-work-revision-mismatch",
                    "Flow work application revision must match its project",
                ));
            }
            if work_by_id.insert(work.work_id.as_str(), work).is_some() {
                return Err(ContractError::new(
                    "duplicate-flow-work-id",
                    "Flow work identities must be unique within a project",
                ));
            }
        }

        let mut buildout_by_id = BTreeMap::new();
        for buildout in &self.buildouts {
            buildout.validate()?;
            require_project_membership(
                &self.project_id,
                &buildout.project_id,
                "cross-project-flow-buildout",
            )?;
            if buildout.application_revision != self.application_revision {
                return Err(ContractError::new(
                    "flow-buildout-revision-mismatch",
                    "Flow buildout application revision must match its project",
                ));
            }
            if buildout_by_id
                .insert(buildout.buildout_id.as_str(), buildout)
                .is_some()
            {
                return Err(ContractError::new(
                    "duplicate-flow-buildout-id",
                    "Flow buildout identities must be unique within a project",
                ));
            }
        }

        let mut assigned_work = BTreeSet::new();
        for buildout in &self.buildouts {
            for work_id in &buildout.work_ids {
                let work = work_by_id.get(work_id.as_str()).ok_or_else(|| {
                    ContractError::new(
                        "unknown-flow-buildout-work",
                        "Flow buildout references work outside the project snapshot",
                    )
                })?;
                if work.buildout_id.as_deref() != Some(buildout.buildout_id.as_str()) {
                    return Err(ContractError::new(
                        "flow-buildout-membership-mismatch",
                        "Flow work and buildout membership must agree exactly",
                    ));
                }
                if !assigned_work.insert(work_id.as_str()) {
                    return Err(ContractError::new(
                        "duplicate-flow-buildout-membership",
                        "Flow work cannot belong to more than one buildout",
                    ));
                }
                if matches!(
                    buildout.state,
                    FlowBuildoutState::Completed | FlowBuildoutState::Cancelled
                ) && !work.state.allows_project_completion()
                {
                    return Err(ContractError::new(
                        "non-terminal-flow-buildout-work",
                        "Completed or cancelled Flow buildouts require terminal work",
                    ));
                }
            }
        }

        for work in &self.work {
            match work.buildout_id.as_deref() {
                Some(buildout_id) => {
                    if !buildout_by_id.contains_key(buildout_id)
                        || !assigned_work.contains(work.work_id.as_str())
                    {
                        return Err(ContractError::new(
                            "orphaned-flow-buildout-work",
                            "Flow work buildout membership must resolve inside its project",
                        ));
                    }
                }
                None => {
                    if assigned_work.contains(work.work_id.as_str()) {
                        return Err(ContractError::new(
                            "unexpected-flow-buildout-work",
                            "Direct Flow work cannot appear in a buildout",
                        ));
                    }
                }
            }
        }

        if self.state == FlowProjectState::Completed
            && (self.work.is_empty()
                || self
                    .work
                    .iter()
                    .any(|work| !work.state.allows_project_completion())
                || self
                    .buildouts
                    .iter()
                    .any(|buildout| !buildout.state.allows_project_completion()))
        {
            return Err(ContractError::new(
                "incomplete-flow-project",
                "Completed Flow projects require terminal work and buildouts",
            ));
        }

        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlowOperationId {
    #[serde(rename = "flow.project.list")]
    ProjectList,
    #[serde(rename = "flow.project.get")]
    ProjectGet,
    #[serde(rename = "flow.project.create")]
    ProjectCreate,
    #[serde(rename = "flow.project.update")]
    ProjectUpdate,
    #[serde(rename = "flow.project.transition")]
    ProjectTransition,
    #[serde(rename = "flow.work.list")]
    WorkList,
    #[serde(rename = "flow.work.get")]
    WorkGet,
    #[serde(rename = "flow.work.create")]
    WorkCreate,
    #[serde(rename = "flow.work.update")]
    WorkUpdate,
    #[serde(rename = "flow.work.transition")]
    WorkTransition,
    #[serde(rename = "flow.buildout.list")]
    BuildoutList,
    #[serde(rename = "flow.buildout.get")]
    BuildoutGet,
    #[serde(rename = "flow.buildout.create")]
    BuildoutCreate,
    #[serde(rename = "flow.buildout.update")]
    BuildoutUpdate,
    #[serde(rename = "flow.buildout.transition")]
    BuildoutTransition,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowOperationScope {
    ProjectCollection,
    Project,
    Work,
    Buildout,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowOperationIntent {
    Read,
    Manage,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowIdempotencyLaw {
    None,
    ExactRequest,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowOperationResultKind {
    ProjectPage,
    Project,
    WorkPage,
    Work,
    BuildoutPage,
    Buildout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowOperationDescriptor {
    pub protocol: String,
    pub operation_id: FlowOperationId,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub scope: FlowOperationScope,
    pub intent: FlowOperationIntent,
    pub requires_project_id: bool,
    pub requires_entity_id: bool,
    pub requires_expected_revision: bool,
    pub idempotency: FlowIdempotencyLaw,
    pub result_kind: FlowOperationResultKind,
    pub grants_application_authority: bool,
}

impl FlowOperationDescriptor {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_OPERATION_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        if self.grants_application_authority {
            return Err(ContractError::new(
                "flow-operation-authority-transfer",
                "Flow operations never grant application authority",
            ));
        }
        if self != &canonical_operation(self.operation_id) {
            return Err(ContractError::new(
                "invalid-flow-operation",
                "Flow operation metadata does not match the closed catalogue",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowOperationCatalogue {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub operations: Vec<FlowOperationDescriptor>,
}

impl FlowOperationCatalogue {
    pub fn validate(&self) -> Result<(), ContractError> {
        require_protocol(&self.protocol, FLOW_OPERATION_CATALOGUE_PROTOCOL)?;
        require_flow_application(self.application_id, &self.application_revision)?;
        let mut operation_ids = BTreeSet::new();
        for operation in &self.operations {
            operation.validate()?;
            if !operation_ids.insert(operation.operation_id) {
                return Err(ContractError::new(
                    "duplicate-flow-operation",
                    "Flow operation identities must be unique",
                ));
            }
        }
        if self != &flow_operation_catalogue() {
            return Err(ContractError::new(
                "invalid-flow-operation-catalogue",
                "Flow operation catalogue must match the exact current inventory",
            ));
        }
        Ok(())
    }
}

pub fn flow_operation_catalogue() -> FlowOperationCatalogue {
    FlowOperationCatalogue {
        protocol: FLOW_OPERATION_CATALOGUE_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        operations: [
            FlowOperationId::ProjectList,
            FlowOperationId::ProjectGet,
            FlowOperationId::ProjectCreate,
            FlowOperationId::ProjectUpdate,
            FlowOperationId::ProjectTransition,
            FlowOperationId::WorkList,
            FlowOperationId::WorkGet,
            FlowOperationId::WorkCreate,
            FlowOperationId::WorkUpdate,
            FlowOperationId::WorkTransition,
            FlowOperationId::BuildoutList,
            FlowOperationId::BuildoutGet,
            FlowOperationId::BuildoutCreate,
            FlowOperationId::BuildoutUpdate,
            FlowOperationId::BuildoutTransition,
        ]
        .into_iter()
        .map(canonical_operation)
        .collect(),
    }
}

fn canonical_operation(operation_id: FlowOperationId) -> FlowOperationDescriptor {
    use FlowIdempotencyLaw::{ExactRequest, None};
    use FlowOperationIntent::{Manage, Read};
    use FlowOperationResultKind::{Buildout, BuildoutPage, Project, ProjectPage, Work, WorkPage};
    use FlowOperationScope::{Buildout as BuildoutScope, Project as ProjectScope};
    use FlowOperationScope::{ProjectCollection, Work as WorkScope};

    let (
        scope,
        intent,
        requires_project_id,
        requires_entity_id,
        requires_expected_revision,
        idempotency,
        result_kind,
    ) = match operation_id {
        FlowOperationId::ProjectList => (
            ProjectCollection,
            Read,
            false,
            false,
            false,
            None,
            ProjectPage,
        ),
        FlowOperationId::ProjectGet => (ProjectScope, Read, true, false, false, None, Project),
        FlowOperationId::ProjectCreate => (
            ProjectCollection,
            Manage,
            false,
            false,
            false,
            ExactRequest,
            Project,
        ),
        FlowOperationId::ProjectUpdate | FlowOperationId::ProjectTransition => (
            ProjectScope,
            Manage,
            true,
            false,
            true,
            ExactRequest,
            Project,
        ),
        FlowOperationId::WorkList => (WorkScope, Read, true, false, false, None, WorkPage),
        FlowOperationId::WorkGet => (WorkScope, Read, true, true, false, None, Work),
        FlowOperationId::WorkCreate => (WorkScope, Manage, true, false, true, ExactRequest, Work),
        FlowOperationId::WorkUpdate | FlowOperationId::WorkTransition => {
            (WorkScope, Manage, true, true, true, ExactRequest, Work)
        }
        FlowOperationId::BuildoutList => {
            (BuildoutScope, Read, true, false, false, None, BuildoutPage)
        }
        FlowOperationId::BuildoutGet => (BuildoutScope, Read, true, true, false, None, Buildout),
        FlowOperationId::BuildoutCreate => (
            BuildoutScope,
            Manage,
            true,
            false,
            true,
            ExactRequest,
            Buildout,
        ),
        FlowOperationId::BuildoutUpdate | FlowOperationId::BuildoutTransition => (
            BuildoutScope,
            Manage,
            true,
            true,
            true,
            ExactRequest,
            Buildout,
        ),
    };

    FlowOperationDescriptor {
        protocol: FLOW_OPERATION_PROTOCOL.to_owned(),
        operation_id,
        application_id: CurrentApplicationId::Flow,
        application_revision: CURRENT_SUITE_REVISION.to_owned(),
        scope,
        intent,
        requires_project_id,
        requires_entity_id,
        requires_expected_revision,
        idempotency,
        result_kind,
        grants_application_authority: false,
    }
}

fn require_protocol(actual: &str, expected: &str) -> Result<(), ContractError> {
    if actual == expected {
        Ok(())
    } else {
        Err(ContractError::new(
            "flow-protocol-mismatch",
            "Flow contract uses an unsupported protocol",
        ))
    }
}

fn require_flow_application(
    application_id: CurrentApplicationId,
    application_revision: &str,
) -> Result<(), ContractError> {
    if application_id != CurrentApplicationId::Flow {
        return Err(ContractError::new(
            "invalid-flow-application",
            "Flow records must be owned by the current Flow application",
        ));
    }
    if application_revision != CURRENT_SUITE_REVISION {
        return Err(ContractError::new(
            "flow-application-revision-mismatch",
            "Flow records require the exact current application revision",
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
            "Flow project member is owned by a different project",
        ))
    }
}

fn require_positive_revision(revision: u64, code: &'static str) -> Result<(), ContractError> {
    if revision > 0 {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow record revision must be positive",
        ))
    }
}

fn validate_shared_references<'a>(
    references: impl Iterator<Item = &'a SharedReference>,
) -> Result<(), ContractError> {
    let mut identities = BTreeSet::new();
    for reference in references {
        reference.validate()?;
        if reference.application_revision != CURRENT_SUITE_REVISION {
            return Err(ContractError::new(
                "flow-reference-revision-mismatch",
                "Flow project references require the exact current application revision",
            ));
        }
        let identity = (
            reference.application_id,
            reference.record_kind.as_str(),
            reference.logical_id.as_str(),
        );
        if !identities.insert(identity) {
            return Err(ContractError::new(
                "duplicate-flow-project-reference",
                "Flow project references must be unique across source and evidence",
            ));
        }
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
        Err(ContractError::new(code, "Flow scoped identity is invalid"))
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
            "invalid-flow-exact-root",
            "Flow exact root must be a lowercase SHA-256 digest",
        ))
    }
}

fn validate_text(value: &str, maximum: usize, code: &'static str) -> Result<(), ContractError> {
    if !value.is_empty() && value.len() <= maximum {
        Ok(())
    } else {
        Err(ContractError::new(
            code,
            "Flow contract text is outside its byte bound",
        ))
    }
}

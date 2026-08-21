use crate::error::ContractError;
use crate::suite::{
    CompatibilityDisposition, CurrentApplicationId, VersionLaw, CURRENT_SUITE_REVISION,
    FLOW_APPLICATION_ID, FLOW_PACKAGE_ID,
};
use serde::{Deserialize, Serialize};

pub const FLOW_FOREMAN_COMPATIBILITY_PROTOCOL: &str =
    "greenways.flow.foreman-compatibility/0-alpha";
pub const FOREMAN_SERVICE_PROTOCOL: &str = "greenways.foreman.service/0-alpha";
pub const FOREMAN_SERVICE_ID: &str = "foreman";
pub const FOREMAN_DISPLAY_LABEL: &str = "Foreman";
pub const FOREMAN_PROTOCOL_NAMESPACE: &str = "foreman.";
pub const FLOW_DISPLAY_NAME: &str = "Greenways Flow";
pub const FLOW_LAUNCHER_LABEL: &str = "Flow";
pub const FLOW_ROUTE_PREFIX: &str = "/flow/";
pub const FLOW_CLI_COMMAND: &str = "greenways flow";
pub const FLOW_OPERATION_NAMESPACE: &str = "flow.";
pub const FLOW_PERMISSION_NAMESPACE: &str = "flow.";
pub const FLOW_VISUAL_LANGUAGE_ROUTE: &str = "/v2/applications/flow/";
pub const BUILD_PACKAGE_ID: &str = "greenways/build";
pub const BUILD_ROUTE_PREFIX: &str = "/build/";
pub const BUILD_CLI_COMMAND: &str = "greenways build";
pub const BUILD_OPERATION_NAMESPACE: &str = "build.";
pub const PROJECT_REFERENCE_PREFIX: &str = "project/";
pub const WORK_REFERENCE_PREFIX: &str = "work/";
pub const BUILDOUT_REFERENCE_PREFIX: &str = "buildout/";

const FLOW_OPERATION_FAMILIES: [&str; 10] = [
    "flow.project.",
    "flow.membership.",
    "flow.agent-mandate.",
    "flow.host.",
    "flow.session.",
    "flow.work.",
    "flow.handoff.",
    "flow.intervention.",
    "flow.activity.",
    "flow.buildout.",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowProductIdentity {
    pub application_id: CurrentApplicationId,
    pub package_id: String,
    pub display_name: String,
    pub launcher_label: String,
    pub route_prefix: String,
    pub cli_command: String,
    pub operation_namespace: String,
    pub permission_namespace: String,
    pub visual_language_route: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForemanServiceIdentity {
    pub protocol: String,
    pub revision: String,
    pub service_id: String,
    pub display_name: String,
    pub protocol_namespace: String,
    pub product_facing: bool,
    pub discoverable: bool,
    pub grants_application_authority: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowAggregateLaw {
    pub aggregate_root_kind: String,
    pub project_reference_prefix: String,
    pub work_reference_prefix: String,
    pub buildout_reference_prefix: String,
    pub buildout_required: bool,
    pub cross_project_implicit_move: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowCompatibilityIdentityKind {
    LegacyApplication,
    DisplayLabel,
    ServiceIdentity,
    TechnicalNamespace,
    DurableRecordFamily,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowCompatibilityRule {
    pub identity: String,
    pub kind: FlowCompatibilityIdentityKind,
    pub disposition: CompatibilityDisposition,
    pub accepted: bool,
    pub discoverable: bool,
    pub product_facing: bool,
    pub rewrite_durable_identity: bool,
    pub creates_parallel_record: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowSurfaceKind {
    Launcher,
    Route,
    Cli,
    VisualLanguage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowSurfaceIdentity {
    pub kind: FlowSurfaceKind,
    pub identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlowForemanCompatibilityManifest {
    pub protocol: String,
    pub revision: String,
    pub version_law: VersionLaw,
    pub product: FlowProductIdentity,
    pub service: ForemanServiceIdentity,
    pub aggregate: FlowAggregateLaw,
    pub operation_families: Vec<String>,
    pub compatibility: Vec<FlowCompatibilityRule>,
    pub surfaces: Vec<FlowSurfaceIdentity>,
}

impl FlowForemanCompatibilityManifest {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self != &flow_foreman_compatibility_manifest() {
            return Err(ContractError::new(
                "invalid-flow-foreman-contract",
                "Flow product, Foreman service, compatibility, and aggregate laws must match the exact current contract",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FlowIdentityClass {
    CurrentProduct,
    SafeDisplayAlias,
    RetainedTechnicalIdentity,
    Incompatible,
    Unknown,
}

pub fn classify_flow_identity(identity: &str) -> FlowIdentityClass {
    match identity {
        FLOW_APPLICATION_ID
        | FLOW_PACKAGE_ID
        | FLOW_ROUTE_PREFIX
        | FLOW_CLI_COMMAND
        | FLOW_VISUAL_LANGUAGE_ROUTE => FlowIdentityClass::CurrentProduct,
        FOREMAN_DISPLAY_LABEL => FlowIdentityClass::SafeDisplayAlias,
        FOREMAN_SERVICE_ID => FlowIdentityClass::RetainedTechnicalIdentity,
        "build" | BUILD_PACKAGE_ID | BUILD_ROUTE_PREFIX | BUILD_CLI_COMMAND => {
            FlowIdentityClass::Incompatible
        }
        _ if identity.starts_with(FLOW_OPERATION_NAMESPACE) => FlowIdentityClass::CurrentProduct,
        _ if identity.starts_with(FOREMAN_PROTOCOL_NAMESPACE)
            || identity.starts_with(PROJECT_REFERENCE_PREFIX)
            || identity.starts_with(WORK_REFERENCE_PREFIX)
            || identity.starts_with(BUILDOUT_REFERENCE_PREFIX) =>
        {
            FlowIdentityClass::RetainedTechnicalIdentity
        }
        _ if identity.starts_with(BUILD_OPERATION_NAMESPACE) => FlowIdentityClass::Incompatible,
        _ => FlowIdentityClass::Unknown,
    }
}

pub fn flow_foreman_compatibility_manifest() -> FlowForemanCompatibilityManifest {
    FlowForemanCompatibilityManifest {
        protocol: FLOW_FOREMAN_COMPATIBILITY_PROTOCOL.to_owned(),
        revision: CURRENT_SUITE_REVISION.to_owned(),
        version_law: VersionLaw::Exact,
        product: FlowProductIdentity {
            application_id: CurrentApplicationId::Flow,
            package_id: FLOW_PACKAGE_ID.to_owned(),
            display_name: FLOW_DISPLAY_NAME.to_owned(),
            launcher_label: FLOW_LAUNCHER_LABEL.to_owned(),
            route_prefix: FLOW_ROUTE_PREFIX.to_owned(),
            cli_command: FLOW_CLI_COMMAND.to_owned(),
            operation_namespace: FLOW_OPERATION_NAMESPACE.to_owned(),
            permission_namespace: FLOW_PERMISSION_NAMESPACE.to_owned(),
            visual_language_route: FLOW_VISUAL_LANGUAGE_ROUTE.to_owned(),
        },
        service: ForemanServiceIdentity {
            protocol: FOREMAN_SERVICE_PROTOCOL.to_owned(),
            revision: CURRENT_SUITE_REVISION.to_owned(),
            service_id: FOREMAN_SERVICE_ID.to_owned(),
            display_name: FOREMAN_DISPLAY_LABEL.to_owned(),
            protocol_namespace: FOREMAN_PROTOCOL_NAMESPACE.to_owned(),
            product_facing: false,
            discoverable: false,
            grants_application_authority: false,
        },
        aggregate: FlowAggregateLaw {
            aggregate_root_kind: "project".to_owned(),
            project_reference_prefix: PROJECT_REFERENCE_PREFIX.to_owned(),
            work_reference_prefix: WORK_REFERENCE_PREFIX.to_owned(),
            buildout_reference_prefix: BUILDOUT_REFERENCE_PREFIX.to_owned(),
            buildout_required: false,
            cross_project_implicit_move: false,
        },
        operation_families: FLOW_OPERATION_FAMILIES
            .into_iter()
            .map(str::to_owned)
            .collect(),
        compatibility: vec![
            compatibility_rule(
                "build",
                FlowCompatibilityIdentityKind::LegacyApplication,
                CompatibilityDisposition::Absent,
                false,
            ),
            compatibility_rule(
                FOREMAN_DISPLAY_LABEL,
                FlowCompatibilityIdentityKind::DisplayLabel,
                CompatibilityDisposition::SafeDisplayAlias,
                true,
            ),
            compatibility_rule(
                FOREMAN_SERVICE_ID,
                FlowCompatibilityIdentityKind::ServiceIdentity,
                CompatibilityDisposition::RetainedTechnicalIdentity,
                true,
            ),
            compatibility_rule(
                "foreman.*",
                FlowCompatibilityIdentityKind::TechnicalNamespace,
                CompatibilityDisposition::RetainedTechnicalIdentity,
                true,
            ),
            compatibility_rule(
                "project/*",
                FlowCompatibilityIdentityKind::DurableRecordFamily,
                CompatibilityDisposition::RetainedTechnicalIdentity,
                true,
            ),
            compatibility_rule(
                "work/*",
                FlowCompatibilityIdentityKind::DurableRecordFamily,
                CompatibilityDisposition::RetainedTechnicalIdentity,
                true,
            ),
            compatibility_rule(
                "buildout/*",
                FlowCompatibilityIdentityKind::DurableRecordFamily,
                CompatibilityDisposition::RetainedTechnicalIdentity,
                true,
            ),
        ],
        surfaces: vec![
            surface(FlowSurfaceKind::Launcher, FLOW_LAUNCHER_LABEL),
            surface(FlowSurfaceKind::Route, FLOW_ROUTE_PREFIX),
            surface(FlowSurfaceKind::Cli, FLOW_CLI_COMMAND),
            surface(
                FlowSurfaceKind::VisualLanguage,
                FLOW_VISUAL_LANGUAGE_ROUTE,
            ),
        ],
    }
}

fn compatibility_rule(
    identity: &str,
    kind: FlowCompatibilityIdentityKind,
    disposition: CompatibilityDisposition,
    accepted: bool,
) -> FlowCompatibilityRule {
    FlowCompatibilityRule {
        identity: identity.to_owned(),
        kind,
        disposition,
        accepted,
        discoverable: false,
        product_facing: false,
        rewrite_durable_identity: false,
        creates_parallel_record: false,
    }
}

fn surface(kind: FlowSurfaceKind, identity: &str) -> FlowSurfaceIdentity {
    FlowSurfaceIdentity {
        kind,
        identity: identity.to_owned(),
    }
}

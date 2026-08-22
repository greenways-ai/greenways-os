use crate::{
    current_suite_manifest, CompatibilityDisposition, ContractError, CurrentApplicationId,
    LegacyApplicationId, ReferenceAuthorityState, SharedReference, CURRENT_SUITE_REVISION,
    SPACES_PACKAGE_ID,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

pub const SPACES_DOMAIN_PROTOCOL: &str = "greenways.spaces.domain/0-alpha";
pub const SPACE_SNAPSHOT_PROTOCOL: &str = "greenways.spaces.space/0-alpha";
pub const SPACES_DOMAIN_REVISION: &str = CURRENT_SUITE_REVISION;
pub const SPACES_OWNER_KIND: &str = "space";

const MAX_ID_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 200;
const MAX_SUMMARY_BYTES: usize = 600;
const MAX_BODY_BYTES: usize = 16_384;
const MAX_SCOPE_BYTES: usize = 2_000;
const MAX_COLLECTION_ITEMS: usize = 1_024;
const MAX_MAP_NODES: usize = 2_048;
const MAX_MAP_RELATIONSHIPS: usize = 4_096;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SpacesRecordKind {
    Space,
    Reference,
    Map,
    MapNode,
    VisualRelationship,
    Topic,
    Note,
    Question,
    Hypothesis,
    Finding,
    Lens,
    Brief,
    Activity,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SpacesReferenceKind {
    HestiaSource,
    HestiaAnchor,
    HestiaCandidate,
    HestiaAssertion,
    TahtoConcept,
    TahtoSemanticRelationship,
    FlowObject,
    PublicWork,
}

impl SpacesReferenceKind {
    pub const fn record_kind(self) -> &'static str {
        match self {
            Self::HestiaSource => "hestia-source",
            Self::HestiaAnchor => "hestia-anchor",
            Self::HestiaCandidate => "hestia-candidate",
            Self::HestiaAssertion => "hestia-assertion",
            Self::TahtoConcept => "tahto-concept",
            Self::TahtoSemanticRelationship => "tahto-semantic-relationship",
            Self::FlowObject => "flow-object",
            Self::PublicWork => "public-work",
        }
    }

    const fn is_evidence(self) -> bool {
        matches!(
            self,
            Self::HestiaSource | Self::HestiaAnchor | Self::HestiaCandidate | Self::HestiaAssertion
        )
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SpacesExportReferenceKind {
    Space,
    Map,
    Question,
    Finding,
    Brief,
}

impl SpacesExportReferenceKind {
    pub const fn record_kind(self) -> SpacesRecordKind {
        match self {
            Self::Space => SpacesRecordKind::Space,
            Self::Map => SpacesRecordKind::Map,
            Self::Question => SpacesRecordKind::Question,
            Self::Finding => SpacesRecordKind::Finding,
            Self::Brief => SpacesRecordKind::Brief,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SpacesPromotionOutcome {
    KeepVisualAssociation,
    ReviewHestiaAssertion,
    ProposeTahtoSemanticRelationship,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SpacesFabricGroupId {
    Reader,
    Composer,
    Reviewer,
    FlowHandoff,
    Publisher,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum SpacesPermission {
    ReadSpace,
    EditPerspective,
    AttachSourceReference,
    ComposeBrief,
    ReviewEvidence,
    ProposeKnowledgeAssertion,
    ProposeSemanticRelationship,
    SendSelectedContextToFlow,
    ImportSelectedFlowResult,
    ReleaseSelectedWork,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpacesFabricGroup {
    pub id: SpacesFabricGroupId,
    pub permissions: Vec<SpacesPermission>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ResearchMigrationDisposition {
    Absent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpacesCompatibilityPolicy {
    pub legacy_application_id: LegacyApplicationId,
    pub disposition: CompatibilityDisposition,
    pub migration: ResearchMigrationDisposition,
    pub discoverable: bool,
    pub grants_authority: bool,
    pub creates_duplicate_space: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpacesDomainManifest {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub package_id: String,
    pub record_kinds: Vec<SpacesRecordKind>,
    pub import_reference_kinds: Vec<SpacesReferenceKind>,
    pub export_reference_kinds: Vec<SpacesExportReferenceKind>,
    pub promotion_outcomes: Vec<SpacesPromotionOutcome>,
    pub fabric_groups: Vec<SpacesFabricGroup>,
    pub compatibility: SpacesCompatibilityPolicy,
}

impl SpacesDomainManifest {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol != SPACES_DOMAIN_PROTOCOL {
            return Err(ContractError::new(
                "spaces-protocol-mismatch",
                "Spaces domain manifest uses an unsupported protocol",
            ));
        }
        let suite = current_suite_manifest();
        let application = suite
            .applications
            .iter()
            .find(|application| application.application_id == CurrentApplicationId::Spaces)
            .ok_or_else(|| {
                ContractError::new(
                    "spaces-application-unavailable",
                    "current suite does not contain the Spaces application",
                )
            })?;
        if self.application_id != CurrentApplicationId::Spaces
            || self.application_revision != application.revision
            || self.package_id != application.package.id
        {
            return Err(ContractError::new(
                "spaces-manifest-mismatch",
                "Spaces domain identity does not match the current suite contract",
            ));
        }
        if self.compatibility.legacy_application_id != LegacyApplicationId::Research
            || self.compatibility.disposition != CompatibilityDisposition::Absent
            || self.compatibility.migration != ResearchMigrationDisposition::Absent
            || self.compatibility.discoverable
            || self.compatibility.grants_authority
            || self.compatibility.creates_duplicate_space
        {
            return Err(ContractError::new(
                "spaces-compatibility-mismatch",
                "legacy compatibility must retain the merged absent disposition",
            ));
        }
        if self != &spaces_domain_manifest() {
            return Err(ContractError::new(
                "spaces-manifest-not-canonical",
                "Spaces domain inventories and permissions must match the closed manifest",
            ));
        }
        Ok(())
    }
}

pub fn spaces_domain_manifest() -> SpacesDomainManifest {
    SpacesDomainManifest {
        protocol: SPACES_DOMAIN_PROTOCOL.to_owned(),
        application_id: CurrentApplicationId::Spaces,
        application_revision: SPACES_DOMAIN_REVISION.to_owned(),
        package_id: SPACES_PACKAGE_ID.to_owned(),
        record_kinds: vec![
            SpacesRecordKind::Space,
            SpacesRecordKind::Reference,
            SpacesRecordKind::Map,
            SpacesRecordKind::MapNode,
            SpacesRecordKind::VisualRelationship,
            SpacesRecordKind::Topic,
            SpacesRecordKind::Note,
            SpacesRecordKind::Question,
            SpacesRecordKind::Hypothesis,
            SpacesRecordKind::Finding,
            SpacesRecordKind::Lens,
            SpacesRecordKind::Brief,
            SpacesRecordKind::Activity,
        ],
        import_reference_kinds: vec![
            SpacesReferenceKind::HestiaSource,
            SpacesReferenceKind::HestiaAnchor,
            SpacesReferenceKind::HestiaCandidate,
            SpacesReferenceKind::HestiaAssertion,
            SpacesReferenceKind::TahtoConcept,
            SpacesReferenceKind::TahtoSemanticRelationship,
            SpacesReferenceKind::FlowObject,
            SpacesReferenceKind::PublicWork,
        ],
        export_reference_kinds: vec![
            SpacesExportReferenceKind::Space,
            SpacesExportReferenceKind::Map,
            SpacesExportReferenceKind::Question,
            SpacesExportReferenceKind::Finding,
            SpacesExportReferenceKind::Brief,
        ],
        promotion_outcomes: vec![
            SpacesPromotionOutcome::KeepVisualAssociation,
            SpacesPromotionOutcome::ReviewHestiaAssertion,
            SpacesPromotionOutcome::ProposeTahtoSemanticRelationship,
        ],
        fabric_groups: vec![
            SpacesFabricGroup {
                id: SpacesFabricGroupId::Reader,
                permissions: vec![SpacesPermission::ReadSpace],
            },
            SpacesFabricGroup {
                id: SpacesFabricGroupId::Composer,
                permissions: vec![
                    SpacesPermission::ReadSpace,
                    SpacesPermission::EditPerspective,
                    SpacesPermission::AttachSourceReference,
                    SpacesPermission::ComposeBrief,
                ],
            },
            SpacesFabricGroup {
                id: SpacesFabricGroupId::Reviewer,
                permissions: vec![
                    SpacesPermission::ReadSpace,
                    SpacesPermission::ReviewEvidence,
                    SpacesPermission::ProposeKnowledgeAssertion,
                    SpacesPermission::ProposeSemanticRelationship,
                ],
            },
            SpacesFabricGroup {
                id: SpacesFabricGroupId::FlowHandoff,
                permissions: vec![
                    SpacesPermission::ReadSpace,
                    SpacesPermission::SendSelectedContextToFlow,
                    SpacesPermission::ImportSelectedFlowResult,
                ],
            },
            SpacesFabricGroup {
                id: SpacesFabricGroupId::Publisher,
                permissions: vec![
                    SpacesPermission::ReadSpace,
                    SpacesPermission::ReleaseSelectedWork,
                ],
            },
        ],
        compatibility: SpacesCompatibilityPolicy {
            legacy_application_id: LegacyApplicationId::Research,
            disposition: CompatibilityDisposition::Absent,
            migration: ResearchMigrationDisposition::Absent,
            discoverable: false,
            grants_authority: false,
            creates_duplicate_space: false,
        },
    }
}

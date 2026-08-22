#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MapNodeTargetKind {
    Reference,
    Topic,
    Note,
    Question,
    Hypothesis,
    Finding,
    Brief,
}

impl MapNodeTargetKind {
    const fn record_kind(self) -> SpacesRecordKind {
        match self {
            Self::Reference => SpacesRecordKind::Reference,
            Self::Topic => SpacesRecordKind::Topic,
            Self::Note => SpacesRecordKind::Note,
            Self::Question => SpacesRecordKind::Question,
            Self::Hypothesis => SpacesRecordKind::Hypothesis,
            Self::Finding => SpacesRecordKind::Finding,
            Self::Brief => SpacesRecordKind::Brief,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MapNodeTarget {
    pub kind: MapNodeTargetKind,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeLayout {
    pub x_milli: i32,
    pub y_milli: i32,
    pub width_milli: u16,
    pub height_milli: u16,
}

impl NodeLayout {
    fn validate(&self) -> Result<(), ContractError> {
        if self.width_milli == 0
            || self.height_milli == 0
            || self.width_milli > 20_000
            || self.height_milli > 20_000
        {
            return Err(ContractError::new(
                "invalid-node-layout",
                "map node dimensions must be positive and bounded",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceMapNode {
    pub id: String,
    pub revision: u64,
    pub target: MapNodeTarget,
    pub label: String,
    pub layout: NodeLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceMapGroup {
    pub id: String,
    pub title: String,
    pub node_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VisualRelationshipKind {
    Related,
    Supports,
    Conflicts,
    MissingEvidence,
    Explains,
    Sequence,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VisualRelationshipOrigin {
    Manual,
    LayoutProximity,
    MachineSuggestion,
    Imported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RelationshipPromotion {
    VisualAssociation,
    HestiaCandidate,
    HestiaAssertion,
    TahtoSemanticProposal,
    TahtoSemanticRelationship,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceVisualRelationship {
    pub id: String,
    pub revision: u64,
    pub from_node_id: String,
    pub to_node_id: String,
    pub relationship: VisualRelationshipKind,
    pub origin: VisualRelationshipOrigin,
    pub promotion: RelationshipPromotion,
    pub reference_ids: Vec<String>,
}

impl SpaceVisualRelationship {
    fn validate(
        &self,
        node_ids: &BTreeSet<&str>,
        references: &BTreeMap<&str, &SpacesReference>,
    ) -> Result<(), ContractError> {
        validate_id(&self.id, "invalid-visual-relationship-id")?;
        require_positive_revision(self.revision)?;
        if self.from_node_id == self.to_node_id
            || !node_ids.contains(self.from_node_id.as_str())
            || !node_ids.contains(self.to_node_id.as_str())
        {
            return Err(ContractError::new(
                "invalid-visual-relationship-endpoint",
                "visual relationships require two distinct nodes in the same map",
            ));
        }
        validate_id_list(&self.reference_ids, "invalid-visual-relationship-reference")?;
        let kinds = resolve_reference_kinds(&self.reference_ids, references)?;

        if self.origin == VisualRelationshipOrigin::LayoutProximity
            && (self.promotion != RelationshipPromotion::VisualAssociation || !kinds.is_empty())
        {
            return Err(ContractError::new(
                "proximity-cannot-promote",
                "map proximity is visual state and cannot become an assertion or semantic link",
            ));
        }

        match self.promotion {
            RelationshipPromotion::VisualAssociation => {
                if !kinds.is_empty() {
                    return Err(ContractError::new(
                        "visual-association-has-authority",
                        "Spaces-only visual associations cannot carry canonical references",
                    ));
                }
            }
            RelationshipPromotion::HestiaCandidate => {
                if kinds.is_empty()
                    || !kinds
                        .iter()
                        .all(|kind| *kind == SpacesReferenceKind::HestiaCandidate)
                {
                    return Err(ContractError::new(
                        "invalid-relationship-candidate",
                        "candidate relationships require only Hestia candidate observations",
                    ));
                }
            }
            RelationshipPromotion::HestiaAssertion => {
                require_assertion_without_candidate(&kinds)?;
                require_only_reference_kinds(
                    &kinds,
                    &[
                        SpacesReferenceKind::HestiaSource,
                        SpacesReferenceKind::HestiaAnchor,
                        SpacesReferenceKind::HestiaAssertion,
                    ],
                    "assertion-has-non-hestia-authority",
                )?;
            }
            RelationshipPromotion::TahtoSemanticProposal => {
                require_assertion_without_candidate(&kinds)?;
                require_only_reference_kinds(
                    &kinds,
                    &[
                        SpacesReferenceKind::HestiaSource,
                        SpacesReferenceKind::HestiaAnchor,
                        SpacesReferenceKind::HestiaAssertion,
                        SpacesReferenceKind::TahtoConcept,
                    ],
                    "semantic-proposal-has-canonical-link",
                )?;
            }
            RelationshipPromotion::TahtoSemanticRelationship => {
                if kinds.contains(&SpacesReferenceKind::HestiaCandidate)
                    || !kinds.contains(&SpacesReferenceKind::HestiaAssertion)
                {
                    return Err(ContractError::new(
                        "candidate-cannot-be-semantic-link",
                        "validated Tahto relationships require an accepted Hestia assertion first",
                    ));
                }
                if !kinds.contains(&SpacesReferenceKind::TahtoSemanticRelationship) {
                    return Err(ContractError::new(
                        "missing-tahto-semantic-link",
                        "semantic promotion requires an exact validated Tahto relationship",
                    ));
                }
                require_only_reference_kinds(
                    &kinds,
                    &[
                        SpacesReferenceKind::HestiaSource,
                        SpacesReferenceKind::HestiaAnchor,
                        SpacesReferenceKind::HestiaAssertion,
                        SpacesReferenceKind::TahtoConcept,
                        SpacesReferenceKind::TahtoSemanticRelationship,
                    ],
                    "semantic-link-has-foreign-authority",
                )?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceMap {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub view: SpaceView,
    pub lens_id: Option<String>,
    pub selected_record_ids: Vec<String>,
    pub groups: Vec<SpaceMapGroup>,
    pub nodes: Vec<SpaceMapNode>,
    pub relationships: Vec<SpaceVisualRelationship>,
}

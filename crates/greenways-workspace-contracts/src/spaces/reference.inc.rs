#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpacesReference {
    pub id: String,
    pub kind: SpacesReferenceKind,
    pub observation: SharedReference,
}

impl SpacesReference {
    fn validate(&self, space_id: &str) -> Result<(), ContractError> {
        validate_id(&self.id, "invalid-spaces-reference-id")?;
        self.observation.validate()?;
        if self.observation.application_id != CurrentApplicationId::Spaces
            || self.observation.owner_application_id != CurrentApplicationId::Spaces
            || self.observation.application_revision != SPACES_DOMAIN_REVISION
            || self.observation.owner_kind != SPACES_OWNER_KIND
            || self.observation.owner_id != space_id
        {
            return Err(ContractError::new(
                "invalid-spaces-reference-owner",
                "Spaces references must be observations owned by the containing Space",
            ));
        }
        if self.observation.record_kind != self.kind.record_kind() {
            return Err(ContractError::new(
                "invalid-spaces-reference-kind",
                "Spaces reference kind does not match its shared-reference record kind",
            ));
        }
        if self.observation.exact_root.is_none() {
            return Err(ContractError::new(
                "missing-spaces-reference-root",
                "display text cannot replace the exact root of an observed source or concept",
            ));
        }
        if matches!(
            self.observation.authority_state,
            ReferenceAuthorityState::Denied | ReferenceAuthorityState::Revoked
        ) {
            return Err(ContractError::new(
                "unusable-spaces-reference",
                "denied or revoked observations cannot enter a Space snapshot",
            ));
        }
        let expected_authority = if self.kind == SpacesReferenceKind::HestiaCandidate {
            ReferenceAuthorityState::ResolutionRequired
        } else {
            ReferenceAuthorityState::Observed
        };
        if self.observation.authority_state != expected_authority {
            return Err(ContractError::new(
                "invalid-spaces-reference-authority",
                "candidate observations require review while accepted external records must be observed",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum GroundingState {
    Unsourced,
    Unresolved,
    Sourced,
    Derived,
    Candidate,
    Asserted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpacesGrounding {
    pub state: GroundingState,
    pub reference_ids: Vec<String>,
}

impl SpacesGrounding {
    fn validate(&self, references: &BTreeMap<&str, &SpacesReference>) -> Result<(), ContractError> {
        validate_id_list(&self.reference_ids, "invalid-grounding-reference")?;
        let kinds = resolve_reference_kinds(&self.reference_ids, references)?;

        match self.state {
            GroundingState::Unsourced | GroundingState::Unresolved => {
                if !kinds.is_empty() {
                    return Err(ContractError::new(
                        "invalid-empty-grounding",
                        "unsourced and unresolved records cannot claim source observations",
                    ));
                }
            }
            GroundingState::Sourced => {
                if kinds.is_empty()
                    || !kinds.iter().all(|kind| {
                        matches!(
                            kind,
                            SpacesReferenceKind::HestiaSource | SpacesReferenceKind::HestiaAnchor
                        )
                    })
                {
                    return Err(ContractError::new(
                        "invalid-sourced-grounding",
                        "sourced records require only exact Hestia source or anchor observations",
                    ));
                }
            }
            GroundingState::Derived => {
                if kinds.is_empty()
                    || !kinds.iter().all(|kind| {
                        matches!(
                            kind,
                            SpacesReferenceKind::HestiaSource
                                | SpacesReferenceKind::HestiaAnchor
                                | SpacesReferenceKind::HestiaAssertion
                        )
                    })
                {
                    return Err(ContractError::new(
                        "invalid-derived-grounding",
                        "derived records require exact source, anchor, or assertion observations",
                    ));
                }
            }
            GroundingState::Candidate => {
                if kinds.is_empty()
                    || !kinds
                        .iter()
                        .all(|kind| *kind == SpacesReferenceKind::HestiaCandidate)
                {
                    return Err(ContractError::new(
                        "invalid-candidate-grounding",
                        "candidate records require only Hestia candidate observations",
                    ));
                }
            }
            GroundingState::Asserted => {
                if !kinds.contains(&SpacesReferenceKind::HestiaAssertion)
                    || kinds
                        .iter()
                        .any(|kind| *kind == SpacesReferenceKind::HestiaCandidate)
                    || !kinds.iter().all(|kind| {
                        matches!(
                            kind,
                            SpacesReferenceKind::HestiaSource
                                | SpacesReferenceKind::HestiaAnchor
                                | SpacesReferenceKind::HestiaAssertion
                        )
                    })
                {
                    return Err(ContractError::new(
                        "invalid-asserted-grounding",
                        "asserted records require a reviewed Hestia assertion and no candidate",
                    ));
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SpacePrivacy {
    Private,
    Shared,
    Public,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SpaceState {
    Active,
    Archived,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SpaceView {
    Canvas,
    Outline,
    Timeline,
    Table,
    Evidence,
    ArgumentMap,
    Document,
    Brief,
}

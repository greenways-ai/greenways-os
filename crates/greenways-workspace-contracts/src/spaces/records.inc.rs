#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TopicResolution {
    Unresolved,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceTopic {
    pub id: String,
    pub revision: u64,
    pub label: String,
    pub resolution: TopicResolution,
    pub concept_reference_id: Option<String>,
}

impl SpaceTopic {
    fn validate(&self, references: &BTreeMap<&str, &SpacesReference>) -> Result<(), ContractError> {
        validate_record_header(self.revision, &self.id, &self.label)?;
        match (self.resolution, self.concept_reference_id.as_deref()) {
            (TopicResolution::Unresolved, None) => Ok(()),
            (TopicResolution::Resolved, Some(reference_id)) => require_reference_kind(
                reference_id,
                SpacesReferenceKind::TahtoConcept,
                references,
                "resolved-topic-needs-concept",
            ),
            _ => Err(ContractError::new(
                "invalid-topic-resolution",
                "resolved topics require one Tahto concept and unresolved topics require none",
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceNote {
    pub id: String,
    pub revision: u64,
    pub body: String,
    pub grounding: SpacesGrounding,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QuestionState {
    Open,
    Investigating,
    ReadyForFlow,
    SentToFlow,
    Answered,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceQuestion {
    pub id: String,
    pub revision: u64,
    pub text: String,
    pub state: QuestionState,
    pub grounding: SpacesGrounding,
    pub flow_reference_id: Option<String>,
}

impl SpaceQuestion {
    fn validate(&self, references: &BTreeMap<&str, &SpacesReference>) -> Result<(), ContractError> {
        validate_record_header(self.revision, &self.id, &self.text)?;
        self.grounding.validate(references)?;
        match (self.state, self.flow_reference_id.as_deref()) {
            (QuestionState::SentToFlow | QuestionState::Answered, Some(reference_id)) => {
                require_reference_kind(
                    reference_id,
                    SpacesReferenceKind::FlowObject,
                    references,
                    "flow-question-needs-flow-reference",
                )
            }
            (QuestionState::SentToFlow | QuestionState::Answered, None) => Err(ContractError::new(
                "flow-question-needs-flow-reference",
                "sent or answered questions require an exact Flow object observation",
            )),
            (_, None) => Ok(()),
            (_, Some(_)) => Err(ContractError::new(
                "premature-flow-reference",
                "a Flow object cannot be attached before a question is sent",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HypothesisState {
    Proposed,
    UnderReview,
    Supported,
    Conflicted,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceHypothesis {
    pub id: String,
    pub revision: u64,
    pub statement: String,
    pub state: HypothesisState,
    pub supporting_reference_ids: Vec<String>,
    pub conflicting_reference_ids: Vec<String>,
    pub missing_evidence: Vec<String>,
}

impl SpaceHypothesis {
    fn validate(&self, references: &BTreeMap<&str, &SpacesReference>) -> Result<(), ContractError> {
        validate_record_header(self.revision, &self.id, &self.statement)?;
        validate_id_list(
            &self.supporting_reference_ids,
            "invalid-supporting-evidence-reference",
        )?;
        validate_id_list(
            &self.conflicting_reference_ids,
            "invalid-conflicting-evidence-reference",
        )?;
        let support = resolve_reference_kinds(&self.supporting_reference_ids, references)?;
        let conflict = resolve_reference_kinds(&self.conflicting_reference_ids, references)?;
        if support
            .iter()
            .chain(&conflict)
            .any(|kind| !kind.is_evidence())
        {
            return Err(ContractError::new(
                "invalid-hypothesis-evidence",
                "hypothesis evidence must be a Hestia source, anchor, candidate, or assertion",
            ));
        }
        if self
            .supporting_reference_ids
            .iter()
            .any(|id| self.conflicting_reference_ids.contains(id))
        {
            return Err(ContractError::new(
                "ambiguous-hypothesis-evidence",
                "one observation cannot be both supporting and conflicting",
            ));
        }
        if self.missing_evidence.len() > MAX_COLLECTION_ITEMS {
            return Err(ContractError::new(
                "too-many-missing-evidence-items",
                "hypothesis missing-evidence list exceeds its bound",
            ));
        }
        for item in &self.missing_evidence {
            validate_text(item, MAX_SUMMARY_BYTES, "invalid-missing-evidence")?;
        }
        if self.state == HypothesisState::Supported && support.is_empty() {
            return Err(ContractError::new(
                "supported-hypothesis-without-evidence",
                "supported hypotheses require supporting evidence",
            ));
        }
        if self.state == HypothesisState::Conflicted && conflict.is_empty() {
            return Err(ContractError::new(
                "conflicted-hypothesis-without-evidence",
                "conflicted hypotheses require conflicting evidence",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FindingState {
    Candidate,
    Reviewed,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceFinding {
    pub id: String,
    pub revision: u64,
    pub statement: String,
    pub state: FindingState,
    pub grounding: SpacesGrounding,
}

impl SpaceFinding {
    fn validate(&self, references: &BTreeMap<&str, &SpacesReference>) -> Result<(), ContractError> {
        validate_record_header(self.revision, &self.id, &self.statement)?;
        self.grounding.validate(references)?;
        match self.state {
            FindingState::Candidate => {
                if !matches!(
                    self.grounding.state,
                    GroundingState::Candidate | GroundingState::Derived
                ) {
                    return Err(ContractError::new(
                        "invalid-candidate-finding",
                        "candidate findings must remain candidate or explicitly derived",
                    ));
                }
            }
            FindingState::Reviewed => {
                if !matches!(
                    self.grounding.state,
                    GroundingState::Sourced | GroundingState::Derived | GroundingState::Asserted
                ) {
                    return Err(ContractError::new(
                        "reviewed-finding-without-evidence",
                        "reviewed findings require exact sourced, derived, or asserted grounding",
                    ));
                }
            }
            FindingState::Rejected => {}
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum LensSort {
    Manual,
    Title,
    Updated,
    GroundingState,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceLens {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub include_record_kinds: Vec<SpacesRecordKind>,
    pub grounding_states: Vec<GroundingState>,
    pub sort: LensSort,
    pub descending: bool,
}

impl SpaceLens {
    fn validate(&self) -> Result<(), ContractError> {
        validate_record_header(self.revision, &self.id, &self.title)?;
        if self.include_record_kinds.is_empty()
            || self.include_record_kinds.len() > SpacesRecordKind::COUNT
            || !all_unique(&self.include_record_kinds)
            || !all_unique(&self.grounding_states)
        {
            return Err(ContractError::new(
                "invalid-lens-selection",
                "lens selections must be non-empty, bounded, and duplicate-free",
            ));
        }
        Ok(())
    }
}

impl SpacesRecordKind {
    const COUNT: usize = 13;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum BriefState {
    Draft,
    Reviewed,
    Released,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceBriefSection {
    pub id: String,
    pub heading: String,
    pub body: String,
    pub grounding: SpacesGrounding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceBrief {
    pub id: String,
    pub revision: u64,
    pub title: String,
    pub state: BriefState,
    pub sections: Vec<SpaceBriefSection>,
}

impl SpaceBrief {
    fn validate(&self, references: &BTreeMap<&str, &SpacesReference>) -> Result<(), ContractError> {
        validate_record_header(self.revision, &self.id, &self.title)?;
        if self.sections.is_empty() || self.sections.len() > MAX_COLLECTION_ITEMS {
            return Err(ContractError::new(
                "invalid-brief-sections",
                "briefs require a bounded non-empty section list",
            ));
        }
        let mut ids = BTreeSet::new();
        for section in &self.sections {
            validate_id(&section.id, "invalid-brief-section-id")?;
            if !ids.insert(section.id.as_str()) {
                return Err(ContractError::new(
                    "duplicate-brief-section-id",
                    "brief section identities must be unique",
                ));
            }
            validate_text(&section.heading, MAX_TITLE_BYTES, "invalid-brief-heading")?;
            validate_text(&section.body, MAX_BODY_BYTES, "invalid-brief-body")?;
            section.grounding.validate(references)?;
            if matches!(self.state, BriefState::Reviewed | BriefState::Released)
                && matches!(
                    section.grounding.state,
                    GroundingState::Unsourced
                        | GroundingState::Unresolved
                        | GroundingState::Candidate
                )
            {
                return Err(ContractError::new(
                    "reviewed-brief-has-unreviewed-section",
                    "reviewed or released briefs require grounded non-candidate sections",
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SpaceActivityKind {
    SourceImported,
    MapChanged,
    EvidenceReviewed,
    HandoffPrepared,
    HandoffCompleted,
    BriefReleased,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceActivity {
    pub id: String,
    pub at_unix_ms: u64,
    pub actor_id: String,
    pub kind: SpaceActivityKind,
    pub subject_kind: SpacesRecordKind,
    pub subject_id: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpaceSnapshot {
    pub protocol: String,
    pub application_id: CurrentApplicationId,
    pub application_revision: String,
    pub id: String,
    pub revision: u64,
    pub subject: String,
    pub purpose: String,
    pub scope: String,
    pub owner_id: String,
    pub privacy: SpacePrivacy,
    pub state: SpaceState,
    pub references: Vec<SpacesReference>,
    pub maps: Vec<SpaceMap>,
    pub topics: Vec<SpaceTopic>,
    pub notes: Vec<SpaceNote>,
    pub questions: Vec<SpaceQuestion>,
    pub hypotheses: Vec<SpaceHypothesis>,
    pub findings: Vec<SpaceFinding>,
    pub lenses: Vec<SpaceLens>,
    pub briefs: Vec<SpaceBrief>,
    pub activities: Vec<SpaceActivity>,
}

use greenways_workspace_contracts::{
    spaces_domain_manifest, GroundingState, RelationshipPromotion, SpaceSnapshot,
    SpacesDomainManifest, SpacesExportReferenceKind, SpacesPromotionOutcome,
};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const MANIFEST_FIXTURE: &str = include_str!("fixtures/spaces/domain-manifest.json");
const SPACE_FIXTURE: &str = include_str!("fixtures/spaces/space-truth-states.json");

fn fixture() -> SpaceSnapshot {
    serde_json::from_str(SPACE_FIXTURE).expect("Spaces truth-state fixture should decode")
}

fn fixture_value() -> Value {
    serde_json::from_str(SPACE_FIXTURE).expect("Spaces truth-state JSON should decode")
}

#[test]
fn manifest_is_exactly_tied_to_the_current_spaces_application() {
    let manifest: SpacesDomainManifest =
        serde_json::from_str(MANIFEST_FIXTURE).expect("Spaces manifest should decode");
    manifest
        .validate()
        .expect("Spaces manifest should match the closed contract");
    assert_eq!(manifest, spaces_domain_manifest());

    let permissions = manifest
        .fabric_groups
        .iter()
        .flat_map(|group| group.permissions.iter().copied())
        .collect::<BTreeSet<_>>();
    assert_eq!(permissions.len(), 10);
    assert_eq!(
        manifest.export_reference_kinds,
        vec![
            SpacesExportReferenceKind::Space,
            SpacesExportReferenceKind::Map,
            SpacesExportReferenceKind::Question,
            SpacesExportReferenceKind::Finding,
            SpacesExportReferenceKind::Brief,
        ]
    );
    assert_eq!(
        manifest.promotion_outcomes,
        vec![
            SpacesPromotionOutcome::KeepVisualAssociation,
            SpacesPromotionOutcome::ReviewHestiaAssertion,
            SpacesPromotionOutcome::ProposeTahtoSemanticRelationship,
        ]
    );
    assert!(!manifest.compatibility.discoverable);
    assert!(!manifest.compatibility.grants_authority);
    assert!(!manifest.compatibility.creates_duplicate_space);
}

#[test]
fn canonical_space_keeps_all_truthfulness_states_distinct() {
    let space = fixture();
    space
        .validate()
        .expect("canonical Spaces truth-state fixture should validate");

    let mut states = BTreeSet::new();
    for note in &space.notes {
        states.insert(note.grounding.state);
    }
    for question in &space.questions {
        states.insert(question.grounding.state);
    }
    for finding in &space.findings {
        states.insert(finding.grounding.state);
    }
    for brief in &space.briefs {
        for section in &brief.sections {
            states.insert(section.grounding.state);
        }
    }
    states.insert(GroundingState::Unresolved);

    assert_eq!(
        states,
        BTreeSet::from([
            GroundingState::Unsourced,
            GroundingState::Unresolved,
            GroundingState::Sourced,
            GroundingState::Derived,
            GroundingState::Candidate,
            GroundingState::Asserted,
        ])
    );
    assert!(space
        .topics
        .iter()
        .any(|topic| topic.concept_reference_id.is_none()));
    assert!(space
        .topics
        .iter()
        .any(|topic| topic.concept_reference_id.is_some()));
}

#[test]
fn map_proximity_cannot_be_promoted_to_a_hestia_assertion() {
    let mut space = fixture();
    let relationship = space.maps[0]
        .relationships
        .iter_mut()
        .find(|relationship| relationship.id == "relationship/proximity")
        .expect("proximity relationship should exist");
    relationship.promotion = RelationshipPromotion::HestiaAssertion;
    relationship.reference_ids = vec!["reference/assertion".to_owned()];

    assert_eq!(
        space
            .validate()
            .expect_err("layout proximity must remain visual-only")
            .code,
        "proximity-cannot-promote"
    );
}

#[test]
fn a_candidate_cannot_become_a_tahto_semantic_link() {
    let mut space = fixture();
    let relationship = space.maps[0]
        .relationships
        .iter_mut()
        .find(|relationship| relationship.id == "relationship/candidate")
        .expect("candidate relationship should exist");
    relationship.promotion = RelationshipPromotion::TahtoSemanticRelationship;
    relationship.reference_ids = vec![
        "reference/candidate".to_owned(),
        "reference/semantic".to_owned(),
    ];

    assert_eq!(
        space
            .validate()
            .expect_err("candidate must be accepted as an assertion before semantic promotion")
            .code,
        "candidate-cannot-be-semantic-link"
    );
}

#[test]
fn display_summaries_cannot_replace_source_or_concept_identity() {
    for reference_id in ["reference/source", "reference/concept"] {
        let mut space = fixture();
        let reference = space
            .references
            .iter_mut()
            .find(|reference| reference.id == reference_id)
            .expect("reference should exist");
        reference.observation.exact_root = None;
        reference.observation.summary = "Plausible display text without an exact owner".to_owned();

        assert_eq!(
            space
                .validate()
                .expect_err("display summary cannot replace exact observed identity")
                .code,
            "missing-spaces-reference-root"
        );
    }
}

#[test]
fn spaces_cannot_select_credentials_storage_roots_or_application_grants() {
    for forbidden_field in ["credentialId", "storageRoot", "applicationGrant"] {
        let mut value = fixture_value();
        value
            .as_object_mut()
            .expect("Space should be an object")
            .insert(forbidden_field.to_owned(), json!("caller-selected"));
        assert!(
            serde_json::from_value::<SpaceSnapshot>(value).is_err(),
            "unknown authority field {forbidden_field} must be rejected"
        );
    }

    let mut manifest: Value =
        serde_json::from_str(MANIFEST_FIXTURE).expect("manifest JSON should decode");
    manifest["fabricGroups"][0]["permissions"][0] = json!("select-credential");
    assert!(serde_json::from_value::<SpacesDomainManifest>(manifest).is_err());

    let mut space = fixture();
    space.references[0].observation.application_id =
        greenways_workspace_contracts::CurrentApplicationId::Flow;
    space.references[0].observation.owner_application_id =
        greenways_workspace_contracts::CurrentApplicationId::Flow;
    assert_eq!(
        space
            .validate()
            .expect_err("another application cannot become the Space reference owner")
            .code,
        "invalid-spaces-reference-owner"
    );
}

#[test]
fn closed_records_reject_unknown_fields_and_duplicate_ids() {
    let mut value = fixture_value();
    value["findings"][0]["generatedConfidence"] = json!(0.99);
    assert!(serde_json::from_value::<SpaceSnapshot>(value).is_err());

    let mut space = fixture();
    space.notes[1].id = space.notes[0].id.clone();
    assert_eq!(
        space
            .validate()
            .expect_err("duplicate record identity must fail")
            .code,
        "duplicate-space-record-id"
    );
}

#[test]
fn asserted_and_semantic_relationships_require_reviewed_authority() {
    let mut asserted = fixture();
    let relationship = asserted.maps[0]
        .relationships
        .iter_mut()
        .find(|relationship| relationship.id == "relationship/assertion")
        .expect("assertion relationship should exist");
    relationship.reference_ids = vec!["reference/candidate".to_owned()];
    assert_eq!(
        asserted
            .validate()
            .expect_err("candidate cannot masquerade as an assertion")
            .code,
        "candidate-cannot-promote"
    );

    let mut semantic = fixture();
    let relationship = semantic.maps[0]
        .relationships
        .iter_mut()
        .find(|relationship| relationship.id == "relationship/semantic")
        .expect("semantic relationship should exist");
    relationship.reference_ids = vec!["reference/semantic".to_owned()];
    assert_eq!(
        semantic
            .validate()
            .expect_err("semantic link needs an accepted assertion first")
            .code,
        "candidate-cannot-be-semantic-link"
    );
}

#[test]
fn accepted_external_records_cannot_revert_to_candidate_authority() {
    let mut space = fixture();
    let assertion = space
        .references
        .iter_mut()
        .find(|reference| reference.id == "reference/assertion")
        .expect("assertion reference should exist");
    assertion.observation.authority_state =
        greenways_workspace_contracts::ReferenceAuthorityState::ResolutionRequired;

    assert_eq!(
        space
            .validate()
            .expect_err("accepted assertion must remain an observed external record")
            .code,
        "invalid-spaces-reference-authority"
    );
}

#[test]
fn promotion_cannot_smuggle_flow_or_public_work_authority() {
    let mut space = fixture();
    let relationship = space.maps[0]
        .relationships
        .iter_mut()
        .find(|relationship| relationship.id == "relationship/assertion")
        .expect("assertion relationship should exist");
    relationship.reference_ids = vec![
        "reference/assertion".to_owned(),
        "reference/flow".to_owned(),
    ];

    assert_eq!(
        space
            .validate()
            .expect_err("Hestia promotion cannot carry Flow authority")
            .code,
        "assertion-has-non-hestia-authority"
    );
}

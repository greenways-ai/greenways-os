impl SpaceSnapshot {
    pub fn validate(&self) -> Result<(), ContractError> {
        if self.protocol != SPACE_SNAPSHOT_PROTOCOL {
            return Err(ContractError::new(
                "space-protocol-mismatch",
                "Space snapshot uses an unsupported protocol",
            ));
        }
        if self.application_id != CurrentApplicationId::Spaces
            || self.application_revision != SPACES_DOMAIN_REVISION
        {
            return Err(ContractError::new(
                "space-application-mismatch",
                "Space snapshot must be owned by the exact current Spaces application",
            ));
        }
        validate_record_header(self.revision, &self.id, &self.subject)?;
        validate_text(&self.purpose, MAX_SUMMARY_BYTES, "invalid-space-purpose")?;
        validate_text(&self.scope, MAX_SCOPE_BYTES, "invalid-space-scope")?;
        validate_id(&self.owner_id, "invalid-space-owner")?;
        ensure_collection_bounds(self)?;

        let mut record_index = BTreeMap::new();
        insert_record(&mut record_index, &self.id, SpacesRecordKind::Space)?;
        for reference in &self.references {
            reference.validate(&self.id)?;
            insert_record(
                &mut record_index,
                &reference.id,
                SpacesRecordKind::Reference,
            )?;
        }
        for map in &self.maps {
            insert_record(&mut record_index, &map.id, SpacesRecordKind::Map)?;
            for node in &map.nodes {
                insert_record(&mut record_index, &node.id, SpacesRecordKind::MapNode)?;
            }
            for relationship in &map.relationships {
                insert_record(
                    &mut record_index,
                    &relationship.id,
                    SpacesRecordKind::VisualRelationship,
                )?;
            }
        }
        for topic in &self.topics {
            insert_record(&mut record_index, &topic.id, SpacesRecordKind::Topic)?;
        }
        for note in &self.notes {
            insert_record(&mut record_index, &note.id, SpacesRecordKind::Note)?;
        }
        for question in &self.questions {
            insert_record(&mut record_index, &question.id, SpacesRecordKind::Question)?;
        }
        for hypothesis in &self.hypotheses {
            insert_record(
                &mut record_index,
                &hypothesis.id,
                SpacesRecordKind::Hypothesis,
            )?;
        }
        for finding in &self.findings {
            insert_record(&mut record_index, &finding.id, SpacesRecordKind::Finding)?;
        }
        for lens in &self.lenses {
            insert_record(&mut record_index, &lens.id, SpacesRecordKind::Lens)?;
        }
        for brief in &self.briefs {
            insert_record(&mut record_index, &brief.id, SpacesRecordKind::Brief)?;
        }
        for activity in &self.activities {
            insert_record(&mut record_index, &activity.id, SpacesRecordKind::Activity)?;
        }

        let references = self
            .references
            .iter()
            .map(|reference| (reference.id.as_str(), reference))
            .collect::<BTreeMap<_, _>>();

        for topic in &self.topics {
            topic.validate(&references)?;
        }
        for note in &self.notes {
            validate_record_header(note.revision, &note.id, &note.body)?;
            note.grounding.validate(&references)?;
        }
        for question in &self.questions {
            question.validate(&references)?;
        }
        for hypothesis in &self.hypotheses {
            hypothesis.validate(&references)?;
        }
        for finding in &self.findings {
            finding.validate(&references)?;
        }
        for lens in &self.lenses {
            lens.validate()?;
        }
        for brief in &self.briefs {
            brief.validate(&references)?;
        }
        for map in &self.maps {
            validate_map(map, &record_index, &references)?;
        }
        for activity in &self.activities {
            validate_activity(activity, &record_index)?;
        }
        Ok(())
    }
}

fn ensure_collection_bounds(space: &SpaceSnapshot) -> Result<(), ContractError> {
    let collections = [
        space.references.len(),
        space.maps.len(),
        space.topics.len(),
        space.notes.len(),
        space.questions.len(),
        space.hypotheses.len(),
        space.findings.len(),
        space.lenses.len(),
        space.briefs.len(),
        space.activities.len(),
    ];
    if collections
        .iter()
        .any(|length| *length > MAX_COLLECTION_ITEMS)
    {
        return Err(ContractError::new(
            "space-collection-too-large",
            "Space record collections exceed the closed contract bound",
        ));
    }
    Ok(())
}

fn validate_map(
    map: &SpaceMap,
    record_index: &BTreeMap<&str, SpacesRecordKind>,
    references: &BTreeMap<&str, &SpacesReference>,
) -> Result<(), ContractError> {
    validate_record_header(map.revision, &map.id, &map.title)?;
    if map.nodes.len() > MAX_MAP_NODES || map.relationships.len() > MAX_MAP_RELATIONSHIPS {
        return Err(ContractError::new(
            "map-too-large",
            "map node or relationship collection exceeds its bound",
        ));
    }
    validate_id_list(&map.selected_record_ids, "invalid-map-selection")?;
    for selected_id in &map.selected_record_ids {
        if !record_index.contains_key(selected_id.as_str()) {
            return Err(ContractError::new(
                "unknown-map-selection",
                "map selection points outside the containing Space",
            ));
        }
    }
    if let Some(lens_id) = &map.lens_id {
        require_record_kind(
            lens_id,
            SpacesRecordKind::Lens,
            record_index,
            "invalid-map-lens",
        )?;
    }

    let mut node_ids = BTreeSet::new();
    for node in &map.nodes {
        validate_record_header(node.revision, &node.id, &node.label)?;
        node.layout.validate()?;
        if !node_ids.insert(node.id.as_str()) {
            return Err(ContractError::new(
                "duplicate-map-node-id",
                "map node identities must be unique within a map",
            ));
        }
        require_record_kind(
            &node.target.id,
            node.target.kind.record_kind(),
            record_index,
            "invalid-map-node-target",
        )?;
    }

    let mut group_ids = BTreeSet::new();
    for group in &map.groups {
        validate_id(&group.id, "invalid-map-group-id")?;
        validate_text(&group.title, MAX_TITLE_BYTES, "invalid-map-group-title")?;
        if !group_ids.insert(group.id.as_str()) {
            return Err(ContractError::new(
                "duplicate-map-group-id",
                "map group identities must be unique",
            ));
        }
        validate_id_list(&group.node_ids, "invalid-map-group-node")?;
        if group
            .node_ids
            .iter()
            .any(|node_id| !node_ids.contains(node_id.as_str()))
        {
            return Err(ContractError::new(
                "unknown-map-group-node",
                "map groups may contain only nodes from the same map",
            ));
        }
    }

    let mut relationship_ids = BTreeSet::new();
    for relationship in &map.relationships {
        if !relationship_ids.insert(relationship.id.as_str()) {
            return Err(ContractError::new(
                "duplicate-visual-relationship-id",
                "visual relationship identities must be unique within a map",
            ));
        }
        relationship.validate(&node_ids, references)?;
    }
    Ok(())
}

fn validate_activity(
    activity: &SpaceActivity,
    record_index: &BTreeMap<&str, SpacesRecordKind>,
) -> Result<(), ContractError> {
    validate_id(&activity.id, "invalid-space-activity-id")?;
    validate_id(&activity.actor_id, "invalid-space-activity-actor")?;
    validate_text(
        &activity.summary,
        MAX_SUMMARY_BYTES,
        "invalid-space-activity-summary",
    )?;
    if activity.at_unix_ms == 0 {
        return Err(ContractError::new(
            "invalid-space-activity-time",
            "Space activity time must be positive",
        ));
    }
    require_record_kind(
        &activity.subject_id,
        activity.subject_kind,
        record_index,
        "invalid-space-activity-subject",
    )
}

fn require_assertion_without_candidate(kinds: &[SpacesReferenceKind]) -> Result<(), ContractError> {
    if !kinds.contains(&SpacesReferenceKind::HestiaAssertion)
        || kinds.contains(&SpacesReferenceKind::HestiaCandidate)
    {
        return Err(ContractError::new(
            "candidate-cannot-promote",
            "canonical promotion requires an accepted Hestia assertion, not a candidate",
        ));
    }
    Ok(())
}

fn require_only_reference_kinds(
    kinds: &[SpacesReferenceKind],
    allowed: &[SpacesReferenceKind],
    code: &'static str,
) -> Result<(), ContractError> {
    if kinds.iter().any(|kind| !allowed.contains(kind)) {
        return Err(ContractError::new(
            code,
            "promotion contains a reference outside its owning authority boundary",
        ));
    }
    Ok(())
}

fn resolve_reference_kinds(
    ids: &[String],
    references: &BTreeMap<&str, &SpacesReference>,
) -> Result<Vec<SpacesReferenceKind>, ContractError> {
    ids.iter()
        .map(|id| {
            references
                .get(id.as_str())
                .map(|reference| reference.kind)
                .ok_or_else(|| {
                    ContractError::new(
                        "unknown-spaces-reference",
                        "record points to a reference outside the containing Space",
                    )
                })
        })
        .collect()
}

fn require_reference_kind(
    id: &str,
    expected: SpacesReferenceKind,
    references: &BTreeMap<&str, &SpacesReference>,
    code: &'static str,
) -> Result<(), ContractError> {
    match references.get(id) {
        Some(reference) if reference.kind == expected => Ok(()),
        _ => Err(ContractError::new(
            code,
            "reference kind does not match the record contract",
        )),
    }
}

fn require_record_kind(
    id: &str,
    expected: SpacesRecordKind,
    records: &BTreeMap<&str, SpacesRecordKind>,
    code: &'static str,
) -> Result<(), ContractError> {
    match records.get(id) {
        Some(kind) if *kind == expected => Ok(()),
        _ => Err(ContractError::new(
            code,
            "record kind does not match the containing Space",
        )),
    }
}

fn insert_record<'a>(
    records: &mut BTreeMap<&'a str, SpacesRecordKind>,
    id: &'a str,
    kind: SpacesRecordKind,
) -> Result<(), ContractError> {
    validate_id(id, "invalid-space-record-id")?;
    if records.insert(id, kind).is_some() {
        return Err(ContractError::new(
            "duplicate-space-record-id",
            "record identities must be unique across one Space aggregate",
        ));
    }
    Ok(())
}

fn validate_record_header(revision: u64, id: &str, text: &str) -> Result<(), ContractError> {
    require_positive_revision(revision)?;
    validate_id(id, "invalid-space-record-id")?;
    validate_text(text, MAX_BODY_BYTES, "invalid-space-record-text")
}

fn require_positive_revision(revision: u64) -> Result<(), ContractError> {
    if revision == 0 {
        return Err(ContractError::new(
            "invalid-space-record-revision",
            "Space record revisions must be positive",
        ));
    }
    Ok(())
}

fn validate_id(value: &str, code: &'static str) -> Result<(), ContractError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value.trim() != value
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':' | b'@')
        })
    {
        return Err(ContractError::new(
            code,
            "identifier is empty, oversized, padded, or contains unsupported bytes",
        ));
    }
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize, code: &'static str) -> Result<(), ContractError> {
    if value.is_empty() || value.len() > max_bytes || value.trim() != value {
        return Err(ContractError::new(
            code,
            "text is empty, oversized, or padded",
        ));
    }
    Ok(())
}

fn validate_id_list(values: &[String], code: &'static str) -> Result<(), ContractError> {
    if values.len() > MAX_COLLECTION_ITEMS {
        return Err(ContractError::new(
            code,
            "identifier list exceeds the closed contract bound",
        ));
    }
    let mut seen = BTreeSet::new();
    for value in values {
        validate_id(value, code)?;
        if !seen.insert(value.as_str()) {
            return Err(ContractError::new(
                code,
                "identifier lists cannot contain duplicates",
            ));
        }
    }
    Ok(())
}

fn all_unique<T: Ord + Copy>(values: &[T]) -> bool {
    values.iter().copied().collect::<BTreeSet<_>>().len() == values.len()
}

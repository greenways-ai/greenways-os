use super::*;
use greenways_capabilities::{
    ProviderGrantEvidence, ProviderInvocationAuthority, PROVIDER_GRANT_EVIDENCE_PROTOCOL,
};
use greenways_protocol::{provider_invocation_from_request, ProviderInvocationRequest};
use greenways_provider::{
    validate_model_id, validate_profile_id, ProviderInvocation, MAX_OUTPUT_TOKENS, MAX_TIMEOUT_MS,
};
use sha2::{Digest, Sha256};

pub(super) const LEGACY_PROVIDER_INVOCATION_CLAIM_PROTOCOL: &str =
    "greenways-provider-invocation-claim/0-alpha";
pub(super) const PROVIDER_INVOCATION_CLAIM_PROTOCOL: &str =
    "greenways-provider-invocation-claim/1-alpha";
pub(super) const PROVIDER_AUTHORITY_EVIDENCE_PROTOCOL: &str =
    "greenways-provider-authority-evidence/0-alpha";
const PROVIDER_AUTHORITY_BINDING_PROTOCOL: &str = "greenways-provider-authority-binding/0-alpha";
pub(super) const MAX_PROVIDER_INVOCATION_CLAIMS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProviderInvocationAuthorityEvidence {
    pub(super) protocol: String,
    pub(super) approval_digest: String,
    pub(super) grant_id: String,
    pub(super) grant_subject_root: String,
    pub(super) capability: String,
    pub(super) profile_id: String,
    pub(super) model: String,
    pub(super) max_output_tokens: u32,
    pub(super) timeout_ms: u64,
    pub(super) authorized_at_unix_ms: u64,
    pub(super) binding_digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderAuthorityBinding<'a> {
    protocol: &'static str,
    request_digest: &'a str,
    approval_digest: &'a str,
    grant_id: &'a str,
    grant_subject_root: &'a str,
    capability: &'a str,
    profile_id: &'a str,
    model: &'a str,
    max_output_tokens: u32,
    timeout_ms: u64,
    authorized_at_unix_ms: u64,
}

impl ProviderInvocationAuthorityEvidence {
    pub(super) fn from_grant(
        request_digest: &str,
        evidence: ProviderGrantEvidence,
        invocation: &ProviderInvocation,
        authorized_at_unix_ms: u64,
    ) -> Result<Self, DaemonError> {
        evidence.validate()?;
        let mut authority = Self {
            protocol: PROVIDER_AUTHORITY_EVIDENCE_PROTOCOL.to_owned(),
            approval_digest: evidence.approval_digest,
            grant_id: evidence.grant_id,
            grant_subject_root: evidence.grant_subject_root,
            capability: evidence.capability,
            profile_id: invocation.profile_id.clone(),
            model: invocation.model.clone(),
            max_output_tokens: invocation.max_output_tokens,
            timeout_ms: invocation.timeout_ms,
            authorized_at_unix_ms,
            binding_digest: String::new(),
        };
        authority.binding_digest = authority.expected_binding_digest(request_digest)?;
        authority.validate(request_digest)?;
        Ok(authority)
    }

    pub(super) fn grant_evidence(&self) -> ProviderGrantEvidence {
        ProviderGrantEvidence {
            protocol: PROVIDER_GRANT_EVIDENCE_PROTOCOL.to_owned(),
            approval_digest: self.approval_digest.clone(),
            grant_id: self.grant_id.clone(),
            grant_subject_root: self.grant_subject_root.clone(),
            capability: self.capability.clone(),
        }
    }

    pub(super) fn validate(&self, request_digest: &str) -> Result<(), DaemonError> {
        if self.protocol != PROVIDER_AUTHORITY_EVIDENCE_PROTOCOL {
            return Err(DaemonError::State(
                "provider authority evidence protocol is unsupported".to_owned(),
            ));
        }
        self.grant_evidence().validate()?;
        validate_profile_id(&self.profile_id).map_err(|_| {
            DaemonError::State("provider authority profile ID is invalid".to_owned())
        })?;
        validate_model_id(&self.model)
            .map_err(|_| DaemonError::State("provider authority model ID is invalid".to_owned()))?;
        if !(1..=MAX_OUTPUT_TOKENS).contains(&self.max_output_tokens)
            || !(1_000..=MAX_TIMEOUT_MS).contains(&self.timeout_ms)
            || self.authorized_at_unix_ms == 0
        {
            return Err(DaemonError::State(
                "provider authority invocation limits are invalid".to_owned(),
            ));
        }
        if self.binding_digest != self.expected_binding_digest(request_digest)? {
            return Err(DaemonError::State(
                "provider authority evidence is not bound to its exact request".to_owned(),
            ));
        }
        Ok(())
    }

    pub(super) fn matches_invocation(&self, invocation: &ProviderInvocation) -> bool {
        self.profile_id == invocation.profile_id
            && self.model == invocation.model
            && self.max_output_tokens == invocation.max_output_tokens
            && self.timeout_ms == invocation.timeout_ms
    }

    pub(super) fn expected_binding_digest(
        &self,
        request_digest: &str,
    ) -> Result<String, DaemonError> {
        if !validate_digest(request_digest) {
            return Err(DaemonError::State(
                "provider authority request digest is invalid".to_owned(),
            ));
        }
        let bytes = serde_json::to_vec(&ProviderAuthorityBinding {
            protocol: PROVIDER_AUTHORITY_BINDING_PROTOCOL,
            request_digest,
            approval_digest: &self.approval_digest,
            grant_id: &self.grant_id,
            grant_subject_root: &self.grant_subject_root,
            capability: &self.capability,
            profile_id: &self.profile_id,
            model: &self.model,
            max_output_tokens: self.max_output_tokens,
            timeout_ms: self.timeout_ms,
            authorized_at_unix_ms: self.authorized_at_unix_ms,
        })
        .map_err(|_| {
            DaemonError::State("provider authority binding could not be encoded".to_owned())
        })?;
        Ok(format!("sha256:{}", encode_hex(&Sha256::digest(bytes))))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProviderInvocationClaim {
    pub(super) protocol: String,
    pub(super) request_id: String,
    pub(super) digest: String,
    pub(super) actor: RequestActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) authority: Option<ProviderInvocationAuthorityEvidence>,
    pub(super) prepared_at_unix_ms: u64,
}

impl Daemon {
    pub(super) fn handle_provider_invocation_at(
        &mut self,
        request: LocalRequest,
        actor: RequestActor,
        observed_at_unix_ms: u64,
    ) -> Result<LocalResponse, DaemonError> {
        let provider_request = provider_invocation_from_request(&request)?;
        let digest = request_digest(&request)?;

        if let Some(receipt) = self
            .state
            .receipts
            .iter()
            .find(|receipt| receipt.request_id == request.request_id)
        {
            if receipt.digest != digest || receipt.actor.as_ref() != Some(&actor) {
                return Ok(request_collision(&request.request_id));
            }
            return Ok(receipt.response.clone());
        }

        if let Some(claim) = self
            .state
            .provider_invocations
            .iter()
            .find(|claim| claim.request_id == request.request_id)
        {
            if claim.digest != digest || claim.actor != actor {
                return Ok(request_collision(&request.request_id));
            }
            return Ok(provider_uncertain(&request.request_id));
        }

        let authorized = match provider_request {
            ProviderInvocationRequest::Legacy(_) => {
                return Ok(LocalResponse::error(
                    request.request_id,
                    "provider-authority-required",
                    "New provider invocations require exact application authority.",
                ));
            }
            ProviderInvocationRequest::Authorized(authorized) => authorized,
        };

        let application = self.applications.authorize_exact(
            &authorized.check.subject,
            &authorized.check.capability,
            observed_at_unix_ms,
        )?;
        if !application.allowed {
            return Ok(provider_authority_denied(&request.request_id));
        }
        let grant = match self.capabilities.authorize_provider_invocation(
            &authorized.check,
            &authorized.invocation,
            observed_at_unix_ms,
        )? {
            ProviderInvocationAuthority::Allowed(evidence) => evidence,
            ProviderInvocationAuthority::Denied(_) => {
                return Ok(provider_authority_denied(&request.request_id));
            }
        };
        let authority = ProviderInvocationAuthorityEvidence::from_grant(
            &digest,
            grant,
            &authorized.invocation,
            observed_at_unix_ms,
        )?;

        let canonical = canonical_request(&request)?;
        let request_text = String::from_utf8(canonical).map_err(|_| {
            DaemonError::State("canonical provider request was not UTF-8".to_owned())
        })?;
        let claim = ProviderInvocationClaim {
            protocol: PROVIDER_INVOCATION_CLAIM_PROTOCOL.to_owned(),
            request_id: request.request_id.clone(),
            digest: digest.clone(),
            actor: actor.clone(),
            authority: Some(authority),
            prepared_at_unix_ms: observed_at_unix_ms,
        };
        self.prepare_provider_invocation(claim.clone())?;

        let completed_at_unix_ms = now_unix_ms()?;
        let response = match self
            .vault
            .invoke(&authorized.invocation, completed_at_unix_ms)
        {
            Ok(result) => LocalResponse::ok(
                request.request_id.clone(),
                serde_json::to_value(result).map_err(|_| {
                    DaemonError::State("provider result could not be encoded".to_owned())
                })?,
            ),
            Err(VaultError::NotFound(_)) => LocalResponse::error(
                request.request_id.clone(),
                "provider-profile-missing",
                "The selected Greenways provider profile does not exist.",
            ),
            Err(VaultError::Invalid(_)) => LocalResponse::error(
                request.request_id.clone(),
                "invalid-provider-invocation",
                "The Greenways provider invocation is invalid.",
            ),
            Err(VaultError::ProviderRejected) => LocalResponse::error(
                request.request_id.clone(),
                "provider-request-rejected",
                "The model provider rejected the request.",
            ),
            Err(VaultError::ProviderUncertain) => {
                return Ok(provider_uncertain(&request.request_id))
            }
            Err(VaultError::CredentialUnavailable) => LocalResponse::error(
                request.request_id.clone(),
                "provider-unavailable",
                "The selected Greenways provider credential is unavailable.",
            ),
            Err(VaultError::Io(_) | VaultError::Encoding(_) | VaultError::Conflict(_)) => {
                LocalResponse::error(
                    request.request_id.clone(),
                    "provider-unavailable",
                    "The Greenways provider service is unavailable.",
                )
            }
        };

        self.complete_provider_invocation(
            &claim,
            request_text,
            response.clone(),
            completed_at_unix_ms,
        )?;
        Ok(response)
    }

    pub(super) fn prepare_provider_invocation(
        &mut self,
        claim: ProviderInvocationClaim,
    ) -> Result<(), DaemonError> {
        if self.state.provider_invocations.len() >= MAX_PROVIDER_INVOCATION_CLAIMS {
            return Err(DaemonError::State(
                "provider invocation claim limit was reached".to_owned(),
            ));
        }
        validate_provider_claim(&claim, self.state.created_at_unix_ms)?;
        let previous = self.state.clone();
        self.state.revision = self
            .state
            .revision
            .checked_add(1)
            .ok_or_else(|| DaemonError::State("revision overflowed".to_owned()))?;
        self.state.provider_invocations.push(claim);
        if let Err(error) = trim_receipts_to_fit(&mut self.state) {
            self.state = previous;
            return Err(error);
        }
        if let Err(error) = write_state(&self.paths.state_file, &self.state) {
            self.state = previous;
            return Err(error);
        }
        Ok(())
    }

    fn complete_provider_invocation(
        &mut self,
        claim: &ProviderInvocationClaim,
        request: String,
        response: LocalResponse,
        committed_at_unix_ms: u64,
    ) -> Result<(), DaemonError> {
        let authority = claim.authority.as_ref().ok_or_else(|| {
            DaemonError::State("provider invocation claim has no authority evidence".to_owned())
        })?;
        let index = self
            .state
            .provider_invocations
            .iter()
            .position(|candidate| candidate == claim)
            .ok_or_else(|| {
                DaemonError::State("provider invocation claim disappeared".to_owned())
            })?;
        let previous = self.state.clone();
        self.state.provider_invocations.remove(index);
        self.state.revision = self
            .state
            .revision
            .checked_add(1)
            .ok_or_else(|| DaemonError::State("revision overflowed".to_owned()))?;
        self.state.receipts.push(RequestReceipt {
            protocol: PROVIDER_RECEIPT_PROTOCOL.to_owned(),
            request_id: claim.request_id.clone(),
            digest: claim.digest.clone(),
            actor: Some(claim.actor.clone()),
            request,
            response,
            provider_authority: Some(authority.clone()),
            committed_at_unix_ms,
        });
        if let Err(error) = trim_receipts_to_fit(&mut self.state) {
            self.state = previous;
            return Err(error);
        }
        if let Err(error) = write_state(&self.paths.state_file, &self.state) {
            self.state = previous;
            return Err(error);
        }
        Ok(())
    }
}

pub(super) fn role_may_invoke_provider(role: LocalClientRole) -> bool {
    matches!(
        role,
        LocalClientRole::Desktop | LocalClientRole::Cli | LocalClientRole::Developer
    )
}

pub(super) fn validate_provider_claim(
    claim: &ProviderInvocationClaim,
    state_created_at_unix_ms: u64,
) -> Result<(), DaemonError> {
    if !greenways_protocol::valid_request_id(&claim.request_id)
        || !validate_digest(&claim.digest)
        || !valid_client_id(&claim.actor.client_id)
        || !role_may_invoke_provider(claim.actor.role)
        || claim.prepared_at_unix_ms < state_created_at_unix_ms
    {
        return Err(DaemonError::State(
            "provider invocation claim is invalid".to_owned(),
        ));
    }
    match claim.protocol.as_str() {
        LEGACY_PROVIDER_INVOCATION_CLAIM_PROTOCOL if claim.authority.is_none() => Ok(()),
        PROVIDER_INVOCATION_CLAIM_PROTOCOL => {
            let authority = claim.authority.as_ref().ok_or_else(|| {
                DaemonError::State("provider invocation claim has no authority evidence".to_owned())
            })?;
            authority.validate(&claim.digest)?;
            if authority.authorized_at_unix_ms != claim.prepared_at_unix_ms {
                return Err(DaemonError::State(
                    "provider invocation claim authority time is invalid".to_owned(),
                ));
            }
            Ok(())
        }
        _ => Err(DaemonError::State(
            "provider invocation claim protocol is unsupported".to_owned(),
        )),
    }
}

pub(super) fn trim_receipts_to_fit(state: &mut DaemonState) -> Result<(), DaemonError> {
    while state.receipts.len() > MAX_RECEIPTS {
        state.receipts.remove(0);
    }
    loop {
        let bytes = serde_json::to_vec(state)
            .map_err(|_| DaemonError::State("state could not be measured".to_owned()))?;
        if bytes.len() <= MAX_STATE_BYTES {
            return Ok(());
        }
        if state.receipts.is_empty() {
            return Err(DaemonError::State(
                "daemon state cannot fit within its durable byte limit".to_owned(),
            ));
        }
        state.receipts.remove(0);
    }
}

fn request_collision(request_id: &str) -> LocalResponse {
    LocalResponse::error(
        request_id,
        "request-id-collision",
        "Greenways local request ID was reused by another actor or with different content.",
    )
}

fn provider_authority_denied(request_id: &str) -> LocalResponse {
    LocalResponse::error(
        request_id,
        "provider-authority-denied",
        "The application is not authorized for this provider invocation.",
    )
}

fn provider_uncertain(request_id: &str) -> LocalResponse {
    LocalResponse::error(
        request_id,
        "provider-invocation-uncertain",
        "The provider invocation may have executed and will not be retried automatically.",
    )
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

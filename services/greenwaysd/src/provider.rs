use super::*;
use greenways_provider::ProviderInvocation;

pub(super) const PROVIDER_INVOCATION_CLAIM_PROTOCOL: &str =
    "greenways-provider-invocation-claim/0-alpha";
pub(super) const MAX_PROVIDER_INVOCATION_CLAIMS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ProviderInvocationClaim {
    pub(super) protocol: String,
    pub(super) request_id: String,
    pub(super) digest: String,
    pub(super) actor: RequestActor,
    pub(super) prepared_at_unix_ms: u64,
}

impl Daemon {
    pub(super) fn handle_provider_invocation_at(
        &mut self,
        request: LocalRequest,
        actor: RequestActor,
        observed_at_unix_ms: u64,
    ) -> Result<LocalResponse, DaemonError> {
        let invocation =
            ProviderInvocation::from_arguments(&request.arguments).map_err(|error| {
                DaemonError::State(format!(
                    "validated provider invocation could not be decoded: {}",
                    error.code()
                ))
            })?;
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

        let canonical = canonical_request(&request)?;
        let request_text = String::from_utf8(canonical).map_err(|_| {
            DaemonError::State("canonical provider request was not UTF-8".to_owned())
        })?;
        self.prepare_provider_invocation(ProviderInvocationClaim {
            protocol: PROVIDER_INVOCATION_CLAIM_PROTOCOL.to_owned(),
            request_id: request.request_id.clone(),
            digest: digest.clone(),
            actor: actor.clone(),
            prepared_at_unix_ms: observed_at_unix_ms,
        })?;

        let completed_at_unix_ms = now_unix_ms()?;
        let response = match self.vault.invoke(&invocation, completed_at_unix_ms) {
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
            &request.request_id,
            &digest,
            &actor,
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
        request_id: &str,
        digest: &str,
        actor: &RequestActor,
        request: String,
        response: LocalResponse,
        committed_at_unix_ms: u64,
    ) -> Result<(), DaemonError> {
        let index = self
            .state
            .provider_invocations
            .iter()
            .position(|claim| {
                claim.request_id == request_id && claim.digest == digest && &claim.actor == actor
            })
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
            protocol: RECEIPT_PROTOCOL.to_owned(),
            request_id: request_id.to_owned(),
            digest: digest.to_owned(),
            actor: Some(actor.clone()),
            request,
            response,
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
    if claim.protocol != PROVIDER_INVOCATION_CLAIM_PROTOCOL
        || !greenways_protocol::valid_request_id(&claim.request_id)
        || !validate_digest(&claim.digest)
        || !valid_client_id(&claim.actor.client_id)
        || claim.prepared_at_unix_ms < state_created_at_unix_ms
    {
        return Err(DaemonError::State(
            "provider invocation claim is invalid".to_owned(),
        ));
    }
    Ok(())
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

fn provider_uncertain(request_id: &str) -> LocalResponse {
    LocalResponse::error(
        request_id,
        "provider-invocation-uncertain",
        "The provider invocation may have executed and will not be retried automatically.",
    )
}

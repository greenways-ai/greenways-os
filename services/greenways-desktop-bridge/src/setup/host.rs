use super::*;
use greenways_desktop_bridge::now_unix_ms;
use serde_json::Value;

pub struct DesktopSetupHost<B> {
    backend: B,
    snapshot: DesktopSetupSnapshot,
}

impl<B: DesktopSetupBackend> DesktopSetupHost<B> {
    pub fn new(backend: B, observed_at_unix_ms: u64) -> Self {
        Self {
            backend,
            snapshot: DesktopSetupSnapshot::not_inspected(observed_at_unix_ms),
        }
    }

    pub fn handle(
        &mut self,
        request: DesktopSetupRequest,
    ) -> Result<DesktopSetupResponse, DesktopSetupError> {
        request.validate()?;
        let result = match request.operation {
            DesktopSetupOperation::Inspect => self.backend.inspect(),
            DesktopSetupOperation::InstallDaemon => self.backend.install_daemon(),
            DesktopSetupOperation::IssueDesktopClient => self.backend.issue_desktop_client(),
            DesktopSetupOperation::RepairPermissions => self.backend.repair_permissions(),
            operation => Err(DesktopSetupError::OperationUnavailable(format!(
                "The {} setup operation is not available in this build.",
                operation.as_str()
            ))),
        };
        let observed_at_unix_ms = now_unix_ms().map_err(|_| {
            DesktopSetupError::InspectionFailed(
                "The Desktop setup clock is unavailable.".to_owned(),
            )
        })?;
        self.snapshot = match result {
            Ok(snapshot) => snapshot,
            Err(error) => DesktopSetupSnapshot::failed(error, observed_at_unix_ms),
        };
        self.snapshot.validate()?;
        let response = DesktopSetupResponse::new(request.request_id, self.snapshot.clone());
        response.validate()?;
        Ok(response)
    }
}

pub fn decode_setup_request(bytes: &[u8]) -> Result<DesktopSetupRequest, DesktopSetupError> {
    let request: DesktopSetupRequest = serde_json::from_slice(bytes).map_err(|_| {
        DesktopSetupError::ProtocolMismatch(
            "Desktop setup input must be one closed JSON object.".to_owned(),
        )
    })?;
    request.validate()?;
    Ok(request)
}

pub fn encode_setup_response(
    response: &DesktopSetupResponse,
) -> Result<Vec<u8>, DesktopSetupError> {
    response.validate()?;
    let mut bytes = serde_json::to_vec(response).map_err(|_| {
        DesktopSetupError::ProtocolMismatch(
            "The Desktop setup result could not be encoded.".to_owned(),
        )
    })?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn request_protocol(bytes: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    value.get("protocol")?.as_str().map(ToOwned::to_owned)
}

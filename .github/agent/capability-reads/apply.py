from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def replace(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"anchor count {text.count(old)} in {path}: {old[:120]!r}")
    target.write_text(text.replace(old, new))


replace(
    "services/greenwaysd/Cargo.toml",
    '[dependencies]\ngreenways-authority = { path = "../../crates/greenways-authority" }\n',
    '[dependencies]\ngreenways-authority = { path = "../../crates/greenways-authority" }\ngreenways-capabilities = { path = "../../crates/greenways-capabilities" }\n',
)
replace(
    "cli/greenways/Cargo.toml",
    '[dependencies]\ngreenways-authority = { path = "../../crates/greenways-authority" }\n',
    '[dependencies]\ngreenways-authority = { path = "../../crates/greenways-authority" }\ngreenways-capabilities = { path = "../../crates/greenways-capabilities" }\n',
)

replace(
    "crates/greenways-protocol/src/lib.rs",
    '''    pub fn identity_public_card(request_id: impl Into<String>) -> Self {
        Self {
            protocol: LOCAL_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            operation: "identity.public-card".to_owned(),
            arguments: Map::new(),
        }
    }
''',
    '''    pub fn identity_public_card(request_id: impl Into<String>) -> Self {
        Self {
            protocol: LOCAL_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            operation: "identity.public-card".to_owned(),
            arguments: Map::new(),
        }
    }

    pub fn capabilities_status(request_id: impl Into<String>) -> Self {
        Self {
            protocol: LOCAL_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            operation: "capabilities.status".to_owned(),
            arguments: Map::new(),
        }
    }

    pub fn capabilities_list(request_id: impl Into<String>) -> Self {
        Self {
            protocol: LOCAL_PROTOCOL.to_owned(),
            request_id: request_id.into(),
            operation: "capabilities.list".to_owned(),
            arguments: Map::new(),
        }
    }
''',
)
replace(
    "crates/greenways-protocol/src/lib.rs",
    '''            | "identity.status"
            | "identity.public-card"
''',
    '''            | "identity.status"
            | "identity.public-card"
            | "capabilities.status"
            | "capabilities.list"
''',
)
replace(
    "crates/greenways-protocol/src/lib.rs",
    '''    #[test]
    fn validates_response_outcome_shape() {
''',
    '''    #[test]
    fn publishes_closed_capability_authority_reads() {
        let status = LocalRequest::capabilities_status("local/request/capstatus1");
        let list = LocalRequest::capabilities_list("local/request/caplist001");
        assert!(validate_request(&status).is_ok());
        assert!(validate_request(&list).is_ok());
        assert!(status.arguments.is_empty());
        assert!(list.arguments.is_empty());
    }

    #[test]
    fn validates_response_outcome_shape() {
''',
)

replace(
    "crates/greenways-local/src/lib.rs",
    '''    pub fn identity_public_card(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::identity_public_card(new_request_id()?))
    }
''',
    '''    pub fn identity_public_card(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::identity_public_card(new_request_id()?))
    }

    pub fn capabilities_status(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::capabilities_status(new_request_id()?))
    }

    pub fn capabilities(&mut self) -> Result<LocalResponse, LocalError> {
        self.send(&LocalRequest::capabilities_list(new_request_id()?))
    }
''',
)

replace(
    "services/greenwaysd/src/lib.rs",
    'use greenways_identity::{IdentityError, ProfileIdentityVault};\n',
    'use greenways_capabilities::{CapabilityAuthority, CapabilityError};\nuse greenways_identity::{IdentityError, ProfileIdentityVault};\n',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''    Authority(AuthorityError),
    Identity(IdentityError),
    Vault(VaultError),
''',
    '''    Authority(AuthorityError),
    Capability(CapabilityError),
    Identity(IdentityError),
    Vault(VaultError),
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''            Self::Authority(error) => {
                write!(formatter, "Greenways daemon authority failed: {error}")
            }
            Self::Identity(error) => {
''',
    '''            Self::Authority(error) => {
                write!(formatter, "Greenways daemon authority failed: {error}")
            }
            Self::Capability(error) => {
                write!(formatter, "Greenways daemon capability authority failed: {error}")
            }
            Self::Identity(error) => {
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''            Self::Authority(error) => Some(error),
            Self::Identity(error) => Some(error),
''',
    '''            Self::Authority(error) => Some(error),
            Self::Capability(error) => Some(error),
            Self::Identity(error) => Some(error),
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''impl From<IdentityError> for DaemonError {
''',
    '''impl From<CapabilityError> for DaemonError {
    fn from(value: CapabilityError) -> Self {
        Self::Capability(value)
    }
}

impl From<IdentityError> for DaemonError {
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''    clients: LocalClientRegistry,
    identity: ProfileIdentityVault,
    vault: ProviderVault,
''',
    '''    clients: LocalClientRegistry,
    capabilities: CapabilityAuthority,
    identity: ProfileIdentityVault,
    vault: ProviderVault,
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''        let clients =
            LocalClientRegistry::open(paths.home.join("state").join("local-clients.json"))?;
        let identity = ProfileIdentityVault::open_system(
''',
    '''        let clients =
            LocalClientRegistry::open(paths.home.join("state").join("local-clients.json"))?;
        let capabilities = CapabilityAuthority::open(
            paths.home.join("state").join("capabilities.json"),
        )?;
        let identity = ProfileIdentityVault::open_system(
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''            state,
            clients,
            identity,
            vault,
''',
    '''            state,
            clients,
            capabilities,
            identity,
            vault,
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''        if request.operation == "authority.clients.list"
            && actor
                .as_ref()
                .is_some_and(|actor| !role_may_list_clients(actor.role))
        {
            return Ok(LocalResponse::error(
                request.request_id,
                "authority-denied",
                "This local client role cannot inspect Greenways authority state.",
            ));
        }
''',
    '''        if request.operation == "authority.clients.list"
            && actor
                .as_ref()
                .is_some_and(|actor| !role_may_list_clients(actor.role))
        {
            return Ok(LocalResponse::error(
                request.request_id,
                "authority-denied",
                "This local client role cannot inspect Greenways authority state.",
            ));
        }
        if matches!(
            request.operation.as_str(),
            "capabilities.status" | "capabilities.list"
        ) && actor
            .as_ref()
            .is_some_and(|actor| !role_may_inspect_capabilities(actor.role))
        {
            return Ok(LocalResponse::error(
                request.request_id,
                "authority-denied",
                "This local client role cannot inspect Greenways capability authority.",
            ));
        }
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''            "identity.public-card" => match self.identity.public_identity() {
                Some(identity) => LocalResponse::ok(
                    request.request_id.clone(),
                    serde_json::to_value(identity).map_err(|_| {
                        DaemonError::State("public identity card could not be encoded".to_owned())
                    })?,
                ),
                None => LocalResponse::error(
                    request.request_id.clone(),
                    "identity-unconfigured",
                    "Create a Greenways profile identity before requesting its public card.",
                ),
            },
''',
    '''            "identity.public-card" => match self.identity.public_identity() {
                Some(identity) => LocalResponse::ok(
                    request.request_id.clone(),
                    serde_json::to_value(identity).map_err(|_| {
                        DaemonError::State("public identity card could not be encoded".to_owned())
                    })?,
                ),
                None => LocalResponse::error(
                    request.request_id.clone(),
                    "identity-unconfigured",
                    "Create a Greenways profile identity before requesting its public card.",
                ),
            },
            "capabilities.status" => LocalResponse::ok(
                request.request_id.clone(),
                serde_json::to_value(self.capabilities.status(observed_at_unix_ms)?).map_err(
                    |_| {
                        DaemonError::State(
                            "capability authority status could not be encoded".to_owned(),
                        )
                    },
                )?,
            ),
            "capabilities.list" => LocalResponse::ok(
                request.request_id.clone(),
                serde_json::to_value(self.capabilities.list(observed_at_unix_ms)?).map_err(
                    |_| {
                        DaemonError::State(
                            "capability authority list could not be encoded".to_owned(),
                        )
                    },
                )?,
            ),
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''            | "identity.status"
            | "identity.public-card"
''',
    '''            | "identity.status"
            | "identity.public-card"
            | "capabilities.status"
            | "capabilities.list"
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''fn role_may_list_clients(role: LocalClientRole) -> bool {
    matches!(
        role,
        LocalClientRole::Desktop | LocalClientRole::Cli | LocalClientRole::Developer
    )
}
''',
    '''fn role_may_list_clients(role: LocalClientRole) -> bool {
    matches!(
        role,
        LocalClientRole::Desktop | LocalClientRole::Cli | LocalClientRole::Developer
    )
}

fn role_may_inspect_capabilities(role: LocalClientRole) -> bool {
    matches!(
        role,
        LocalClientRole::Desktop | LocalClientRole::Cli | LocalClientRole::Developer
    )
}
''',
)
replace(
    "services/greenwaysd/src/lib.rs",
    '''    #[test]
    fn connection_sessions_expire_and_exhaust_without_bearer_tokens() {
''',
    '''    #[test]
    fn capability_authority_reads_are_authenticated_and_role_scoped() {
        let home = TestHome::new("capability-auth");
        let mut daemon = Daemon::open_at(home.paths(), 1_000).expect("daemon should open");
        let public = daemon
            .handle_request_at(
                LocalRequest::capabilities_status("local/request/capauth001"),
                2_000,
            )
            .expect("public capability status should return a response");
        assert_eq!(public.outcome, Outcome::Error);
        assert_eq!(
            public.error.expect("authentication error").code,
            "authentication-required"
        );

        let browser = RequestActor {
            client_id: "local/client/00112233445566778899aabbccddeeff".to_owned(),
            role: LocalClientRole::BrowserBridge,
        };
        let denied = daemon
            .handle_request_as_at(
                LocalRequest::capabilities_list("local/request/capauth002"),
                Some(browser),
                3_000,
            )
            .expect("browser denial should return a response");
        assert_eq!(denied.outcome, Outcome::Error);
        assert_eq!(denied.error.expect("authority error").code, "authority-denied");

        let cli = RequestActor {
            client_id: "local/client/ffeeddccbbaa99887766554433221100".to_owned(),
            role: LocalClientRole::Cli,
        };
        let allowed = daemon
            .handle_request_as_at(
                LocalRequest::capabilities_status("local/request/capauth003"),
                Some(cli),
                4_000,
            )
            .expect("CLI capability status should complete");
        assert_eq!(allowed.outcome, Outcome::Ok);
        let status: greenways_capabilities::CapabilityAuthorityStatus = serde_json::from_value(
            allowed.value.expect("capability status value"),
        )
        .expect("capability status projection");
        assert_eq!(status.grant_count, 0);
        assert!(!status.arbitrary_signing);
    }

    #[test]
    fn connection_sessions_expire_and_exhaust_without_bearer_tokens() {
''',
)

replace(
    "cli/greenways/src/main.rs",
    'use greenways_identity::{ProfileIdentityStatus, SignedProfileIdentity};\n',
    'use greenways_capabilities::{CapabilityAuthorityStatus, CapabilityGrantView};\nuse greenways_identity::{ProfileIdentityStatus, SignedProfileIdentity};\n',
)
replace(
    "cli/greenways/src/main.rs",
    '''    IdentityStatus,
    IdentityCard,
''',
    '''    IdentityStatus,
    IdentityCard,
    CapabilitiesStatus,
    Capabilities,
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''            Self::Whoami | Self::Clients | Self::IdentityStatus | Self::IdentityCard
''',
    '''            Self::Whoami
                | Self::Clients
                | Self::IdentityStatus
                | Self::IdentityCard
                | Self::CapabilitiesStatus
                | Self::Capabilities
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''            Command::IdentityStatus => client.identity_status(),
            Command::IdentityCard => client.identity_public_card(),
''',
    '''            Command::IdentityStatus => client.identity_status(),
            Command::IdentityCard => client.identity_public_card(),
            Command::CapabilitiesStatus => client.capabilities_status(),
            Command::Capabilities => client.capabilities(),
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''        Command::IdentityStatus => print_identity_status(response)?,
        Command::IdentityCard => print_identity_card(response)?,
''',
    '''        Command::IdentityStatus => print_identity_status(response)?,
        Command::IdentityCard => print_identity_card(response)?,
        Command::CapabilitiesStatus => print_capabilities_status(response)?,
        Command::Capabilities => print_capabilities(response)?,
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''fn print_client(prefix: &str, client: AuthorityClient) {
''',
    '''fn print_capabilities_status(response: LocalResponse) -> Result<(), String> {
    let status: CapabilityAuthorityStatus = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "capability status response had no value".to_owned())?,
    )
    .map_err(|_| "capability status response was invalid".to_owned())?;
    println!("Greenways capability authority");
    println!("  state:    {}", status.state);
    println!("  revision: {}", status.revision);
    println!("  grants:   {}", status.grant_count);
    println!("  active:   {}", status.active_grant_count);
    println!("  revoked:  {}", status.revoked_grant_count);
    println!("  expired:  {}", status.expired_grant_count);
    println!("  arbitrary signing: {}", status.arbitrary_signing);
    Ok(())
}

fn print_capabilities(response: LocalResponse) -> Result<(), String> {
    let grants: Vec<CapabilityGrantView> = serde_json::from_value(
        response
            .value
            .ok_or_else(|| "capability list response had no value".to_owned())?,
    )
    .map_err(|_| "capability list response was invalid".to_owned())?;
    println!("Greenways application capability grants");
    if grants.is_empty() {
        println!("  none");
        return Ok(());
    }
    for view in grants {
        let state = if view.active {
            "active"
        } else if view.revocation.is_some() {
            "revoked"
        } else {
            "expired"
        };
        println!(
            "  {}  {}  {}@{}  ({state})",
            view.grant.grant.id,
            view.grant.grant.capability,
            view.grant.grant.subject.app_id,
            view.grant.grant.subject.version
        );
    }
    Ok(())
}

fn print_client(prefix: &str, client: AuthorityClient) {
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''        Some("identity-status") => Command::IdentityStatus,
        Some("identity-card") => Command::IdentityCard,
''',
    '''        Some("identity-status") => Command::IdentityStatus,
        Some("identity-card") => Command::IdentityCard,
        Some("capabilities-status") => Command::CapabilitiesStatus,
        Some("capabilities") => Command::Capabilities,
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''            "--credential is required for whoami, clients, and identity commands".to_owned(),
''',
    '''            "--credential is required for whoami, clients, identity, and capability commands"
                .to_owned(),
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''         greenways identity-card --credential PATH [--home PATH] [--json]\\n\\
''',
    '''         greenways identity-card --credential PATH [--home PATH] [--json]\\n\\
         greenways capabilities-status --credential PATH [--home PATH] [--json]\\n\\
         greenways capabilities --credential PATH [--home PATH] [--json]\\n\\
''',
)
replace(
    "cli/greenways/src/main.rs",
    '''        assert!(parse(&["identity-card"]).is_err());
''',
    '''        assert!(parse(&["identity-card"]).is_err());
        assert!(parse(&["capabilities-status"]).is_err());
        assert!(parse(&["capabilities"]).is_err());
''',
)

readme = ROOT / "services/greenwaysd/README.md"
readme.write_text(
    readme.read_text()
    + '''

## Capability authority reads

`greenwaysd` now validates and owns the signed capability authority state at startup. Enrolled Desktop, CLI, and Developer sessions may read `capabilities.status` and `capabilities.list`. The browser-bridge role is deliberately denied authority inventory; a later exact `capabilities.check` seam will answer only whether one reviewed application operation is currently granted.

These operations are read-only. Grant issuance and revocation remain offline administration in the next slice, and the extension remains the compatibility authority until its exact approvals are migrated with receipts.
'''
)
protocol = ROOT / "protocol/capability-grants.md"
protocol.write_text(
    protocol.read_text()
    + '''

## Daemon read integration

`greenwaysd` opens and validates the private capability authority file during startup. The first authenticated local operations are:

```text
capabilities.status
capabilities.list
```

Desktop, CLI, and explicit Developer roles may inspect these projections. The browser bridge cannot list or count authority records. Both operations are ordinary actor-bound daemon requests and therefore retain exact request replay and collision semantics.
'''
)

print("Applied capability authority daemon read integration")

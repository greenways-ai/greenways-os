# Greenways provider credential vault

Status: first identity and credential-custody slice for issue #51.

## Boundary

`greenwaysd` owns provider-profile metadata. The provider credential itself is stored in the operating-system credential store through an opaque profile identifier. The daemon state, provider registry, ordinary local IPC, Flutter clients, browser extension, logs and request receipts never contain the credential bytes.

```text
greenways-admin -- secret on stdin
        │
        ▼
operating-system credential store
        ▲
        │ opaque provider profile id
        │
greenwaysd provider registry
        │
        └── redacted vault.status
```

The first supported provider vocabulary is closed:

```text
anthropic
openai
openrouter
```

No caller-selected endpoint, authentication header, key name or secret-store service is accepted.

## Administration

Provider mutation is offline and CLI-first during this migration slice:

```sh
printf '%s' "$OPENAI_API_KEY" | \
  greenways-admin provider add \
    --id openai.personal \
    --provider openai \
    --label "Personal OpenAI"

greenways-admin provider list

printf '%s' "$OPENAI_API_KEY" | \
  greenways-admin provider rotate --id openai.personal

greenways-admin provider remove --id openai.personal
```

The credential is read only from stdin. It is not accepted as a command-line argument or printed. Mutations require `greenwaysd` to be stopped, preventing the administrator and daemon from becoming concurrent metadata authorities.

## Public status

The ordinary local protocol adds one read-only operation:

```text
vault.status
```

It returns only:

```json
{
  "protocol": "greenways-vault-status/0-alpha",
  "metadataState": "ready",
  "credentialStore": "system-keyring",
  "providerProfileCount": 1,
  "secretProjection": false
}
```

Profile IDs, labels and provider credentials are not included in this public daemon projection. Redacted profile inventory remains an offline administrator view until authenticated local client roles are implemented.

## Transaction semantics

- Metadata is written to a private file by fsync, atomic rename and parent-directory sync.
- Adding a profile removes the credential if metadata commit fails.
- Rotating a profile restores the earlier credential if metadata commit fails.
- Removing a profile restores the deleted credential if metadata commit fails.
- Registry records are closed, bounded, versioned and duplicate-free.
- In-memory secret buffers are zeroised on drop.

## Exclusions

This slice deliberately does not expose:

```text
credential.read
credential.export
key.export-private
arbitrary signing
caller-selected provider endpoints
provider.invoke
```

Typed model invocation will be implemented inside the daemon vault/broker boundary so a future client receives a model result, not a credential.

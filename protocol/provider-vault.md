# Greenways provider credential vault

Status: daemon-owned credential custody with authenticated, role-scoped status for issue #51.

## Boundary

`greenwaysd` owns provider-profile metadata. Provider credentials remain in the operating-system credential store behind opaque profile identifiers. Daemon state, ordinary local IPC, Flutter clients, the browser extension, logs, durable receipts, and provider results never contain credential bytes.

```text
greenways-admin -- secret on stdin
        │
        ▼
operating-system credential store
        ▲
        │ opaque provider profile ID
        │
greenwaysd provider registry
        │ authenticated local session
        ├── role-scoped redacted vault.status
        └── typed provider.invoke
```

The first provider vocabulary is closed:

```text
anthropic
openai
openrouter
```

Provider adapters use fixed endpoints and authentication shapes. Callers cannot select an endpoint, authentication header, secret-store service, credential handle, or arbitrary HTTP request.

## Administration

Provider mutation remains offline and CLI-first:

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

## Authenticated status

The local protocol exposes one read-only vault operation:

```text
vault.status
```

It requires a daemon-verified, connection-bound local-client session. The fixed role policy is:

| Role | Read `vault.status` |
| --- | ---: |
| Desktop | Yes |
| CLI | Yes |
| Browser bridge | No |
| Developer | Yes |

The browser bridge may read the public Greenways identity needed for reviewed pairing, but it cannot inspect provider-custody metadata. A local-client role identifies the installed caller; it is not Greenway membership, room membership, source authority, application authority, or a provider grant.

The response contains only:

```json
{
  "protocol": "greenways-vault-status/0-alpha",
  "metadataState": "ready",
  "credentialStore": "system-keyring",
  "providerProfileCount": 1,
  "secretProjection": false
}
```

Profile IDs, labels, opaque credential handles, and provider credentials are never included. Redacted profile inventory remains an offline administrator view.

## Typed invocation

`provider.invoke` consumes one closed, bounded provider invocation inside `greenwaysd` and returns one normalized bounded result. Desktop, CLI, and explicit Developer roles may use this migration path. The browser bridge remains denied until one exact reviewed application grant can be checked for one exact invocation.

Definitive provider results and provider errors are durably replayable for the same authenticated actor. A prepared request with an uncertain external outcome is fenced rather than retried automatically, preventing accidental duplicate billable calls.

## Transaction semantics

- Metadata is written to a private file by fsync, atomic rename, and parent-directory sync.
- Adding a profile removes the credential if metadata commit fails.
- Rotating a profile restores the earlier credential if metadata commit fails.
- Removing a profile restores the deleted credential if metadata commit fails.
- Registry records are closed, bounded, versioned, and duplicate-free.
- In-memory secret buffers are zeroised on drop.

## Exclusions

The daemon does not expose:

```text
credential.read
credential.export
key.export-private
arbitrary signing
caller-selected provider endpoints
arbitrary HTTP
raw provider response bodies
browser cookies or session tokens
```

Clients receive semantic provider results and receipts, never the provider credential or browser authority that produced them.

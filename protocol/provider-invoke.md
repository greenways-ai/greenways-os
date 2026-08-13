# Daemon provider invocation

Status: exact application-authority enforcement for issues #51 and #78.

## Boundary

`greenwaysd` is the only process that resolves a provider profile into credential bytes. A local process role authenticates the installed caller, but it does not by itself authorize an application to spend a provider credential.

Every new provider effect therefore follows this closed order:

```text
enrolled Desktop / CLI / explicit Developer client
        │ authenticated connection-bound session
        ▼
greenways-authorised-provider-invocation/0-alpha
        │
        ├── exact greenways-capability-check/0-alpha
        │     ├── application ID
        │     ├── semantic version
        │     ├── publisher
        │     ├── approval digest
        │     ├── optional lock digest
        │     └── capability = model/generate
        │
        └── greenways-provider-invocation/0-alpha
              ├── provider profile ID
              ├── model ID
              ├── bounded messages
              ├── output limit
              └── timeout
        │
        ▼
active exact signed application approval
        │ declared model/generate
        ▼
active exact signed capability grant
        │ typed provider policy permits profile, model and limits
        ▼
durable actor-bound provider claim
        │
        ▼
OS credential store ── credential bytes ──> fixed provider adapter
        │                                      │
        └──────────── never projected ─────────┘
                                               ▼
                                  normalized provider result
```

The browser-bridge role remains denied. A later browser slice must additionally bind the exact Native Messaging installation and reviewed page/source authority; a valid application grant alone is not enough to enable browser-driven provider execution.

## Authorized request

The authenticated operation remains:

```text
provider.invoke
```

New effects require one closed wrapper:

```json
{
  "protocol": "greenways-authorised-provider-invocation/0-alpha",
  "check": {
    "protocol": "greenways-capability-check/0-alpha",
    "subject": {
      "kind": "app",
      "appId": "hara-playground",
      "version": "1.2.3",
      "publisherId": "hara-lang",
      "lockDigest": null,
      "approvalDigest": "sha256:..."
    },
    "capability": "model/generate"
  },
  "invocation": {
    "protocol": "greenways-provider-invocation/0-alpha",
    "profileId": "openai.personal",
    "model": "gpt-5",
    "messages": [
      {"role": "user", "content": "Hello"}
    ],
    "maxOutputTokens": 2048,
    "timeoutMs": 60000
  }
}
```

Unknown wrapper, capability, application, provider, or nested fields fail closed. There is no request-selected endpoint, header, credential, routing policy, tool, file, stream, debug echo, proxy, or transport option.

The daemon still decodes the legacy raw provider-invocation shape only so pre-existing completed receipts and uncertain claims remain replayable after upgrade. A new legacy-shaped request receives `provider-authority-required` before durable claim ownership or vault access.

## Typed `model/generate` grant policy

A newly issued `model/generate` grant must contain exactly these signed non-secret constraints:

```text
provider.profile-id
provider.model
provider.max-output-tokens
provider.max-timeout-ms
```

The profile and model must match exactly. Requested output tokens and timeout must not exceed the signed maxima. Unknown or incorrectly typed provider constraints fail closed, and `provider.*` constraints are rejected for every capability other than `model/generate`.

Older unconstrained `model/generate` grants remain readable and independently verifiable for migration, but they cannot authorize provider execution.

Example administration:

```sh
greenways-admin capability issue \
  --capability model/generate \
  --app-id hara-playground \
  --app-version 1.2.3 \
  --publisher hara-lang \
  --approval-digest sha256:... \
  --provider-profile openai.personal \
  --provider-model gpt-5 \
  --provider-max-output-tokens 2048 \
  --provider-max-timeout-ms 60000
```

## Denial order and non-disclosure

For a new request, application approval and grant-policy checks finish before:

```text
provider claim persistence
provider profile existence lookup
operating-system credential-store access
provider network access
```

An application or policy denial returns the same bounded `provider-authority-denied` error. It does not disclose whether the selected provider profile or credential exists and does not consume a provider claim ID. Browser-role denial occurs even earlier.

Only after authority succeeds may the daemon return a provider-profile or provider-service error.

## Fixed adapters

The approved provider profile selects one compiled adapter:

```text
openai      -> https://api.openai.com/v1/responses
anthropic   -> https://api.anthropic.com/v1/messages
openrouter  -> https://openrouter.ai/api/v1/chat/completions
```

OpenAI requests set `store: false`. Anthropic system messages are projected into the API's top-level system field. OpenRouter requests are non-streaming. Every adapter enforces a bounded response body and extracts text plus bounded token usage into `greenways-provider-result/0-alpha`.

## At-most-once recovery and attributable evidence

Before network or credential access, the daemon commits a bounded actor-bound provider claim containing:

```text
request ID
exact canonical request digest
authenticated client ID and fixed role
application approval digest
capability = model/generate
grant ID
grant signed-subject root
exact provider profile ID
exact model ID
actual output-token limit
actual timeout
exact authorization time
request-bound authority evidence digest
prepared time (equal to authorization time)
```

The claim contains no prompt text, provider credential, credential-store handle, session credential, private key, or arbitrary signing material.

A completed invocation replaces the claim with `greenways-authorised-provider-invocation-receipt/0-alpha`. The receipt preserves the exact approval, signed grant, provider-policy projection, and authorization time that allowed the call. Restart validation evaluates approval and grant activity at that recorded authorization time, so a legitimate completed receipt remains replayable after a later revocation or expiry while new calls are denied. Malformed evidence, unknown or redirected approvals and grants, policy/request mismatch, or evidence not bound to the exact request digest fails closed.

Recovery rules remain:

- An identical completed request from the same actor replays its stored result without another provider call.
- A reused request ID with changed bytes or another actor is rejected.
- A transport timeout, 5xx response, malformed success response, or failed completion commit leaves the claim uncertain.
- An identical uncertain request returns `provider-invocation-uncertain` and is never retried automatically.
- A provider 4xx rejection and a missing provider profile are definitive and are stored as replayable error responses.
- Legacy completed receipts and prepared uncertain claims retain their prior replay/fencing behavior after migration.

## Client use

The CLI reads prompt text from stdin so prompts are not required on the command line:

```sh
printf '%s' 'Explain immutable receipts in one paragraph.' | \
  greenways invoke \
    --credential ~/.greenways/clients/cli.json \
    --profile openai.personal \
    --model gpt-5 \
    --app-id hara-playground \
    --app-version 1.2.3 \
    --publisher hara-lang \
    --approval-digest sha256:...
```

The result contains provider, selected profile ID, requested model, normalized text, optional usage, and completion time. It contains no credential bytes, credential-store handle, provider headers, or raw provider response.

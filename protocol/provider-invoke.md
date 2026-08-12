# Daemon provider invocation

Status: authenticated provider-execution slice for issue #51.

## Boundary

`greenwaysd` is the only process that resolves a provider profile into credential bytes. Local clients submit one closed semantic request and receive one normalized text result.

```text
enrolled Desktop / CLI / developer client
        │ authenticated local session
        ▼
provider.invoke
        │ fixed profile + model + messages + limits
        ▼
greenwaysd durable invocation claim
        │
        ▼
OS credential store ── credential bytes ──> fixed provider adapter
        │                                      │
        └──────────── never projected ─────────┘
                                               ▼
                                  normalized provider result
```

The browser-bridge role is deliberately denied in this slice. Browser access is enabled only after daemon-owned application grants bind the exact app, origin, provider profile, model and output limits.

## Request

The authenticated operation is:

```text
provider.invoke
```

Its arguments use `greenways-provider-invocation/0-alpha` and contain only:

```json
{
  "protocol": "greenways-provider-invocation/0-alpha",
  "profileId": "openai.personal",
  "model": "gpt-5",
  "messages": [
    {"role": "user", "content": "Hello"}
  ],
  "maxOutputTokens": 2048,
  "timeoutMs": 60000
}
```

There is no request-selected endpoint, header, credential, routing policy, tool, file, stream, debug echo, proxy or transport option. Input is bounded by the local IPC limit and the provider protocol validator.

## Fixed adapters

The provider profile selects one compiled adapter:

```text
openai      -> https://api.openai.com/v1/responses
anthropic   -> https://api.anthropic.com/v1/messages
openrouter  -> https://openrouter.ai/api/v1/chat/completions
```

OpenAI requests set `store: false`. Anthropic system messages are projected into the API's top-level system field. OpenRouter requests are non-streaming. Every adapter enforces a bounded response body and extracts text plus bounded token usage into `greenways-provider-result/0-alpha`.

## At-most-once recovery

A provider request is an external effect and cannot use the ordinary post-effect receipt path safely. Before network access, the daemon commits an actor-bound invocation claim containing the exact request digest.

- A completed invocation replaces the claim with the ordinary durable response receipt.
- An identical completed request replays its stored result without another provider call.
- A reused request ID with changed bytes or another actor is rejected.
- A transport timeout, 5xx response, malformed success response or failed completion commit leaves the claim uncertain.
- An identical uncertain request returns `provider-invocation-uncertain` and is never retried automatically.
- A provider 4xx rejection is definitive and is stored as a replayable error response.

This fails closed against duplicate billing. A later administration slice will expose explicit inspection and resolution of uncertain claims.

## Client use

The CLI reads prompt text from stdin so prompts are not required on the command line:

```sh
printf '%s' 'Explain immutable receipts in one paragraph.' | \
  greenways invoke \
    --credential ~/.greenways/clients/cli.json \
    --profile openai.personal \
    --model gpt-5
```

The result contains provider, selected profile ID, requested model, normalized text, optional usage and completion time. It contains no credential bytes, credential-store handle, provider headers or raw provider response.

# Greenways OS AI capability

Status: first runnable Playground integration  
Protocols: `greenways-ai/0-alpha`, `greenways-playground-ai/0-alpha`

## Purpose

Allow `https://playground.hara-lang.org` to use provider credentials installed in Greenways Keyring without exposing those credentials to Playground, Hara source, browser storage owned by the site, logs, URLs, or model responses.

```text
Hara Playground page
        │ typed postMessage request
        ▼
exact-origin Greenways content bridge
        │ typed extension message
        ▼
Greenways OS capability authority
        │ active hara-playground / model/generate grant
        ▼
Greenways AI service
        │ opaque provider-profile use
        ▼
Greenways Keyring ── fixed provider adapter ── provider API
```

## Website boundary

The extension installs one static content script only at:

```text
https://playground.hara-lang.org/*
```

The bridge accepts top-frame messages only when all of the following match:

- page origin: `https://playground.hara-lang.org`;
- protocol: `greenways-playground-ai/0-alpha`;
- page source: `hara-playground`;
- direction: `request`;
- operation: `status`, `open`, `generate`, or `cancel`.

The service worker independently verifies the content-script sender, top frame, non-incognito tab, and exact page origin. A lookalike `.io` origin, subdomain, iframe, another extension, or arbitrary website is rejected.

## Consent flow

`open` opens the packaged Greenways OS Playground access surface. That surface can:

1. install or update the exact bundled `hara-playground` manifest;
2. create or revoke an active `model/generate` grant;
3. request the exact provider network origin from Chrome;
4. add or remove a session-only provider profile.

The default grant is constrained to:

```json
{
  "origins": ["https://playground.hara-lang.org"],
  "maxInputBytes": 262144,
  "maxOutputTokens": 4096,
  "timeoutMs": 900000
}
```

Provider secrets remain in `chrome.storage.session`. The website receives only public profile metadata.

## Model request

`generate` accepts only:

```json
{
  "profileId": "openai.personal.ab12cd34",
  "model": "gpt-5",
  "messages": [
    {"role": "system", "content": "You help with Hara."},
    {"role": "user", "content": "Explain this form."}
  ],
  "maxOutputTokens": 2048,
  "timeoutMs": 60000
}
```

The Greenways service adds the request identifier supplied by the bridge. It rejects unknown fields, URL-shaped model IDs, unsupported roles, oversized context, duplicate in-flight request IDs, absent provider permission, stale app approval, and missing or out-of-scope grants.

## Provider adapters

The first implementation uses fixed endpoints only:

- OpenRouter: `https://openrouter.ai/api/v1/chat/completions`;
- OpenAI: `https://api.openai.com/v1/responses`;
- Anthropic: `https://api.anthropic.com/v1/messages`.

The caller cannot choose an endpoint, HTTP method, authorization header, or arbitrary provider payload.

## Forbidden operations

```text
key/get
key/export-private
credential/get
credential/list-raw
http/arbitrary-request
provider/arbitrary-payload
chrome/call
eval
```

## Current limits

This first slice is non-streaming. Cancellation and timeouts are supported while the extension service worker remains alive. Durable cost budgets, streaming, signed AI receipts, and Hara-program-level `gw.ai` calls remain subsequent slices.

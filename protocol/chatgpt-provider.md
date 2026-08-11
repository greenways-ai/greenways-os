# Greenways for ChatGPT

Status: first foreground provider slice  
Protocols: `greenways-chatgpt-provider/0-alpha`, `greenways-model-session/0-alpha`

## Purpose

Use the visible ChatGPT web application as a user-mediated Greenways OS model provider without embedding another Hara kernel in the page and without extracting ChatGPT credentials.

```text
Greenways application
        │ foreground model request
        ▼
resident Hara kernel and capability authority
        │ durable model session
        ▼
reviewed ChatGPT provider host
        │ typed extension message
        ▼
ChatGPT page adapter
        │ user places prompt and presses Send
        ▼
visible ChatGPT response
        │ user selects “Use this response in Greenways”
        ▼
validated result and digest
```

The Hara kernel remains in the extension service worker. The ChatGPT page receives only a small reviewed JavaScript adapter and a request-specific control card.

## Provider identity

```text
app id       chatgpt-provider
provider id  webapp.chatgpt
mode         foreground
capability   model/provide
```

`model/provide` is distinct from `chats/capture` and `model/generate`:

- `chats/capture` authorizes an optional personal conversation archive;
- `model/generate` authorizes a caller to request model work;
- `model/provide` authorizes the reviewed Greenways app to project one request into ChatGPT and return one explicitly selected response.

Installing one capability does not imply either of the others.

## User-mediated boundary

The adapter may:

- show the exact requesting Greenways app and prompt;
- place the prompt into the visible ChatGPT composer after a user click;
- observe visible assistant turns after that placement;
- show a bounded response preview;
- return the exact reviewed response after a second user click.

The adapter must not:

- press ChatGPT’s Send button;
- submit unattended or background requests;
- read cookies, access tokens, authorization headers, billing information, or private network responses;
- export unrelated conversation history;
- claim a model identity that is not reliably visible;
- expose the Greenways kernel, Keyring, grants, or arbitrary host calls to the page.

## Session record

A foreground request is durable Greenways state:

```json
{
  "protocol": "greenways-model-session/0-alpha",
  "id": "model/session/…",
  "provider": "webapp.chatgpt",
  "mode": "foreground",
  "state": "staged",
  "request": {
    "title": "Hara help",
    "callerAppId": "hara-playground",
    "prompt": "Explain this form."
  },
  "tabId": 17,
  "documentId": "…",
  "origin": "https://chatgpt.com",
  "conversationId": null,
  "assistantMessageId": null,
  "output": null,
  "outputDigest": null,
  "createdAt": "…",
  "updatedAt": "…",
  "returnedAt": null
}
```

The state machine is:

```text
created → attached → staged → ready → returned
    └───────────────→ cancelled
```

A response becomes a Greenways result only in `returned`. `ready` means the page has found a candidate response, not that Greenways has accepted it.

## Page authority

Every page event is checked against:

- this extension’s runtime ID;
- top frame only;
- a normal non-incognito tab;
- an approved ChatGPT origin;
- the exact tab-bound session;
- an installed current `chatgpt-provider` approval;
- an active `model/provide` grant.

The returned text must byte-for-byte match the response candidate that was previously recorded as ready. Greenways stores a SHA-256 output digest with the returned result.

## Current limits

The first slice accepts text prompts and text responses, one foreground session per ChatGPT tab. It does not automate submission, stream response tokens into callers, identify an exact ChatGPT model, upload files, invoke tools, or run unattended agent work.

API-backed providers remain the execution path for unattended workflows. A subsequent broker slice can let Hara Playground and other installed apps create these durable sessions through the common `model/generate` boundary.

## Common model broker

The provider is also projected into the common Greenways AI profile list as
`webapp.chatgpt`. A caller with an exact `model/generate` grant submits the
same closed model request used for API-backed profiles. The broker creates a
durable foreground session and returns its handle immediately; it does not keep
a service-worker promise alive while a person interacts with ChatGPT.

The caller polls the closed `result` operation by its original request ID.
Every read and cancellation revalidates both independent authorities:

- the caller application's current `model/generate` grant; and
- the reviewed provider application's current `model/provide` grant.

The session stores the caller app, exact origin, exact grant ID, request ID,
requested model label and expiry. Reusing a request ID with different content is
rejected. Returned output remains byte-for-byte bound to the reviewed candidate
and includes its SHA-256 digest and visible ChatGPT source identity. API-backed
profiles retain their existing direct response path.

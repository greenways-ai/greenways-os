# Greenways model generation protocol

Status: direct Tripo connector foundation  
Request protocol: `greenways-model-generation-request/1`  
Task protocol: `greenways-model-generation-task/1`

## Purpose

Greenways OS needs a stable model-generation boundary that does not depend on a provider's website, browser session, or MCP implementation. Packages request one typed operation; the Connector Broker uses an opaque Keyring profile; the provider credential is never returned to the package.

```text
Greenways package or Model Forge
        │ model/generate grant + closed request
        ▼
Connector Broker
        │ exact provider adapter
        ▼
Greenways Keyring
        │ session credential, never projected
        ▼
Tripo OpenAPI
        │ provider task id and bounded status
        ▼
Greenways task projection / later receipt
```

The first native adapter calls the Tripo OpenAPI directly. It does not automate Tripo Studio, reuse Studio cookies, expose a general HTTP proxy, or require the Tripo MCP server.

## Credential prerequisite

The user creates a Tripo API project and loads its API key into Greenways Keyring as a `tripo` provider profile. Tripo API keys begin with `tsk_`.

Studio and OpenAPI billing are independent. A Studio subscription or Studio credits do not imply that the API project has credits. Greenways stores the API credential only in `chrome.storage.session`; browser restart, extension reload, disable, update, or an explicit clear removes it.

## Request envelope

```json
{
  "protocol": "greenways-model-generation-request/1",
  "id": "request/hestia-001",
  "provider": "tripo",
  "profileId": "tripo.personal.ab12cd34",
  "operation": "image-to-model",
  "modelVersion": "v3.1-20260211",
  "image": {
    "url": "https://assets.greenways.ai/hestia-front.png",
    "type": "png"
  },
  "options": {
    "modelSeed": 42,
    "texture": false,
    "pbr": false,
    "geometryQuality": "standard",
    "faceLimit": 250000,
    "enableImageAutofix": false,
    "exportUv": false
  }
}
```

The accepted operations are:

- `text-to-model` — one prompt and optional negative prompt;
- `image-to-model` — one direct HTTPS PNG/JPEG URL;
- `multiview-to-model` — named `front`, `left`, `back`, and `right` inputs.

Multiview requests are converted to Tripo's fixed `[front, left, back, right]` order. The front image is required and at least two images must be supplied. Naming views in the Greenways request prevents an application from silently swapping camera directions.

## Bounded options

The connector exposes only a conservative subset of H3 controls:

| Greenways field | Provider field | Boundary |
| --- | --- | --- |
| `modelVersion` | `model_version` | `v3.1-20260211` or `v3.0-20250812` |
| `modelSeed` | `model_seed` | non-negative signed 32-bit integer |
| `texture` | `texture` | boolean; defaults to `false` |
| `pbr` | `pbr` | boolean; defaults to `false`; implies texture when enabled |
| `geometryQuality` | `geometry_quality` | `standard` or `detailed` |
| `faceLimit` | `face_limit` | 1,000–250,000; defaults to 250,000 |
| `enableImageAutofix` | `enable_image_autofix` | image inputs only; defaults to `false` |
| `exportUv` | `export_uv` | boolean; defaults to `false` |

The adapter pins `smart_low_poly`, `quad`, `generate_parts`, and `auto_size` off in this first slice. Unknown fields, credential-shaped fields, arbitrary provider payloads, HTTP input URLs, URL credentials, and URL fragments fail closed.

The geometry-first defaults are intentional for the Greenways logo workflow. Canonical colour and smalti material should be reconstructed from the visual-language source and shaders rather than accepted as an unreviewed generated texture.

## Provider transport

The Tripo adapter may call only:

```text
POST https://api.tripo3d.ai/v2/openapi/task
GET  https://api.tripo3d.ai/v2/openapi/task/{task_id}
```

It supplies `Authorization: Bearer <session credential>` internally. The caller cannot choose the URL, HTTP method, authorization header, or raw request body. Requests omit browser credentials, reject redirects, omit referrers, bypass caches, and use a bounded timeout.

A task must be polled with the same Keyring profile that created it. This reflects the provider requirement that the same API key query the task.

## Task projection

```json
{
  "protocol": "greenways-model-generation-task/1",
  "provider": "tripo",
  "profileId": "tripo.personal.ab12cd34",
  "requestId": "request/hestia-001",
  "providerTaskId": "07764597-9c93-4eb9-92b6-4ea96a8c7d1a",
  "operation": "image-to-model",
  "status": "running",
  "terminal": false,
  "progress": 63,
  "consumedCredits": 0,
  "queuePosition": -1,
  "secondsRemaining": 9,
  "createdAt": "2026-08-07T01:00:00.000Z",
  "output": {
    "modelUrl": null,
    "baseModelUrl": null,
    "pbrModelUrl": null,
    "renderedImageUrl": null
  }
}
```

Known statuses are `queued`, `running`, `success`, `failed`, `banned`, `expired`, `cancelled`, and `unknown`. Provider `input`, undocumented outputs, debug envelopes, and credentials are not projected.

Provider download URLs are short-lived. A later Work/Receipt slice must download selected outputs immediately, verify their media type and size, hash the bytes, place them in Greenways-managed storage, and record the durable object reference. A signed provider URL is not a durable asset identity.

## Failure and concurrency policy

Provider errors are reduced to a bounded error with provider code, safe message, suggestion, and HTTP status. Raw error envelopes are not exposed. Error code `2000` should enter a local queue rather than trigger unconstrained retries; the default provider concurrency limit is currently ten tasks.

This PR establishes the typed native boundary and unit tests. It deliberately does not yet add:

- a public website bridge;
- durable Work scheduling and restart recovery;
- cost budgets and user approval UI;
- output download/hash pinning;
- Hestia or Tahto persistence;
- the Model Forge generation surface.

Those layers can now depend on a closed connector instead of the Studio UI or MCP runtime.

# Browser kernel boundary

The Chrome host exposes `greenways-kernel/0-alpha` between packaged extension pages
and the Manifest V3 background service worker. The worker is the only Hara
authority for application lifecycle and world/session transitions. A page is a
client and effect surface, not an independent source of kernel truth.

## State ownership

| Scope | Records | Rule |
| --- | --- | --- |
| Browser profile | Exact installed manifests, global revision, bounded committed-request receipts | Shared by every non-incognito Greenways page. |
| Document context | Active app, active surface and payload, Studio track metadata, context revision | Keyed by Chrome's document-lifetime ID and never copied into another page. |
| Page memory | File and audio host objects, rendered scene objects, temporary UI handles | Never serialized into the browser-wide profile state. |

Chrome may terminate an idle extension worker. Durable means that every
committed transition can be rehydrated, not that one JavaScript process remains
resident. The worker registers its message listener synchronously and loads the
bundled Hara Wasm behind the first request.

## Trust model

Chrome treats the service worker and every packaged extension document as one
extension principal. The host derives request authority from Chrome's sender
metadata, and clients accept effect and update broadcasts only from this
extension's non-document background context. Context IDs then prevent trusted
pages from accidentally consuming one another's state or effects.

This coordination boundary is not a sandbox for a compromised packaged page:
Chrome's one-shot runtime response channel is shared by the extension
principal. Greenways therefore permits no downloaded executable UI in that
principal. Every extension page and effect handler must remain bundled,
reviewed, and covered by the extension CSP.

## Calls and transitions

`attach` returns a composed snapshot with global and context revisions. `call`
runs an allowlisted read operation. `dispatch` carries a unique request ID,
method, and arguments. The host derives the caller role from Chrome's exact
active packaged document. It also derives the context key from Chrome's active
`documentId`; it does not trust a message-supplied app ID, role, or context.

Dispatches are serialized. For each dispatch the host:

1. rehydrates the latest global and initiating-context records;
2. runs the allowlisted Hara transition and validates its complete effect plan;
3. prepares a durable request receipt before any external effect;
4. sends page effects only to the initiating context; and
5. atomically commits global state, the context checkpoint, the exact app
   projection, and the committed receipt.

An identical committed request ID still present in the bounded receipt history
returns the current composed snapshot without repeating an effect. Reusing that
ID with different content is invalid. If a worker stops after a non-replayable
browser effect such as opening a tab or downloading an export, but before
commit, the prepared receipt is retained and the request fails closed as
outcome-unknown rather than blindly repeating the effect.

Only HAL bundled with the installed extension may execute. Manifests and remote
archives remain data even when digest-locked. All executable browser UI and
effect handlers are extension-owned and covered by the local package review.

# Browser authority to `greenwaysd` migration inventory

This inventory implements the architecture decision in
[issue #49](https://github.com/greenways-ai/greenways-os/issues/49). It maps the
current extension-first implementation to its daemon-first destination before
authority is moved.

| Current responsibility | Current location | Destination | Migration rule |
| --- | --- | --- | --- |
| Hara kernel host | `extension/src/kernel-host.js`, `src/gw/os/*` | `greenwaysd` Hara host | Preserve exact transition/effect validation; no two writable kernels |
| Durable profile records | `extension/src/storage.js` | daemon operational store | Import through a receipted migration, never opportunistic fallback |
| Capability grants | `extension/src/capability-authority.js` | daemon capability service | Preserve exact app/package identity and revocation |
| Keyring and provider credentials | `extension/src/keyring.js` | daemon vault | Move only through typed operations; never export raw secrets to Flutter or extension |
| Package lifecycle | `extension/src/package-manager.js`, `hara-packages.js` | daemon package service | Keep remote archives inert until verified and approved |
| Application runtime | `extension/src/hal-module-runtime.js` | daemon application service | Preserve namespace isolation and exact package locks |
| Work and receipts | `extension/src/workflow.js`, storage records | daemon work/receipt service | Preserve request IDs, checkpoint/replay, and attributable receipts |
| AI provider broker | `extension/src/ai-service.js` | daemon model service | Extension retains only page-mediated provider effects |
| ChatGPT provider sessions | `extension/src/chatgpt-provider-runtime.js` | daemon model session state | ChatGPT DOM projection remains in reviewed content scripts |
| Chats/Historia storage | `extension/src/chats-store.js` | daemon Historia/resource source | Browser capture forwards bounded observations; primary index leaves extension |
| Tahto connector authority | `extension/src/tahto-*` | daemon sync/source adapters | Tahto provides replication substrate, not profile key custody |
| Hestia client authority | `extension/src/hestia-client.js` | daemon Hestia adapter | Flutter and extension receive redacted proposal/receipt projections |
| DevTools native bridge | `services/devtools-node` | inverted browser/CLI-to-daemon bridge | Existing transport-only design is reused; authority direction reverses |
| Browser sender identity | Chrome service worker/content scripts | Chrome extension | Remains browser-local and must be attached to every forwarded request |
| Host permissions and user gestures | Chrome extension | Chrome extension | Daemon cannot infer or manufacture browser permission |
| Browser effects | extension effect handlers | Chrome extension | Every daemon-requested effect is revalidated against current tab/document state |
| Local clients | Daemon-owned enrolment and connection sessions | Fixed roles open short-lived connection-bound sessions; credentials are never receipted, and semantic receipts bind the daemon-derived client ID and role. |
| Management surfaces | extension side panel and app surfaces | Flutter Desktop | UI is replaceable and contains no durable authority |
| Remote MCP coordination | `services/mcp-gateway` | optional ingress to an authorised daemon node | Reuse pairing/replay primitives; hosted gateway is not the kernel |

## Migration order

1. Establish `greenwaysd`, local IPC, restart-safe identity, and a CLI status
   client.
2. Add the daemon vault, profile/node identities, capability authority, and
   typed provider operations.
3. Project current extension state into compatibility services and prove exact
   migration/restart behavior.
4. Build the Flutter Desktop management client against the same local protocol.
5. Invert Native Messaging so reviewed browser requests enter the daemon.
6. Move Hara applications, packages, work, resources, model sessions, and
   receipts.
7. Disable extension-resident writable authority for migrated profiles.
8. Package the same daemon as Greenways Server and implement node/source sync.
9. Rebind remote MCP to enrolled daemon routes.

## Release gate

No PR may remove the current extension authority merely because a daemon process
is reachable. The profile must contain an explicit runtime mode and completed
migration receipt. A daemon disconnect in daemon mode is a visible unavailable
state, not permission to revive a separate writable browser profile.

## Provider credentials

Provider-profile metadata moves to `greenwaysd` and provider credential bytes move to the operating-system credential store. The first migration slice exposes only redacted `vault.status`; mutation is offline through `greenways-admin` while the daemon is stopped. The Chrome extension keeps its separate, credential-free foreground ChatGPT provider until the reviewed browser bridge cutover.

## Profile identity

Profile identity is now daemon-owned. One self-signed P-256 public card is persisted with an opaque operating-system keyring handle; ordinary clients receive only status or the signed public card. There is no generic signing or key export route. The browser-resident controller identity remains a compatibility source until an explicit prepare–verify–commit migration replaces it.

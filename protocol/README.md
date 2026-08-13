# Greenways OS confidence protocol

The cross-system meanings of verification, authentication, approval, grants,
authorization decisions, admission, resource scope and host ownership are fixed
by [`authority-model.md`](authority-model.md). Protocol documents must use those
terms rather than the ambiguous shorthand `auth`.

This Greenways-owned contribution defines portable records for artist-first
collaboration, AI-mediated services, quality results, and personal Hestia
chains. Hara hosts and verifies the contribution but does not own its domain
vocabulary.

The protocol deliberately has no global chain, global reputation score, or
legal-ownership oracle. Each identity records signed actions in its own Hestia
chain. Parties share canonical receipt roots, while each chain retains its own
inclusion history. Exported evidence can be independently verified without
granting Greenways control over an identity or project.

The normative draft is [`spec/draft/greenways-os.edn`](spec/draft/greenways-os.edn).
The first product profile is the mixed-media Release Steward implemented by the
repository's separate `extension/` Chrome package.

The public identity discovery boundary is specified in
[`id.greenways.ai.md`](id.greenways.ai.md). The resolver distributes signed
public identity material; it never receives private keys or replaces Hestia.

The sovereign-first application boundary and built-in launcher catalog are
specified in [`apps.md`](apps.md). App manifests are declarative records and
cannot provide remote code for the extension to execute. The rehydratable
browser-wide authority, document-context split, and transactional request
contract are specified in [`kernel.md`](kernel.md).

The current local gateway and Space boundary is specified in
[`beacon.md`](beacon.md). Greenways Beacon is a Hara application on Hoplite and
provides a fixed, inspectable route to `greenways.space`, where Hestia,
Ignatius, Historia and later services are composed. Beacon never becomes the
browser kernel or a second Hestia authority.

The earlier private browser-and-service architecture remains documented in
[`home-node.md`](home-node.md). Its first runnable wire profile—signed browser
pairing, pinned node identity, presence, unpairing, and bounded local-service
discovery—is specified in [`home-link.md`](home-link.md). That Node-based
implementation is now a compatibility path while browser device grants migrate
to Beacon and Hoplite.

The foreground ChatGPT web-provider boundary is specified in
[`chatgpt-provider.md`](chatgpt-provider.md). The Hara kernel remains in the
extension service worker; the ChatGPT page receives only a reviewed,
request-scoped adapter. The complementary remote interface for ChatGPT apps is
specified in [`mcp-gateway.md`](mcp-gateway.md).

The local-first image identity, exact-byte storage, lineage, curation, and
publishing boundary is specified in [`assets.md`](assets.md). Asset bytes are
inert data: generation providers may submit candidates, but they cannot grant
approval or publication authority.

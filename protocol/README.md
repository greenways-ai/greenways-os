# Greenways OS confidence protocol

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
cannot provide remote code for the extension to execute.
# Greenways Asset Registry protocol

Status: local-first draft  
Asset protocol: `greenways-asset/0-alpha`  
Head protocol: `greenways-asset-head/0-alpha`  
Alias protocol: `greenways-asset-alias/0-alpha`  
SHA-256 index protocol: `greenways-asset-sha256-index/0-alpha`

## Purpose

The Asset Registry gives files generated in ChatGPT, image tools, Figma, local
editors, and future Greenways applications one durable identity without making
any generation provider the source of truth. Exact bytes live in an immutable
content store. Portable `.hal` manifests describe identity, provenance,
lineage, curation, and publication state.

The first implementation is `services/assets/`. Its filesystem backend is the
reference profile for the protocol, not a requirement that production storage
remain local. Cloudflare R2, S3, or another object backend may implement the
same exact-byte object contract.

## Identity layers

Every imported asset has three separate forms of identity:

1. `gw.asset/<uuid>` is the stable logical identity of the imported creative
   asset;
2. `:content/sha256` identifies one exact sequence of bytes and is used for
   immutable storage and deduplication; and
3. an optional lowercase alias such as
   `visual-language/hodos/peacock-rosette` provides a human-readable resolver.

A filename is source metadata only. It is never an asset identity.

## Portable manifest

Each immutable revision is projected as a pure `.hal` value. A representative
record is:

```clojure
{:asset/protocol "greenways-asset/0-alpha"
 :asset/id "gw.asset/11111111-1111-4111-8111-111111111111"
 :asset/revision 1
 :asset/kind "image"
 :asset/title "Compact peacock mosaic flower"
 :asset/state "inbox"
 :asset/created-at "2026-08-11T04:00:00.000Z"
 :asset/updated-at "2026-08-11T04:00:00.000Z"
 :asset/project "greenways.visual-language"
 :asset/collections ["flowers"]
 :asset/aliases ["visual-language/hodos/peacock-rosette"]
 :asset/tags ["hodos" "mosaic" "peacock"]
 :asset/content
 {:content/sha256 "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  :content/mime "image/png"
  :content/bytes 2447383
  :content/width 1122
  :content/height 1402
  :content/object-key "objects/sha256/01/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png"}
 :asset/source
 {:source/kind "file-import"
  :source/provider "openai-image"
  :source/generation-id "d09fdf9b-138e-4d44-a8ab-5678a51765f0"
  :source/file-name "peacock-compact.png"
  :source/prompt-sha256 nil}
 :asset/lineage
 {:lineage/parent "gw.asset/00000000-0000-4000-8000-000000000000"
  :lineage/operation "image/edit"
  :lineage/instruction "Shorten vertically and use fewer leaves"}
 :asset/workflow
 {:workflow/from nil
  :workflow/to "inbox"
  :workflow/note "Imported immutable source object"}}
```

JSON records beside the manifest are a local operational representation. They
do not replace the portable `.hal` projection and may be rebuilt by a future
Hara-owned implementation.

## Exact-byte object contract

The registry computes SHA-256 over the source bytes before writing them. The
object key is derived only from the digest and detected media format:

```text
objects/sha256/<first-two-hex>/<64-hex-digest>.<extension>
```

An existing object at that key must hash to the expected digest. A mismatch is
corruption, not a new version. Importing the same exact bytes returns the
existing logical asset and does not merge unreviewed metadata into it.

Editing, resizing, recompressing, colour-profile conversion, and metadata
stripping all produce new bytes and therefore a new content digest. A creative
edit is represented as a new logical asset with `:lineage/parent`, never as an
overwrite.

## Revisions and lifecycle

Full record and manifest revisions are append-only. The mutable head points to
the latest complete revision. States have a monotonic order:

```text
inbox → curated → approved → published → deprecated
```

A transition may move forward more than one state when a trusted workflow has
already completed the intermediate review. It may never move backwards.
`deprecated` is terminal in `0-alpha`. Every transition increments the revision
and records `from`, `to`, and an optional human note.

`published` is initially an approval fact only. It does not imply that a private
source object is publicly reachable. A publishing adapter must make that copy
or rendition explicit and must preserve its source digest and transformation
recipe.

## Aliases

Aliases are lowercase portable paths. They resolve to an asset ID but never
replace it in receipts or release locks. `0-alpha` assigns an alias exactly once;
reassignment will be added with an explicit audited release-and-bind operation.
Applications that require reproducible releases must pin both asset ID and exact
content digest rather than relying only on an alias.

## Privacy boundary

The public asset manifest must not contain:

- provider API keys, cookies, bearer tokens, or account identifiers;
- local absolute paths;
- private prompt text or confidential source documents;
- hidden model instructions; or
- unreviewed EXIF location or person metadata.

The first importer records only the source basename and accepts a prompt digest,
not prompt text. Private prompts and generation receipts belong in Hestia or
another access-controlled receipt store. A public manifest may later carry only
a content hash or capability-scoped receipt reference.

## Authority boundary

The Asset Registry owns asset identity, exact-byte storage, lineage, workflow
state, and resolver records. It does not own:

- generation-provider credentials or browser automation;
- visual-language approval policy;
- transformation implementation;
- public CDN authority;
- legal ownership adjudication; or
- application release locks.

Greenways OS connectors may submit candidate files, but they cannot mark an
asset approved or published without the corresponding host capability. Asset
bytes are inert data and never executable extension code.

## Next compatible slices

The protocol is intentionally ready for these additions without changing the
logical asset record:

- an R2/S3 object adapter and private/public bucket split;
- deterministic rendition records with source and recipe digests;
- audited alias release and reassignment;
- a browser/Downloads/Figma ingestion surface;
- contact sheets, visual comparison, and perceptual duplicate suggestions;
- C2PA preservation and signing at the approved publishing boundary; and
- Hestia-backed private prompt and provenance receipts.

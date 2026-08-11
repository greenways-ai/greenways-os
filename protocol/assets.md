# Greenways Asset Registry protocol

Status: local-first Git LFS draft  
Asset protocol: `greenways-asset/0-alpha`  
Head protocol: `greenways-asset-head/0-alpha`  
Alias protocol: `greenways-asset-alias/0-alpha`  
SHA-256 index protocol: `greenways-asset-sha256-index/0-alpha`

## Purpose

The Asset Registry gives files generated in ChatGPT, image tools, Figma, local
editors, and future Greenways applications one durable identity without making
any generation provider the source of truth. Portable `.hal` manifests describe
identity, provenance, lineage, curation, and publication state.

The canonical catalogue is a Git repository. Small manifests, heads, aliases,
indexes, collections, and release decisions remain ordinary Git text. Exact
binary objects under `objects/**` use the standard Git Large File Storage v1
clean/smudge boundary. This replaces the planned R2-specific source store: the
registry requires no bucket API and may use GitHub LFS or another conforming Git
LFS server.

Git LFS is a source transport and versioning boundary, not the public image CDN.
A separate static build may hydrate selected published renditions and copy them
to the `assets.greenways.ai` deployment output.

## Identity layers

Every imported asset has three separate forms of identity:

1. `gw.asset/<uuid>` is the stable logical identity of the imported creative
   asset;
2. `:content/sha256` identifies one exact sequence of bytes and is used for
   immutable storage, deduplication, and the Git LFS object ID; and
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

## Git LFS mapping

A Greenways object is tracked with this catalogue-root attribute:

```gitattributes
objects/** filter=lfs diff=lfs merge=lfs -text
```

For an asset record, the canonical Git LFS v1 pointer is derived without another
identifier or database lookup:

```text
version https://git-lfs.github.com/spec/v1
oid sha256:<content/sha256>
size <content/bytes>
```

The registry does not need to write pointer files into the working tree. The Git
LFS clean filter generates them when the hydrated object is staged. A normal
checkout exposes exact image bytes through the smudge/filter-process boundary.

A checkout made with LFS downloads disabled may expose pointer text at the
object path. The registry must recognize a valid pointer before image parsing or
byte verification and report that the object is not hydrated. It must not treat
the pointer bytes as the image, silently overwrite the pointer, or calculate a
new asset identity from it.

The canonical pointer is bounded to the Git LFS v1 pointer limit and uses LF
line endings. Optional standard `ext-*` lines may be recognized, but the asset
content identity remains the `oid sha256` value after any declared LFS extension
processing.

## Exact-byte object contract

The registry computes SHA-256 over the hydrated source bytes before writing
them. The object key is derived only from the digest and detected media format:

```text
objects/sha256/<first-two-hex>/<64-hex-digest>.<extension>
```

An existing hydrated object at that key must hash to the expected digest. A
mismatch is corruption, not a new version. Importing the same exact bytes
returns the existing logical asset and does not merge unreviewed metadata into
it.

Editing, resizing, recompressing, colour-profile conversion, and metadata
stripping all produce new bytes and therefore a new content digest and Git LFS
object. A creative edit is represented as a new logical asset with
`:lineage/parent`, never as an overwrite.

The Git repository commit records which exact manifests and LFS pointers were
reviewed together. The Git LFS server transports bytes but does not become the
asset identity authority; that authority remains the signed/reviewed catalogue
commit plus its portable records.

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

`published` is initially an approval fact only. It does not imply that a Git LFS
object endpoint is a stable public URL. A publishing build must hydrate the
selected object, verify its digest, apply or locate the deterministic rendition,
and copy that rendition into an explicit static deployment output.

## Aliases

Aliases are lowercase portable paths. They resolve to an asset ID but never
replace it in receipts or release locks. `0-alpha` assigns an alias exactly once;
reassignment will be added with an explicit audited release-and-bind operation.
Applications that require reproducible releases must pin both asset ID and exact
content digest rather than relying only on an alias.

## Catalogue repository boundary

The intended catalogue layout is:

```text
.gitattributes
.gitignore
objects/sha256/...
records/...
manifests/...
heads/...
indexes/sha256/...
aliases/...
collections/...
releases/...
```

Only `objects/**` is LFS-tracked. Keeping manifests and resolver records as
ordinary Git text allows pull requests to show metadata, lineage, state, and
alias changes without fetching every binary object. Transient registry locks
and temporary files are never committed.

The registry deliberately does not call `git commit`, `git push`, or Git hosting
APIs on import. Those are review and publication effects that require explicit
host authority. A later Greenways OS workflow may prepare a branch and pull
request, but it must preserve the same boundary.

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

A private catalogue repository keeps source objects access-controlled through
its Git and LFS host. Publication must copy only reviewed renditions into the
public static output; it must not expose the private LFS endpoint or credentials.

## Authority boundary

The Asset Registry owns asset identity, exact-byte verification, lineage,
workflow state, and resolver records. Git and Git LFS provide commit history and
binary transport. The registry does not own:

- generation-provider credentials or browser automation;
- visual-language approval policy;
- Git hosting identity or repository administration;
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

- bootstrap a dedicated Git LFS catalogue repository;
- deterministic rendition records with source and recipe digests;
- an LFS-aware static catalogue and `assets.greenways.ai` publication build;
- audited alias release and reassignment;
- a browser/Downloads/Figma ingestion surface;
- contact sheets, visual comparison, and perceptual duplicate suggestions;
- C2PA preservation and signing at the approved publishing boundary; and
- Hestia-backed private prompt and provenance receipts.

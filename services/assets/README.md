# Greenways Assets

Greenways Assets is the first local-first asset registry for Greenways OS. It
imports exact image bytes once, stores them under a SHA-256 content address, and
writes append-only JSON records plus portable `.hal` manifest projections.

This service deliberately starts without a database, public bucket, browser
extension, or provider-specific SDK. The filesystem layout is the reference
storage contract. An R2/S3 object-store adapter can replace the local object
backend without changing asset IDs, manifests, aliases, lineage, or workflow
states.

## What the first slice provides

- exact-byte SHA-256 addressing and deduplication;
- immutable image objects and append-only manifest revisions;
- PNG, JPEG, WebP, GIF, and SVG metadata inspection;
- stable `gw.asset/<uuid>` logical IDs;
- optional human-readable aliases;
- parent/edit lineage and private-safe prompt hashes;
- `inbox → curated → approved → published → deprecated` lifecycle states;
- object and metadata verification; and
- a dependency-free Node.js 22 CLI.

Prompt text is not accepted by the CLI and is never copied from image metadata.
Callers may retain only a SHA-256 prompt digest or a private Hestia receipt
reference in a later protocol revision.

## Quick start

From the repository root:

```bash
npm --prefix services/assets ci
npm --prefix services/assets test

node services/assets/bin/greenways-assets.mjs init \
  --root "$HOME/.greenways/assets"

node services/assets/bin/greenways-assets.mjs import ./peacock.png \
  --root "$HOME/.greenways/assets" \
  --title "Compact peacock mosaic flower" \
  --project greenways.visual-language \
  --collection flowers \
  --alias visual-language/hodos/peacock-rosette \
  --provider openai-image \
  --generation-id d09fdf9b-138e-4d44-a8ab-5678a51765f0 \
  --tag hodos \
  --tag peacock \
  --tag mosaic
```

The command prints the complete operational record as JSON. It does not print or
persist the source path beyond its basename.

Promote and verify the selected asset:

```bash
node services/assets/bin/greenways-assets.mjs approve \
  visual-language/hodos/peacock-rosette \
  --root "$HOME/.greenways/assets" \
  --note "Selected for the Hodos crest"

node services/assets/bin/greenways-assets.mjs verify \
  visual-language/hodos/peacock-rosette \
  --root "$HOME/.greenways/assets"
```

Record an edit as a new asset rather than replacing its parent:

```bash
node services/assets/bin/greenways-assets.mjs import ./peacock-compact.png \
  --root "$HOME/.greenways/assets" \
  --title "Compact peacock mosaic flower" \
  --parent gw.asset/11111111-1111-4111-8111-111111111111 \
  --operation image/edit \
  --instruction "Shorten vertically and use fewer leaves"
```

## Storage layout

```text
<root>/
├── objects/sha256/ab/<digest>.png       exact immutable bytes
├── records/<uuid>/00000001.json         append-only operational record
├── manifests/<uuid>/00000001.hal        append-only portable projection
├── heads/<uuid>.json                    current revision pointer
├── indexes/sha256/ab/<digest>.json      exact-byte deduplication index
├── aliases/<path>.json                  human-readable resolver pointer
└── locks/registry.lock                  bounded cross-process mutation lock
```

Only `heads/` and a future reassigned alias pointer are mutable projections.
Exact objects, full records, and `.hal` revisions are never overwritten.

## Commands

```text
init
import FILE
show ID_OR_ALIAS
list [--state STATE] [--project NAME] [--collection NAME]
history ID_OR_ALIAS
verify ID_OR_ALIAS
state ID_OR_ALIAS STATE
curate ID_OR_ALIAS
approve ID_OR_ALIAS
publish ID_OR_ALIAS
deprecate ID_OR_ALIAS
```

Set `GREENWAYS_ASSETS_ROOT` to avoid repeating `--root`.

## Current boundary

`published` currently records an approval state; it does not make bytes public.
The next storage slice will add an R2-compatible private source store, generated
renditions, and an explicit public publishing adapter. That adapter must verify
the source digest before copying or transforming content and must never mutate
the source object.

See [`../../protocol/assets.md`](../../protocol/assets.md) for the portable
contract and authority boundary.

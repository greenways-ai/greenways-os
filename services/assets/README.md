# Greenways Assets

Greenways Assets is the first local-first asset registry for Greenways OS. It
imports exact image bytes once, stores them under a SHA-256 content address, and
writes append-only JSON records plus portable `.hal` manifest projections.

The canonical catalogue is designed to be an ordinary Git repository with its
`objects/**` tree tracked by standard Git Large File Storage. Git retains the
small manifests, heads, aliases, indexes, and review history; Git LFS transports
the exact image bytes. No R2-specific API or bucket is required.

The registry's existing identity fields map directly to a Git LFS v1 pointer:
`:content/sha256` is the LFS SHA-256 object ID and `:content/bytes` is its size.
The implementation also detects an unhydrated LFS pointer and tells the caller
to run `git lfs pull` or `git lfs checkout` rather than reporting misleading
image corruption.

## What the first slice provides

- exact-byte SHA-256 addressing and deduplication;
- immutable image objects and append-only manifest revisions;
- standard Git LFS pointer compatibility;
- PNG, JPEG, WebP, GIF, and SVG metadata inspection;
- stable `gw.asset/<uuid>` logical IDs;
- optional human-readable aliases;
- parent/edit lineage and private-safe prompt hashes;
- `inbox → curated → approved → published → deprecated` lifecycle states;
- object, hydration, and metadata verification; and
- a dependency-free Node.js 22 CLI.

Prompt text is not accepted by the CLI and is never copied from image metadata.
Callers may retain only a SHA-256 prompt digest or a private Hestia receipt
reference in a later protocol revision.

## Create a Git LFS catalogue

Create a dedicated repository and install the catalogue tracking rule before
importing the first image:

```bash
mkdir greenways-assets
cd greenways-assets

git init
git lfs install
cp /path/to/greenways-os/services/assets/catalog-template/.gitattributes .
cp /path/to/greenways-os/services/assets/catalog-template/.gitignore .

node /path/to/greenways-os/services/assets/bin/greenways-assets.mjs init \
  --root .

git add .gitattributes .gitignore
git commit -m "Initialize the Greenways asset catalogue"
```

Only `objects/**` is tracked through LFS:

```gitattributes
objects/** filter=lfs diff=lfs merge=lfs -text
```

This keeps reviewable metadata as normal Git text. The catalogue template is in
[`catalog-template/`](catalog-template/).

## Import an image

```bash
node /path/to/greenways-os/services/assets/bin/greenways-assets.mjs import ./peacock.png \
  --root . \
  --title "Compact peacock mosaic flower" \
  --project greenways.visual-language \
  --collection flowers \
  --alias visual-language/hodos/peacock-rosette \
  --provider openai-image \
  --generation-id d09fdf9b-138e-4d44-a8ab-5678a51765f0 \
  --tag hodos \
  --tag peacock \
  --tag mosaic

git add objects records manifests heads indexes aliases
git commit -m "Import the compact Hodos peacock asset"
git push
```

Git's clean filter replaces each staged image object with a pointer in the Git
object database while the working tree continues to expose the image bytes.
The registry never shells out to Git and does not commit or push on the user's
behalf; ordinary Git review remains the publication boundary.

The import command prints the complete operational record as JSON. It does not
print or persist the source path beyond its basename.

Promote and verify the selected asset:

```bash
node /path/to/greenways-os/services/assets/bin/greenways-assets.mjs approve \
  visual-language/hodos/peacock-rosette \
  --root . \
  --note "Selected for the Hodos crest"

node /path/to/greenways-os/services/assets/bin/greenways-assets.mjs verify \
  visual-language/hodos/peacock-rosette \
  --root .
```

Record an edit as a new asset rather than replacing its parent:

```bash
node /path/to/greenways-os/services/assets/bin/greenways-assets.mjs import ./peacock-compact.png \
  --root . \
  --title "Compact peacock mosaic flower" \
  --parent gw.asset/11111111-1111-4111-8111-111111111111 \
  --operation image/edit \
  --instruction "Shorten vertically and use fewer leaves"
```

## Storage layout

```text
<catalogue>/
├── .gitattributes                         objects/** uses Git LFS
├── .gitignore                             transient locks stay local
├── objects/sha256/ab/<digest>.png         hydrated exact bytes / LFS pointer in Git
├── records/<uuid>/00000001.json           append-only operational record
├── manifests/<uuid>/00000001.hal          append-only portable projection
├── heads/<uuid>.json                      current revision pointer
├── indexes/sha256/ab/<digest>.json        exact-byte deduplication index
├── aliases/<path>.json                    human-readable resolver pointer
└── locks/registry.lock                    bounded cross-process mutation lock
```

Only `heads/` and a future reassigned alias pointer are mutable projections.
Exact objects, full records, and `.hal` revisions are never overwritten.

A checkout made with LFS downloads disabled contains pointer text in place of
images. Hydrate it before verification or publishing:

```bash
git lfs pull
# or, when the objects are already in the local LFS cache
git lfs checkout
```

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

`published` records an approval state; it does not turn the Git LFS endpoint into
a public image CDN. The next slice will add deterministic renditions and a
static catalogue build. CI will perform an LFS-aware checkout, select only
published renditions, verify their exact source and recipe digests, and copy the
result into the `assets.greenways.ai` deployment output. This can use the
existing Greenways static hosting path without introducing R2.

See [`../../protocol/assets.md`](../../protocol/assets.md) for the portable
contract and authority boundary.

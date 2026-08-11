# Greenways Assets catalogue template

Copy `.gitattributes` and `.gitignore` to the root of a dedicated asset catalogue
repository before importing files.

```bash
git lfs install
cp path/to/greenways-os/services/assets/catalog-template/.gitattributes .
cp path/to/greenways-os/services/assets/catalog-template/.gitignore .

git add .gitattributes .gitignore
git commit -m "Configure the Greenways asset catalogue"
```

The tracking rule deliberately applies only to `objects/**`. JSON heads,
append-only records, `.hal` manifests, aliases, indexes, and release metadata
remain ordinary Git text so changes can be reviewed without downloading every
image object.

The registry content digest is already the Git LFS object ID:

```text
version https://git-lfs.github.com/spec/v1
oid sha256:<asset content SHA-256>
size <asset byte length>
```

After cloning with LFS downloads disabled, hydrate exact objects before running
registry verification:

```bash
git lfs pull
# or hydrate already-fetched objects only
git lfs checkout
```

A public catalogue build should use an LFS-aware checkout, select only assets in
`published` state, and copy approved renditions to the static deployment output.
Git LFS is the canonical versioned source transport, not the public image CDN.

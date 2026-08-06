# Greenways packages registry

This service builds and serves the static `greenways-registry/1` release tree.
It signs an exact EDN index payload with a registry P-256 key, signs each version
approval identity with its publisher P-256 key, generates `:lock/format 2`
files, verifies every HARP archive with the same lock/HARP invariants as the extension client, and
publishes immutable versioned paths before replacing `v1/index.edn`.

## Source layout

`registry.json` uses protocol `greenways-registry-source/1` and names packages,
versions, app JSON files, publisher key paths, and prebuilt HARP archives.
Private keys remain outside the output tree.

```json
{
  "protocol": "greenways-registry-source/1",
  "origin": "https://packages.greenways.ai/",
  "keyId": "greenways-packages-2026-01",
  "expiresSeconds": 86400,
  "packages": [{
    "coordinate": "greenways:notes",
    "id": "notes",
    "latest": "1.0.0",
    "publisher": {
      "id": "greenways-ai",
      "name": "Greenways AI",
      "keyId": "greenways-ai-release-1",
      "privateKey": "keys/greenways-ai-release-private.jwk"
    },
    "versions": [{
      "version": "1.0.0",
      "app": "packages/notes/1.0.0/app.json",
      "archives": [{
        "coordinate": "greenways:notes",
        "version": "1.0.0",
        "file": "packages/notes/1.0.0/notes.harp"
      }]
    }]
  }]
}
```

The app JSON contains the ordinary `greenways-app/1` fields through
`capabilities`. The builder injects and validates the `hal-module`, release
channel, registry coordinate, and computed lock digest fields.

## Commands

```bash
npm run build:registry -- --source ./registry-src --output ./dist \
  --registry-key ./keys/registry-private.jwk
npm start -- --root ./dist --host 127.0.0.1 --port 8787
```

The static output can be copied to object storage or a normal HTTPS server. Do
not transform EDN or HARP bytes after the build: signatures and digests bind the
exact output.

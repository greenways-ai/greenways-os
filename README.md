# Greenways OS

Artist-first confidence infrastructure for signed creative workflows,
AI-mediated services, personal Hestia evidence chains, portable publishing,
and repository-defined Gaussian splat worlds.

This repository owns both the Greenways OS protocol and its client surfaces.
Hara supplies the portable workflow runtime; Hestia supplies each person's
durable chain, identity recovery, and chosen-authority backup.

## Layout

- `protocol/` — normative Greenways-owned records and conformance cases.
- `extension/` — the low-permission Chrome MV3 side panel and Studio.
- `services/identity/` — runnable development slice of `id.greenways.ai`.

`id.greenways.ai` resolves signed handles, key histories, service endpoints,
and witnessed checkpoint references. Personal histories and private keys
remain with the user's Hestia infrastructure.

## Extension development

```sh
cd extension
npm install
npm run build
npm test
npm run test:browser

cd ../services/identity
npm test
```

Load the repository's `extension/` directory as an unpacked extension at
`chrome://extensions`.

The extension's **Open a GitHub world** surface works before identity setup.
It reads a public repository's root `project.edn`, resolves every ref to an
immutable Git commit, and renders its local and imported SOG layers. See
[`protocol/worlds.md`](protocol/worlds.md) for the manifest contract.

The viewer features three maintained examples from
[`greenways-worlds`](https://github.com/greenways-worlds): Apartment (single
SOG), Playbot (streamed SOG), and Splat Garden (immutable repository imports).

## First vertical slice

An artist can create a key-controlled identity and project, add digest-addressed
contributions, run the Release Steward, accept service proposals, publish a
signed release checkpoint, and export a self-verifying evidence bundle. Every
action is included in that artist's local personal chain and can later be sent
to their Hestia server.

The Release Steward performs named checks with visible limitations. It cannot
edit artifacts, accept its own proposals, publish, or turn its advice into a
global quality score. Rights records are attributable claims and permissions;
they are not declarations of legal title or jurisdiction-specific legal advice.

`id.greenways.ai` verifies self-signed public registrations and returns
content-rooted resolutions. A handle collision stays visible. The resolver
does not receive private keys or become the identity authority.

# Greenways OS apps

Greenways OS turns the browser into a small, sovereign-first operating
environment. Its identity, local storage, receipts, and system surfaces must
remain useful without an account, remote registry, social graph, or hosted
service. Participation is optional: an app may add collaboration or a remote
service, but it cannot become a condition for using the local kernel.

An app manifest is inert, declarative data. It selects a runtime handler already
shipped in the extension and never carries JavaScript, WebAssembly, HTML, a
native executable, an entrypoint, or source code. The sole executable-package
carve-out is `hal-module`: the manifest may identify an independently fetched,
digest-verified `.harp` package whose HAL resources are evaluated by the
browser-resident Hara kernel inside a bounded, app-owned namespace generation.
The archive is not a manifest field and cannot add a host handler, browser
permission, native provider, capability, or DOM implementation.

## Manifest

Every non-module manifest has exactly these fields:

| Field | Meaning |
| --- | --- |
| `protocol` | Exact manifest protocol, currently `greenways-app/0-alpha`. |
| `id` | Stable lowercase identifier. |
| `version` | SemVer 2.0 version of this exact app integration. |
| `publisher` | Stable lowercase publisher identifier and human-facing name. |
| `name` | Human-facing app name. |
| `description` | Plain-language purpose shown before installation or launch. |
| `category` | Either `system` or `installable`. |
| `capabilities` | A duplicate-free subset of the kernel's closed capability allowlist. |
| `launch` | One allowlisted handler and the handler-specific target. |
| `requirement` | Optional companion disclosure; required only for `native-hybrid`. |

A `hal-module` manifest additionally has exactly these metadata fields:

| Field | Meaning |
| --- | --- |
| `kind` | Exact value `hal-module`. |
| `channel` | `release`, `preview`, or `bundled`. |
| `lockDigest` | SHA-256 of the exact UTF-8 `project.lock.edn` bytes. |
| `source` | Channel-bound provenance only: registry coordinate, pinned GitHub repository and commit, or bundled relative path. |

Unknown fields are invalid. Publisher and version remain visible in every
installation record so upgrades and provenance do not depend on mutable display
text. `executable`, `module`, `script`, `entrypoint`, and URL variants of those
names remain invalid at every depth. `source` is accepted only as the closed,
metadata-only provenance descriptor of a `hal-module`; it cannot contain source
text, an executable URL, or nested extension fields.

Versions follow SemVer 2.0. The publisher identifier is the stable binding; the
publisher name is display text.

`system` identifies surfaces shipped as part of Greenways OS. System apps are
always available and can only select their fixed allowlisted app ID, publisher,
packaged target, and exact capability set. `installable` identifies an optional
integration. Installation is a local user decision recorded separately from the
immutable offer; being listed does not mean an app is installed, trusted,
running, or granted authority.

## Launch handlers

| Handler | Target | Rule |
| --- | --- | --- |
| `extension-page` | `path` | The path must name a packaged page in the extension-page allowlist. |
| `packaged-surface` | `surfaceId` | The surface must already be compiled into and registered by Greenways OS and match its app/publisher binding. |
| `native-hybrid` | `url` | The URL must be an exact allowlisted loopback URL; the manifest discloses its local companion and declares `network/loopback` plus `tabs/open`. |
| `web-tab` | `url` | The URL must be an exact allowlisted HTTPS destination and opens outside the extension execution context. |
| `hal-module` | none | The host loads verified HAL resources into an isolated `app.<id>.gN.*` namespace generation and renders only through a host-owned declarative surface. |

A registry can distribute a manifest selecting `hal-module`, because that
handler is locally shipped and fixed. A registry cannot introduce another
handler, a new host service, or a new declarative view element.

## HAL module container

A `.hal` app is distributed as one or more `.harp` archives selected by a
`:lock/format "0.0.0-alpha"` lock. Before staging, the extension verifies:

1. the exact lock digest bound by the approval;
2. each archive URL against channel policy;
3. archive size and SHA-256;
4. archive path safety;
5. `package.edn` and `:harp/format "0.0.0-alpha"`;
6. every declared file size and SHA-256; and
7. a duplicate-free namespace set.

Every resource begins with a matching `ns` form. The container rewrites all
package-local namespace references under a fresh generation such as
`app.notes.g3.notes.view`, loads the entry resource, then atomically swaps the
active generation. A failed load leaves the previous generation active. Reload
never mutates the old namespace in place.

V1 module source cannot directly reference `gw.os.*`, another `app.*` root, or
`std.native.*`, and cannot use dynamic namespace/evaluation forms. A module gets
host services only by returning bounded data and requesting capabilities through
typed kernel dispatch. These source checks are defence in depth; capability
policy, not namespace naming or a content hash, is the security boundary.

The host owns executable DOM. The module's view function returns a bounded EDN
view tree. The host validates depth, node count, string size, action identifiers,
and the closed element/attribute vocabulary before constructing DOM nodes. No
remote HTML, event handler, stylesheet, script, or URL-bearing element is
accepted as view data.

## Channels

### Release

The source descriptor names an allowlisted registry and package coordinate. The
registry index is signature-verified, the selected version binds an exact lock
digest, and every package is verified through the lock. An advertised newer
version is only `update-available`; it is never installed automatically.

### Preview

The source descriptor names `owner/repo` and an exact 40-character commit SHA.
Strict mode accepts only a SHA. Development mode may resolve a branch or tag,
but the resolved SHA is displayed and persisted before installation. Lock and
archive fetches are derived from that immutable commit and use the same digest
verification pipeline as release packages. Preview installations are visibly
badged.

### Bundled

The source descriptor names a safe relative path inside the reviewed extension
bundle. Build output binds the exact lock digest. Bundled modules use the same
container and lifecycle as release and preview modules; only provenance differs.

Switching channel is an explicit update operation and requires approval even
when version and capabilities happen to match.

## Approval

For ordinary apps, approval continues to bind app ID, version, publisher ID,
handler target, and the complete sorted capability set.

For `hal-module`, approval binds exactly:

```text
id + version + publisher-id + sorted-capabilities + hal-module + lock-digest
```

The lock digest is the code identity. A changed lock or capability set always
requires a fresh approval. Source provenance and channel are retained in the
installed record and receipts; switching channel is separately consented. A
hash proves byte identity, not safety or authority.

## Lifecycle

The fixed module lifecycle is:

```text
modules/install
modules/update
modules/reload
modules/remove
modules/invoke
```

Install and update validate the manifest, approval, lock, archives, and staged
namespace before committing the profile-wide installed record. Reload stages a
fresh generation and swaps only after successful evaluation. Remove revokes the
active generation and closes its surface but retains app data unless a separate
deletion is requested. Checkpoint and restore use the existing app context
protocol; module state is data and is never treated as source.

Kernel-host transitions retain the existing serialized prepare → effects →
commit discipline. Module staging is compensatable until commit. A browser or
other non-replayable effect is never used to install module code.

## Capability vocabulary

Capabilities describe requested authority; they do not grant it by themselves.
The closed installation vocabulary is owned by the resident Capability and
Consent service and includes:

| Capability | Purpose | Operation grant |
| --- | --- | --- |
| `hara/module` | Run a digest-verified HAL module in the bounded kernel container. | no |
| `key/public` | Read public controller and key metadata only. | yes |
| `key/sign` | Ask the Keyring to sign a bounded payload without exporting a private key. | yes |
| `credential/manage` | Manage opaque credential profiles; initially restricted to reviewed Greenways publishers. | yes |
| `credential/use` | Use an approved opaque profile without revealing its secret. | yes |
| `model/generate` | Perform a bounded model request through an approved provider profile. | yes |
| `userscripts/manage` | Register, update, or remove user-authored scripts that run in matching web pages; restricted to reviewed Greenways publishers. | yes |

Existing non-operation-grant capabilities remain `identity/local`,
`storage/local`, `network/github`, `network/loopback`, `network/https`,
`tabs/open`, `worlds/browse`, `historia/import`, `hestia/connect`, and
`hara/evaluate`. `hal-module` requires `hara/module`.

A manifest declaration is only an installation request. Consequential operations
require a separate `greenways-capability-grant/0-alpha` created by the trusted host
and bound to the exact app ID, version, publisher, and lock digest. Expired,
revoked, removed, updated, or stale grants cannot authorize an operation. Grant
constraints may contain bounded policy and opaque profile references but cannot
contain API keys, passwords, tokens, private keys, or authorization values.

Any further host service or capability requires a reviewed Greenways OS policy
update; an archive or registry cannot mint one. See `core-services.md`.

## Distribution boundary

A signed registry may distribute descriptions, versions, publisher records,
lock files, `.harp` archives, receipts, and `hal-module` installation offers.
It cannot extend the local runtime-handler allowlist, browser permissions,
capability vocabulary, native providers, effect policy, surface vocabulary, or
message limits. Those remain reviewed Greenways OS code with conformance tests.

This keeps the extension a sovereign local kernel first. Users can add or remove
optional modules and services while the local identity, storage, receipts, and
system home remain usable.

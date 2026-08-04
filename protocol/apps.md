# Greenways OS apps

Greenways OS turns the browser into a small, sovereign-first operating
environment. Its identity, local storage, receipts, and system surfaces must
remain useful without an account, remote registry, social graph, or hosted
service. Participation is optional: an app may add collaboration or a remote
service, but it cannot become a condition for using the local kernel.

This draft defines the built-in catalog boundary. An app manifest is inert,
declarative data. It selects a runtime handler already shipped in the extension;
it never supplies JavaScript, a module URL, an executable, an entrypoint, or
source code for the extension to fetch and run.

## Manifest

Every manifest has exactly these fields:

| Field | Meaning |
| --- | --- |
| `protocol` | Exact manifest protocol, currently `greenways-app/1`. |
| `id` | Stable lowercase identifier. |
| `version` | SemVer 2.0 version of this exact app integration, including optional prerelease and build metadata. |
| `publisher` | Stable lowercase publisher identifier and human-facing name. |
| `name` | Human-facing app name. |
| `description` | Plain-language purpose shown before installation or launch. |
| `category` | Either `system` or `installable`. |
| `capabilities` | A duplicate-free subset of the kernel's closed capability allowlist. |
| `launch` | One allowlisted handler and the handler-specific target. |
| `requirement` | Optional companion disclosure; required only for `native-hybrid`. |

Unknown fields are invalid. Publisher and version remain visible in every
installation record so upgrades and catalog provenance do not depend on mutable
display text. In particular, `executable`, `module`, `source`,
`script`, `entrypoint`, and URL variants of those names are invalid at any
depth. A catalog cannot smuggle an execution mechanism into descriptive data.

Versions follow SemVer 2.0: core numeric identifiers cannot contain leading
zeroes, numeric prerelease identifiers cannot contain leading zeroes, and
prerelease or build identifiers cannot be empty. Build metadata such as
`1.2.0+package.7` is valid. The publisher identifier is the stable binding;
the publisher name is display text.

`system` identifies surfaces shipped as part of Greenways OS. System apps are
always available and can only select their fixed allowlisted app ID, publisher,
packaged extension path, and exact capability set.
`installable` identifies an optional integration. Installation is a local user
decision recorded separately from the immutable manifest; being listed does
not mean that an app is installed, trusted, running, or granted authority.

## Launch handlers

| Handler | Target | Rule |
| --- | --- | --- |
| `extension-page` | `path` | The path must name a packaged page in the extension-page allowlist. |
| `packaged-surface` | `surfaceId` | The surface must already be compiled into and registered by Greenways OS, and the manifest must match that surface's app and publisher binding. |
| `native-hybrid` | `url` | The URL must be an exact allowlisted loopback URL; the manifest must disclose its local companion and declare `network/loopback` plus `tabs/open`. |
| `web-tab` | `url` | The URL must be an exact allowlisted HTTPS destination and opens as a browser tab, outside the extension execution context. |

The built-in draft accepts the packaged surface `hestia-connector`, the local
URL `http://127.0.0.1:4319/`, and the web destination
`https://playground.hara-lang.org/`. Queries, fragments, credentials, alternate
hosts, protocol downgrades, `data:` URLs, and `javascript:` URLs are rejected.
The `hestia-connector` surface is bound to app ID `hestia-connector`, publisher
ID `greenways-ai`, and the required capabilities `hestia/connect`,
`network/https`, `network/loopback`, and `storage/local`. A differently named,
attributed, or scoped manifest cannot alias it.

Resolving a launch is a two-step operation: resolve a normalized app by its
identifier, then derive a launch instruction from that catalog entry. Callers
must not dispatch a launch object copied directly from an untrusted message.

## Capability vocabulary

Capabilities describe the authority an integration needs; they do not grant it
by themselves. The current closed vocabulary is:

| Capability | Purpose |
| --- | --- |
| `identity/local` | Use the browser-held Greenways identity. |
| `storage/local` | Use Greenways local application storage. |
| `network/github` | Read explicitly selected public GitHub world material. |
| `network/loopback` | Contact an allowlisted service on the local machine. |
| `network/https` | Contact a user-approved remote HTTPS service origin. |
| `tabs/open` | Open an allowlisted destination in a browser tab. |
| `worlds/browse` | Browse Greenways Worlds. |
| `historia/import` | Ask the local Historia integration to collect history. |
| `hestia/connect` | Pair with a Hestia node under the connector's own consent flow. |
| `hara/evaluate` | Use the Hara playground's evaluation environment. |

A runtime handler must still enforce its own permissions and consent. A
manifest cannot mint a capability, enlarge a browser permission, or bypass the
Hestia and Historia pairing boundaries. Handler-specific capabilities are
mandatory: `web-tab` requires `tabs/open`; `native-hybrid` requires
`network/loopback` and `tabs/open`; and the Hestia packaged surface requires
`hestia/connect`, `network/https`, `network/loopback`, and `storage/local`.

## Built-in catalog

| App | Publisher | Version | Category | Launch | Notes |
| --- | --- | --- | --- | --- | --- |
| Greenways Home | `greenways-ai` | `0.2.0` | System | Packaged `src/studio.html#home` | Private local home, identity, projects, and receipts. Hestia actions route to the optional connector; Home performs no Hestia network effect. |
| Worlds | `greenways-ai` | `0.2.0` | System | Packaged `src/world.html` | World discovery and opening under the local kernel. |
| Historia | `greenways-ai` | `0.1.0` | Installable | Local `http://127.0.0.1:4319/` | Requires the separately installed **Historia local companion**. Failure to find it is an unavailable-app state, never a remote fallback. |
| Hestia Connector | `greenways-ai` | `0.2.0` | Installable | Packaged surface `hestia-connector` | Pairing and scoped access to loopback or HTTPS home nodes remain explicit. Disconnecting or removing it revokes its exact optional origin before deleting its credential. |
| Hara Playground | `hara-lang` | `0.1.0` | Installable | Web tab `https://playground.hara-lang.org/` | Runs as a normal web destination, not extension-loaded remote code. |

## Distribution boundary

The built-in catalog changes only with a reviewed Greenways OS package update.
A future signed app or service registry may distribute descriptions, versions,
receipts, and installation offers, but a registry record cannot extend this
runtime allowlist. A new execution handler, packaged surface, host, or capability
requires a local Greenways OS update and conformance coverage.

This keeps the extension a sovereign local kernel first. Users can add Historia,
Hestia, hosted playgrounds, collaboration, or later social services one by one,
and removing those integrations leaves the local home and its records intact.

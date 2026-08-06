# Greenways Package Manager protocol

Status: modular app draft  
Manager protocol: `greenways-package-manager/1`  
Package protocol: `greenways-package/1`

## Purpose

Greenways Package Manager projects the Hara-owned application lifecycle as an
explicit package model while retaining exact local approvals and Manifest V3's
remote-code boundary. Keyring and Package Manager are core host services. They
are not removable packages.

## Runtime approval compatibility

`greenways-app/1` remains the normative runtime approval record. For ordinary
apps it binds package ID, semantic version, publisher, exact capabilities, and
the locally shipped launch target. For `hal-module` it additionally binds the
exact lock digest. `greenways-package/1` is a read-only product projection of a
validated record; it cannot loosen validation or add executable fields.

## Package kinds

### `system`

A reviewed surface shipped with Greenways OS and restored with the kernel.
System IDs, publisher, target, and capabilities are bound together.

### `hal-module`

An optional or bundled `.hal` application installed from a digest-verified
`:lock/format 2` package graph. Its source is evaluated only by the browser-held
Hara kernel under an app-owned namespace generation. It receives no ambient
extension authority and renders through host-owned declarative surfaces.

### `bundled-module`

A reviewed integration whose implementation ships in the extension bundle. It
may be progressively represented as a `hal-module` with channel `bundled` so
system and third-party modules share one lifecycle.

### `companion`

A package that opens or coordinates with an explicitly disclosed local native
service. The extension cannot install or start the operating-system executable.

### `web-application`

An allowlisted ordinary website opened in a browser tab. It does not become
extension code and cannot use keyring capabilities without a separate bridge.

## Inventory projection

The package manager projects each catalogue entry with one status:

```text
installed
update-available
available
```

Release comparison uses SemVer only after registry signature verification. An
approval is current only when its approval identity matches. A newer index entry
never silently updates an installed package.

Module records also expose channel, source provenance, lock digest, active
namespace generation, and the last verification result. Preview records are
always visibly badged.

## Installation, reload, and removal

Installation records the exact manifest and verified package material using the
kernel's two-phase IndexedDB transition. The archive and lock are re-verified
before registration on every service-worker boot.

Reload stages and evaluates a fresh namespace generation, then swaps the active
generation. Failure leaves the prior generation active. Removal closes the app's
surface and deactivates its generation. Package-specific durable data is retained
unless a separate deletion operation is explicitly requested.

System packages cannot be removed through the optional package flow.

## Executable-code boundary

The following are inert package metadata and may be fetched after validation:

- IDs, versions, names, descriptions, categories, and capabilities;
- publisher records and signatures;
- content digests and sizes;
- compatibility and dependency descriptions;
- icons, documentation, schemas, prompts, and data-only resources; and
- closed release, preview, or bundled provenance descriptors.

The following cannot be installed as remote extension logic:

- JavaScript or TypeScript modules;
- arbitrary WebAssembly;
- HTML, CSS, or UI entrypoints;
- scripts, native commands, dynamic evaluators, or arbitrary URLs;
- host handlers, effects, browser permissions, native providers, or capability
  definitions supplied by a package.

The narrow exception is HAL source in a verified `.harp` graph, evaluated as
unprivileged data by the already-packaged Hara Wasm runtime. The container
rewrites it into an app-owned namespace generation, blocks protected/native
namespace references and dynamic evaluation in v1, and exposes host services
only through declared capabilities and fixed dispatch. HAL byte identity does
not grant extension privileges. A hash is necessary for reproducibility, never
sufficient for authority.

Executable browser modules and changes to the HAL container itself must arrive
in a reviewed Greenways OS build or a separately reviewed companion extension.

## Core-service relationship

Kernel, Store, Capability and Consent, Identity, Keyring, Package Lifecycle, and
Surface Host are resident authority boundaries. Their management screens may be
implemented as bundled HAL apps, but packages cannot replace those services,
make them removable, define capabilities, or add host effects. Receipt Journal,
Connector Broker, and Work Supervisor are reserved foundation services.

A package manifest may request closed capabilities such as `key/public`,
`key/sign`, `credential/manage`, `credential/use`, or `model/generate`.
Installation grants no ambient use of a controller or provider profile. Each
consequential operation requires a durable grant bound to the exact installed
app version, publisher, and lock digest under bounded constraints. Updating or
removing an app revokes its still-active grants so reinstall and rollback cannot
revive old authority.

The manifest, package, grant constraints, receipts, and app state may not contain
a secret. A System Keychain, DevTools, page-debugging, or browser-automation UI
can be an app, but it must use the resident Keyring and Connector Broker through
typed operations. Higher-risk native integration may require a separately
reviewed companion host; raw keys and provider credentials are never returned to
the HAL app. See `core-services.md`.

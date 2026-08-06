# Greenways Package Manager protocol

Status: first product projection  
Manager protocol: `greenways-package-manager/1`  
Package protocol: `greenways-package/1`

## Purpose

Greenways Package Manager is the second permanent Greenways OS product. It turns the existing Hara-owned application lifecycle into an explicit package model while retaining exact local approvals and Manifest V3’s executable-code boundary.

Keyring and Package Manager are core host services. They are not removable packages.

## Runtime approval compatibility

`greenways-app/1` remains the normative runtime approval record. It binds:

- package ID;
- semantic version;
- publisher identity;
- name and description;
- category;
- exact capability set;
- exact launch handler and packaged surface, path, or allowlisted URL;
- a disclosed native companion requirement where applicable.

`greenways-package/1` is a read-only product projection of that validated record. It does not loosen validation or add executable fields.

## Package kinds

### `system`

A reviewed surface that ships with Greenways OS and is restored with the kernel. System IDs, publisher, packaged path, and capabilities are bound together.

Current examples: Greenways Home and Worlds.

### `bundled-module`

An optional package whose implementation ships in the same reviewed extension but remains disabled until the user approves its manifest.

Current example: Hestia Connector.

### `companion`

A package that opens or coordinates with an explicitly disclosed local native service. The extension cannot install or start the operating-system executable.

Current example: Historia local companion.

### `web-application`

An allowlisted ordinary website opened in a browser tab. It does not become extension code and cannot use keyring capabilities unless a separate, exact website bridge is later approved.

Current example: Hara Playground.

## Inventory projection

The package manager projects each catalogue entry with one status:

```text
installed
update-available
available
```

An approval is current only when ID, version, publisher, launch handler/binding, and sorted capability set match the reviewed catalogue. A changed record requires explicit approval; an old approval cannot be silently widened.

## Installation and removal

Installation records the exact manifest in the profile-wide Hara state and IndexedDB package projection. It does not fetch executable code.

Removal disables the package and closes its active packaged surface. Package-specific durable data is retained unless a separate deletion operation is explicitly requested. Connector removal must revoke its exact optional origin permission before deleting its credential.

System packages cannot be removed through the optional package flow.

## Executable-code boundary

The following are inert package metadata and may be fetched after validation:

- IDs, versions, names, descriptions, categories;
- capability names;
- publisher records and signatures;
- content digests and sizes;
- compatibility and dependency descriptions;
- icons, documentation, schemas, prompts, and other data-only resources.

The following cannot be installed as remote extension logic:

- JavaScript or TypeScript modules;
- WebAssembly;
- HAL source or bytecode intended to extend the privileged extension host;
- HTML or UI entrypoints;
- scripts, evaluators, native commands, or arbitrary URLs.

Executable browser modules must arrive in a reviewed Greenways OS build or a separately reviewed companion extension. Hara package archives may be digest-verified for bounded Hara execution contexts, but a hash alone does not grant extension privileges or bypass the host capability vocabulary.

## Keyring relationship

A package manifest may eventually request capabilities such as:

```text
key/public
key/sign
model/generate
```

The manifest may not declare or contain a secret. Installation grants no ambient use of a controller or provider profile. Every operation remains subject to caller binding, user policy, context disclosure, limits, and audit receipts.

DevTools, page debugging, or arbitrary browser automation must not share secret storage merely because they appear as packages in one Greenways OS interface. Such capabilities may require an isolated companion extension speaking a typed Greenways module protocol.

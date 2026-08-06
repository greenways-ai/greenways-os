# Greenways Registry protocol

Status: draft  
Envelope protocol: `greenways-registry/1`  
Index payload protocol: `greenways-registry-index/1`

## Purpose

A Greenways registry publishes immutable package offers for release-channel HAL
modules. It is a distribution and provenance service, not a runtime authority.
It cannot add a handler, capability, browser permission, native provider,
effect, view element, or trusted key to Greenways OS merely by listing it.

The reference origins are:

```text
https://packages.hara-lang.org/
https://packages.greenways.ai/
```

Additional origins require a reviewed extension policy update.

## Signed envelope

`GET /v1/index.edn` returns an EDN envelope:

```clojure
{:registry/protocol "greenways-registry/1"
 :registry/key-id "greenways-packages-2026-01"
 :registry/algorithm "ES256"
 :registry/signed "<base64url exact UTF-8 index payload bytes>"
 :registry/signature "<base64url ECDSA P-256 SHA-256 signature>"}
```

The signature is over the exact decoded bytes in `:registry/signed`; no EDN
canonicalisation is performed by the verifier. `key-id` resolves only through a
locally pinned registry root or an already trusted keyring record. An envelope
cannot introduce its own trust anchor.

Signatures use Web Crypto `ECDSA` with named curve `P-256` and hash `SHA-256`.
The wire signature is a 64-byte P-256 `r || s` value, base64url encoded without
padding. A conformance fixture fixes this representation.

After signature verification, the decoded EDN payload must be:

```clojure
{:index/protocol "greenways-registry-index/1"
 :index/registry "https://packages.greenways.ai/"
 :index/generated-at "2026-08-06T00:00:00Z"
 :index/expires-at "2026-08-07T00:00:00Z"
 :index/packages
 {"greenways:notes"
  {:package/id "notes"
   :package/publisher
   {:publisher/id "greenways-ai"
    :publisher/name "Greenways AI"
    :publisher/key-id "greenways-ai-release-1"}
   :package/latest "1.2.0"
   :package/versions
   {"1.2.0"
    {:version "1.2.0"
     :lock/url "https://packages.greenways.ai/v1/packages/greenways:notes/1.2.0/lock.edn"
     :lock/sha256 "sha256:..."
     :app/manifest {...}
     :publisher/signature
     {:algorithm "ES256"
      :key-id "greenways-ai-release-1"
      :value "..."}}}}}}}
```

Unknown envelope, index, package, version, publisher, lock, and signature fields
are rejected. Index generation and expiry are checked against the host clock.
Expired indexes may describe already installed bytes for recovery but cannot
advertise an update or approve a new install.

## Publisher signature

Each version record is signed by the publisher over an exact binary payload
containing:

```text
registry-origin \0 coordinate \0 version \0 lock-sha256 \0 app-approval-identity
```

The approval identity is the deterministic UTF-8 JSON encoding of:

```text
id + version + publisher-id + sorted-capabilities + hal-module + lock-digest
```

The publisher key is resolved from a locally trusted keyring record or from a
publisher-key statement signed by the pinned registry root. Changing publisher
key, manifest approval identity, or lock digest invalidates the signature.

## Locks and archives

The reference static layout is:

```text
GET /v1/index.edn
GET /v1/packages/<coordinate>/<version>/lock.edn
GET /v1/packages/<coordinate>/<version>/<archive>.harp
```

A lock uses `:lock/format 2`. Its exact UTF-8 SHA-256 must equal the version
record and app manifest `lockDigest`. Every archive entry contains an HTTPS URL,
size, and SHA-256. V1 archive and lock URLs remain on the signed registry origin.

Every `.harp` archive contains `package.edn` with `:harp/format 1`, digest-declared
files, and a namespace-to-path resource map. An application package additionally
identifies one namespace-qualified view entry in `:greenways/app {:entry ...}`.
Dependencies may contribute resources but cannot replace the application entry
or declare host policy.

## Resolution

For a release install the client:

1. fetches and verifies the signed index envelope;
2. resolves the coordinate and exact requested version, or the signed `latest`;
3. verifies the publisher signature;
4. fetches the exact lock and verifies its digest;
5. fetches and verifies every `.harp` archive and file;
6. validates the `greenways-app/1` manifest;
7. presents publisher, version, capabilities, channel, and lock digest for
   approval; and
8. stages the module generation before the kernel commits the install record.

A network failure cannot fall back to an unsigned index, mutable URL, branch,
or cached record with a different digest.

## Update semantics

An index may advertise a newer SemVer. The package manager reports
`update-available` only after index and publisher verification. Updating requires
fresh approval whenever the lock digest, publisher, or capability set changes.
The extension never installs an update merely because it is semantically newer.

## Static publishing

The registry service may generate a static output directory containing the
signed envelope, locks, and archives. Static hosting must serve immutable
versioned paths with correct content types and must not transform bytes after
digest generation. Publishing is atomic: upload immutable artifacts first, then
replace the signed index envelope last.

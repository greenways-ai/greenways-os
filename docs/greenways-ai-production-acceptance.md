# Greenways AI production acceptance

Run this acceptance only after the tagged extension workflow has passed. Use a
fresh browser profile and a low-budget, revocable OpenAI credential. Never put
the credential in this repository, an issue, a workflow input, or the result
record.

## Install the published artifact

1. Download the extension ZIP, checksum, and metadata from the same GitHub
   release.
2. Verify the SHA-256 checksum and confirm the metadata source commit is the
   tagged commit.
3. Extract the ZIP and load that directory as an unpacked extension. Do not use
   a development checkout for this acceptance.

## Exercise and revoke authority

1. Open `https://playground.hara-lang.org` and install or update its approval
   in Greenways OS.
2. Create a session-only OpenAI provider profile.
3. Grant `model/generate` and approve only the OpenAI provider network origin.
4. In the Greenways AI sample, verify `(ai/status)` and one successful,
   low-token `(ai/generate ...)` response.
5. Revoke the `model/generate` grant and confirm the next request is denied.
6. Clear the provider session and confirm that the profile is unavailable.

## Inspect secret boundaries

Inspect page and worker messages, console output, extension storage,
`localStorage`, IndexedDB, and receipts. The credential and provider
authorization header must remain inside Keyring and must not appear in any of
those projections.

Record only the release tag, artifact checksum, source commit, browser version,
provider/model identifiers, timestamps, normalized success/denial outcomes,
and the result of each secret-boundary inspection. Redact response text and all
credential-like values.

After validation, a maintainer may create the GitHub release from the three
downloaded workflow artifacts. The workflow deliberately has read-only
repository permissions and cannot publish a release itself.

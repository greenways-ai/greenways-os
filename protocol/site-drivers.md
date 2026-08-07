# Greenways OS site-driver protocol

Status: first foreground browser-driver implementation  
Driver protocol: `greenways-site-driver/1`  
Request protocol: `greenways-site-driver-request/1`  
Result protocol: `greenways-site-driver-result/1`

## Purpose

A **site driver** is a reviewed, origin-specific browser adaptor that operates an
interactive website through the user's existing signed-in browser session. It is
closer to a Greasemonkey userscript than to a remote API connector, but it runs
behind a typed Greenways host boundary rather than receiving arbitrary page or
network authority.

The first driver targets Tripo Studio so Greenways users can generate models
with their existing Studio subscription and Studio credits instead of purchasing
separate Tripo API access.

```text
Greenways Model Forge
        │ typed operation + explicit foreground confirmation
        ▼
Greenways site-driver broker
        │ exact tab, exact origin, reviewed content bundle
        ▼
Tripo Studio Generate Model page
        │ normal visible UI action
        ▼
User's existing Tripo Studio session and Studio credits
```

The implementation does not hold a Tripo API key, read authentication cookies,
call undocumented Tripo endpoints, inspect network traffic, solve challenges, or
operate hidden background tabs.

## First driver

```text
id              tripo-studio
origin          https://studio.tripo3d.ai
route           /workspace/generate
content bundle  dist/tripo-studio-content.js
```

The page probe recognises semantic UI anchors rather than generated CSS class
names:

```text
Generate Model
General Settings
Geometry & Texture
visible text-entry control
visible Generate Model button
```

If the origin, route, or required controls do not match, the driver reports a
bounded `wrong-route`, `logged-out`, `degraded`, or `incompatible` result and
stops. It never guesses a screen coordinate or clicks a positional control.

## Public operations

The root Model Forge workspace may ask the broker for only:

```text
attach
status
stage-prompt
review
submit
observe
detach
```

The injected Tripo content driver accepts only:

```text
probe
stage-prompt
review
submit
observe
detach
```

There is deliberately no operation for arbitrary JavaScript, HTTP, cookies,
local storage, page HTML, selectors, screenshots, downloads, or general DOM
queries.

## Attachment

Attachment requires all of the following:

1. The user grants optional host access for `https://studio.tripo3d.ai/*`.
2. Model Forge selects an ordinary non-incognito browser tab.
3. The tab URL has the exact Tripo origin and supported Generate Model route.
4. Greenways injects the packaged, reviewed content bundle through
   `chrome.scripting`.
5. The driver probe returns a recognised bounded state.

The attachment record is stored in `chrome.storage.session`. It contains the tab
ID, exact URL, attachment time, staged prompt root, and recently submitted
Greenways request IDs. It contains no prompt text, page HTML, cookies, provider
credentials, or Tripo account data.

## Staging and prompt identity

A prompt is bounded to 4,000 characters and receives a canonical root over:

```json
{
  "protocol": "greenways-site-driver-staged-prompt/1",
  "driverId": "tripo-studio",
  "requestId": "site-request/...",
  "prompt": "..."
}
```

The page driver writes the prompt using ordinary input semantics, reads it back,
and recomputes the same root. Model Forge cannot review or submit the request if
Tripo changed, truncated, or otherwise failed to retain that exact value.

## Review and one-shot confirmation

`review` re-reads the prompt and visible Generate Model control. When the staged
root still matches and the button is available, the broker issues a short-lived,
in-memory confirmation token for that exact request and prompt root.

The token:

- is created only after a foreground review;
- expires after two minutes;
- is never stored in `chrome.storage.session`;
- is bound to one driver, one request ID, and one prompt root; and
- is consumed by one `submit` operation.

The visible **Generate once** action in Model Forge is the user confirmation.
There is no unattended batch mode.

## Duplicate prevention

Duplicate submission is blocked at two independent layers:

1. The broker persists recently submitted Greenways request IDs in session
   storage.
2. The content driver keeps an in-page set of submitted request IDs.

A browser or extension restart can reinject the content driver and continue
observation, but the broker will not submit a previously recorded request ID
again. Navigation to another origin or route invalidates the attachment rather
than creating a replacement generation.

## Observation

Observation is a bounded projection derived from visible status, progress, and
result controls:

```json
{
  "protocol": "greenways-site-driver-result/1",
  "driverId": "tripo-studio",
  "operation": "observe",
  "requestId": "site-request/...",
  "state": "running",
  "message": "Tripo Studio generation is 42% complete.",
  "progress": 42
}
```

The driver may report:

```text
ready
submitted
running
completed
failed
```

It does not return the page body, unrelated gallery contents, account metadata,
network responses, model bytes, or authentication state. Model Forge polls only
while its foreground page is open.

## Export boundary

The first slice leaves model inspection and export inside Tripo Studio. Greenways
focuses the attached tab when the result is available. A later slice may import a
user-selected exported GLB into Greenways, hash it locally, and attach it to a
signed workflow receipt. It must not bypass Tripo's visible export controls.

## Permission boundary

The extension adds the Manifest V3 `scripting` permission. That permission alone
does not grant access to Tripo or any other website. Host access remains optional
and is requested by Model Forge for the exact Tripo origin after a user gesture.

The driver does not request:

```text
cookies
debugger
tabs
webRequest
```

The existing optional HTTPS vocabulary remains available to other reviewed
Greenways connectors, but the Tripo driver itself asks for one exact origin.

## Current product placement

Model Forge is a bundled root workspace for this first browser-driver slice. The
site-driver broker is generic and the Tripo implementation is a separate adaptor
module. Once HAL module calls have exact caller binding for site operations, the
replaceable Model Forge interface can move into a signed `.hal` package while the
origin, injection, confirmation, and duplicate-prevention authority remains in
the reviewed host.

## Security laws

1. A driver is bound to one reviewed ID, origin, route set, and packaged content
   bundle.
2. Optional host permission is granted by the user before attachment.
3. A driver exposes typed operations, never arbitrary DOM or network authority.
4. Prompt staging is verified by a canonical root after the page accepts it.
5. Submission requires a fresh one-shot foreground confirmation.
6. One Greenways request ID cannot create two Tripo generations.
7. Driver state contains bounded workflow metadata, never browser credentials.
8. Failure to recognise the current page stops the operation.
9. Observation returns a bounded status projection, not page contents.
10. Generation and export remain visible operations in the user's own Tripo
    Studio session.

# Greenways OS AI capability

Status: initial design slice

## Purpose

Expose AI providers through Greenways OS without exposing provider credentials to applications.

## Boundary

```text
Application
    |
    | typed capability request
    v
Greenways OS capability broker
    |
    v
AI service
    |
    v
Keyring provider profile
    |
    v
Provider API
```

## Operations

Initial operations:

- `model/list`
- `model/generate`
- `model/cancel`

Applications receive capability grants, never API keys.

## Security requirements

- provider credentials remain keyring-owned;
- requests include caller identity and limits;
- arbitrary HTTP forwarding is forbidden;
- receipts should record AI operations.

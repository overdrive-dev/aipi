---
type: environment
owner: devops
status: draft
last_reviewed: -
---

# Environment

## Current truth

No environment facts have been confirmed yet.

Never store secret values here. Store credential locations, access paths,
validation commands, and deployment boundaries.

## Details

### Local

- Start command:
- Health check:
- Test command:

### Staging / homolog

- URL:
- Deploy command:
- Smoke check:

### Production

- URL:
- Deploy command:
- Approval requirement:
- Rollback:

### Credentials

- Anthropic OAuth sidecar: `~/.pi/agent/anthropic-auth.json`
- Anthropic OAuth sidecar override: `PI_ANTHROPIC_AUTH_FILE`
- Login command: `/login anthropic`
- Location only:

## Open questions

- Which commands are safe for builder role?
- Which commands require devops role and approval?

## Timeline

- created: Seeded by `aipi` project template.

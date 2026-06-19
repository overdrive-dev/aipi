---
type: deployment
owner: devops
status: draft
last_reviewed: -
---

# Deployment

## Current truth

No deployment path has been confirmed yet.

Production actions are policy-gated inside the Pi process. Shell access is not
approval.

Until the Pi `tool_call` policy layer exists, deployment and production files
are advisory planning artifacts only. They do not block commands by themselves.

After the `tool_call` policy layer exists, the gate is still a soft in-process
policy check, not a sandbox. Real production safety requires external
containment, least-privilege credentials, and reviewed approval artifacts.

## Details

### Homolog / staging

- Environment:
- Command:
- Evidence required:

### Production

- Environment:
- Command:
- Approval:
- Containment:
- Credential scope:
- Rollback:
- Smoke check:

## Open questions

- What is the production approval record format?

## Timeline

- created: Seeded by `aipi` project template.

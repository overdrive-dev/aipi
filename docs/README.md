# aipi docs

Design, decision, and review documents. Start with the root
[`README.md`](../README.md) for the overview.

## Architecture and decisions

- [`pi-subagent-build-plan.md`](pi-subagent-build-plan.md) — the subagent
  coordinator design: backend (`aipi-agent-session`, in-process), adapter, modules,
  owned-file enforcement, state/resume, spike criteria, milestones.
- [`probe-a-prime-in-process-enforcement.md`](probe-a-prime-in-process-enforcement.md)
  — **current** criterion-zero result: in-process enforcement via tool wrapping is
  viable (verified against Pi 0.75.5; worker toolset re-checked against Pi
  0.79.5).
- [`probe-a-tool-call-attribution.md`](probe-a-tool-call-attribution.md) — the
  earlier Probe A (host-hook attribution `FAIL`) and its **corrected**
  interpretation. Superseded by Probe A′.
- [`pi-swarm-package-evaluation.md`](pi-swarm-package-evaluation.md) — build vs
  borrow for the swarm backend; real Pi swarm packages as references.
- [`pi-runtime-gates-hooks-map.md`](pi-runtime-gates-hooks-map.md) — mapping of
  AIPI gates to real Pi extension events, and what the runtime must add.
- [`pre-adversarial-completion-plan.md`](pre-adversarial-completion-plan.md) -
  prioritized completion backlog for the next adversarial review.
- [`release-checklist.md`](release-checklist.md) - release candidate checks:
  tests, pack dry-run, audit, and optional live smoke.

## Integration

- [`installation.md`](installation.md) - step-by-step install guide for exposing
  the `aipi` command and starting interactive Pi sessions through AIPI.
- [`aipi-cli-wrapper.md`](aipi-cli-wrapper.md) — the `aipi` CLI that launches Pi
  with the AIPI extensions preloaded.
- [`mcp.md`](mcp.md) - optional stdio MCP bridge configuration, Linear through
  `mcp-remote`, and current MCP scope limits.
- [`anthropic-auth-integration.md`](anthropic-auth-integration.md) — the
  OAuth-only wrapper over the pinned `@ersintarhan/pi-toolkit` Claude OAuth
  adapter and `/login anthropic` flow.

## Port history (how the design was derived)

- [`aihaus-flow-pkg-port-plan.md`](aihaus-flow-pkg-port-plan.md) — porting the
  aihaus-flow system into a Pi-native AIPI.
- [`aipi-agent-workflow-port.md`](aipi-agent-workflow-port.md) — the first
  agent/workflow port.
- [`fable-skills-structure-review.md`](fable-skills-structure-review.md) — the
  behavioral-discipline layer, adapted from fable-skills.
- [`ponytail-review-embedding.md`](ponytail-review-embedding.md) — the
  complexity-only review lane, adapted from Ponytail.

## Review

- [`../adversarial-claude.md`](../adversarial-claude.md) — the full adversarial
  review history.
- [`adversarial-remediation.md`](adversarial-remediation.md) — log of changes
  applied in response to the review.

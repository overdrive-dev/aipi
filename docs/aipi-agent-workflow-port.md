# aipi agent and workflow port

This document records the first agent/workflow port from
`C:\Users\vctrs\OneDrive\Documents\GitHub\aihaus-flow\pkg`.

## What was ported

The aihaus system that works well is not copied verbatim. The useful behavior
was converted into Pi-neutral `aipi` templates:

- `templates/.aipi/agents/catalog.yaml`
- `templates/.aipi/model-classes.yaml`
- `templates/.aipi/workflows/planning.yaml`
- `templates/.aipi/workflows/quick.yaml`
- `templates/.aipi/workflows/feature.yaml`
- `templates/.aipi/workflows/bugfix.yaml`
- `templates/.aipi/workflows/research.yaml`
- `templates/.aipi/workflows/ops.yaml`
- `templates/.aipi/protocols/*.md`
- `templates/.aipi/memory/project/*.md`
- `templates/.aipi/disciplines/*.md`
- `templates/.aipi/evals/*.md`

The memory port follows the Markdown brain rule: `.aipi/memory/**/*.md` is the
reviewable source of truth, while `.aipi/state/aipi-graph.json` and
`.aipi/state/aipi-graph.sqlite` are generated graph/search/vector indexes that
can be rebuilt from the repo, memory files, run artifacts, and Git history.

The Fable skills review added a separate behavioral-discipline layer. Workflows
decide the process, agents execute roles, and disciplines constrain behavior at
lifecycle moments such as exploration, editing, claims, state changes, and final
reporting.

The Ponytail review pass added a complexity-only review lane. It is separate
from correctness, security, and integration review so the swarm can ask "what
can we delete?" without diluting bug/risk findings.

## Source references used

From aihaus agents:

- workflow routing and gates: `workflow-orchestrator`, `workflow-intake`,
  `workflow-planning-gate`, `workflow-tdd-gate`, `workflow-execution-review`,
  `workflow-test-gate`, `workflow-cicd`, `workflow-dev-reviewer`,
  `workflow-human-review`
- business and planning: `project-business-interviewer`, `plan-checker`,
  `plan-calibrator`, `contrarian`
- research and context: `project-researcher`, `phase-researcher`,
  `codebase-mapper`, `context-curator`
- implementation and review: `implementer`, `frontend-dev`, `test-writer`,
  `code-fixer`, `code-reviewer`, `integration-checker`, `security-auditor`,
  `verifier`
- memory: `knowledge-curator`, `user-profiler`

New aipi-native agents:

- `bdd-orchestrator`: stronger version of `workflow-orchestrator` that owns the
  active BDD contract and runtime loop.
- `requirements-analyst`: formalizes user intent into BDD scenarios.
- `business-rule-keeper`: applies the covered/gap/conflict/mechanics rule.
- `blast-radius`: combines aihaus impact analysis, integration checking, and
  aih-graph style caller/impact lookup.

## Key adaptation

aihaus is Claude Code-first. `aipi` should be Pi-native. The port therefore
keeps:

- BDD business-rule gates
- staged workflow semantics
- single-writer memory promotion
- swarm review/research pressure
- owned-file parallelism
- flow-gated deployment planning

The port removes direct dependency on:

- `.claude/settings.local.json`
- Claude Code hook names
- Claude-only tools such as `Agent`, `TaskCreate`, `TaskUpdate`, `ExitPlanMode`
- hardcoded model names in agent prompts

## Runtime implication

The next implementation step is the Pi extension that reads these templates and
provides:

- `aipi_spawn_agent`
- `aipi_memory_query`
- `aipi_rule_lookup`
- `aipi_rule_gap`
- `aipi_impact`
- `aipi_retrieve`
- `aipi_callers`
- `aipi_kanban_update`
- `aipi_promote_memory`

Until that runtime exists, these files are the product specification for how the
orchestrator and swarm should behave. Runtime enforcement starts only when the
Pi extension implements the hooks and tools described in the protocols.

# aipi Routing Protocol

Natural-language requests enter `aipi` through the `bdd-orchestrator`. Slash
commands are deterministic overrides, but normal use should not require the
client to know workflow names.

## Entry Behavior

1. Detect whether an active run exists.
2. If the user is answering a blocker, saying continue, or responding to a run
   artifact, continue that run.
3. Otherwise classify the request into the runtime-supported buckets: quick,
   planning, feature, bugfix, research, ops, active-run review, or no-workflow.
4. Route to the selected workflow.
5. Preserve mandatory gates by routing into workflows that carry BDD checks.

## Enforcement Status

- `tool_enforced`: blocker answers are recorded to the active run before resume.
- `runtime_gate`: natural-language routing selects the workflow command and can
  continue or resume active runs.
- `prompt_only`: "Routing never skips BDD coverage" and "FEATURE after contract
  acceptance" mean the route must enter the workflow gate that verifies the
  accepted BDD contract. Until dispatch has a deterministic accepted-contract
  precondition, feature routing must not be described as proof that BDD coverage
  was already checked.

## No-Workflow Path

Use no-workflow only for simple answers, explanation, small command output,
quick clarification, or explicit user instruction to avoid workflow routing.

## Route Catalog

- `BACKLOG_INTAKE` -> `aipi-planning` beginning at its `intake` step
- `QUICK` -> `aipi-quick`
- `PLANNING` -> `aipi-planning`
- `FEATURE` -> `aipi-feature` contract-check gate
- `BUGFIX` -> `aipi-bugfix`
- `RESEARCH` -> `aipi-research`
- `OPS` -> `aipi-ops`
- `REVIEW` -> review swarm inside the relevant active workflow; without an
  active workflow, review/adversarial wording routes to planning rather than a
  standalone review swarm.
- `CONTINUE_ACTIVE_WORKFLOW` -> current run
- `NO_WORKFLOW` -> inline answer

No automatic `workflow_design` route exists in the current runtime. Workflow
design requests should use planning or an explicit slash-command path until a
dedicated workflow-design target is implemented.

## Invariants

- Higher-risk routes win when intent overlaps.
- A blocker answer is recorded to the active run's `USER-INPUT.jsonl` before the
  blocked step is resumed.
- Planning wins over implementation when business meaning is unclear.
- Bugfix wins over feature when the request is about broken existing behavior.
- Ops routes are policy-gated, even for read/write shell access.
- Quick routes are allowed only for low-risk changes with small owned-file sets
  and existing rule/mechanics coverage.
- Business-rule gaps return to the user in business language, one focused
  question at a time.

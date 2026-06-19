# aipi Workflow Contract Protocol

This file is the executable contract that workflows, agents, gates, and run
artifacts must follow. The package now has init, status, and run-state
scaffolding, but workflow step execution and gate enforcement are still runtime
work. Templates must not claim runtime enforcement where only prompt
instructions exist.

## Canonical Vocabulary

The machine-readable registry is `.aipi/runtime-contract.json`.

- Stages must use the canonical English ids from `canonicalStages`.
- Deprecated aliases such as `entendimento`, `planejamento`, and
  `review-execucao` are documentation-only compatibility notes.
- Gates must use `PASS`, `FAIL`, `SKIPPED`, `BLOCKED`, or
  `BLOCKED_TO_PLANNING`.
- Workflow decision gates must also use `ALLOW`, `BLOCK`, or
  `HUMAN_REVIEW_REQUIRED`.

## Step Result

Every workflow step must produce a structured step result:

```json
{
  "schema": "aipi.step-result.v1",
  "step_id": "local_verification",
  "agent_ids": ["workflow-test-gate"],
  "verdict": "PASS",
  "evidence": [
    {
      "rung": "verified",
      "source": "command",
      "ref": "npm test",
      "result": "exit 0"
    }
  ],
  "artifacts": [
    ".aipi/runtime/runs/20260615-abc123/steps/local_verification/TEST-GATE.md"
  ],
  "memory_candidates": []
}
```

Regex over prose is not a gate. A markdown artifact may explain the result, but
the runtime branches on the structured result.

## Gate Semantics

- `PASS` continues.
- `FAIL` stops or follows `on_verdict.FAIL`.
- `BLOCKED` stops until the blocker is resolved.
- `BLOCKED_TO_PLANNING` returns to the planning or rule-check stage.
- `SKIPPED` continues only when the step declares `allow_skip: true`.
- `HUMAN_REVIEW_REQUIRED` stops the workflow at a human-review boundary. It is
  not a parent-session tool-call permission gate.

For testable claims, command exit code evidence outranks written analysis. A
step can claim only the strongest evidence rung it actually reached.

Terminal branch actions are registered in `.aipi/runtime-contract.json` under
`terminalActions`. Branch targets must be either a step id in the same workflow
or one of those registered terminal actions.

Skip reasons are registered in `.aipi/runtime-contract.json` under
`skipConditions`. `SKIPPED` is valid only when the step declares `allow_skip:
true`, names a registered `skip_requires` token, and attaches the required
evidence.

## Loop And Branching

Workflows are allowed to be DAG-shaped, but the schema must express branch
behavior explicitly:

- `on_verdict.FAIL`
- `on_verdict.BLOCKED`
- `on_verdict.BLOCKED_TO_PLANNING`
- `retry.max`
- `retry.backoff`

If a loop is orchestrator-driven rather than YAML-driven, the workflow must say
so in the step gate.

Every workflow also inherits run-level loop limits from
`.aipi/runtime-contract.json`:

- `maxTotalStepVisits`
- `maxVisitsPerStep`
- `maxConsecutiveFailures`
- `onExhaustion`

When a limit is exhausted, the runtime follows `onExhaustion` and records a
blocked run-state event.

## Run IDs And Artifacts

The runtime allocates a unique `run_id` before workflow execution. Templates must
not write to `runs/active` except as a read-only pointer created by the runtime.

Run artifacts are namespaced by step:

```text
.aipi/runtime/runs/{{ run_id }}/steps/{{ step_id }}/ARTIFACT.md
```

Shared files such as `RUN-MANIFEST.md` and `BDD-CONTRACT.md` are single-writer
surfaces owned by the orchestrator. Workflow steps may request those writes via
`controller_updates`, but spawned agents must not list shared files under
`produces`.

## Context Materialization

`context_from` references prior step ids, not raw transcript chunks. The runtime
materializes context in this order:

1. structured step result summary;
2. declared artifact paths and verdicts;
3. bounded excerpts selected by `context-curator`;
4. related memory/code graph references.

If a referenced step is missing, or a declared artifact was not written and not
explicitly skipped, the consuming step must fail before model execution.

## Enforcement Status

Each protocol invariant is one of:

- `prompt_only`: documented, not enforced yet.
- `runtime_gate`: enforced by a Pi extension event.
- `tool_enforced`: blocked before the tool executes.

The parent-session permission policy layer was intentionally removed. Workflow
gates can still stop workflow execution, but they do not block normal
interactive source edits. Cross-owned-file writes inside parallel workers remain
guarded by worker owned-file tools for workflow correctness.

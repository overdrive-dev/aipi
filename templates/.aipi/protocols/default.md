# aipi Default Workflow Profile

`aipi` is a BDD-contract runtime specification. The client owns business rules
and accepted behavior. After the Pi extension exists, the orchestrator and swarm
own technical execution when the contract is sufficient.

Runtime vocabulary, verdicts, and artifact rules are defined in
`.aipi/runtime-contract.json`.

## Stages

| Stage | Purpose | Exit Gate |
|---|---|---|
| init | Inventory repository structure and seed project memory. | Project memory seed is created or setup blocker is recorded. |
| backlog | Capture backlog-ready work without starting implementation. | Item has intent, owner/status, and next workflow hint. |
| intake | Capture the request and decide if workflow value exists. | Intent is classified or no-workflow is selected. |
| requirements | Understand the business-visible ask. | No open question remains about what is being asked. |
| rule-check | Classify business-visible choices as covered, gap, conflict, or mechanics. | Gaps/conflicts return to the user; covered/mechanics can proceed. |
| planning | Pin rules, constraints, acceptance criteria, and risks. | BDD contract is accepted or a focused blocker is recorded. |
| research | Gather internal or external evidence needed for a decision. | Claims are cited or assumptions/blockers are explicit. |
| context | Build the smallest useful context packet for the next agent. | Referenced memory, files, and artifacts are listed. |
| tdd | Convert accepted scenarios into failing tests/contracts. | Tests/contracts fail for expected reason or an explicit TDD waiver is recorded. |
| implementation-plan | Map code, tests, context, owned files, and blast radius before edits. | Owned-file and context packet are ready. |
| implementation | Change code under owned-file scope. | Implementation claims the accepted scenarios it satisfies. |
| execution-review | Check implementation readiness before broader verification. | Readiness findings are fixed, waived, or returned to planning. |
| local-verification | Run local checks, builds, unit tests, and UI smoke when applicable. | Relevant local checks pass or blocker is explicit. |
| blast-radius | Inspect affected call sites, tests, rules, and deployment risk. | Impact is mapped and needed review agents are selected. |
| review | Run adversarial, code, security, and integration review. | Findings are fixed, waived with reason, or returned to planning. |
| fix | Apply bounded fixes from review or failed verification. | Fix evidence is recorded or scope returns to planning. |
| tests | Run broader regression checks. | Evidence is sufficient for the change type. |
| final-verification | Verify accepted scenarios and artifacts before completion. | Required evidence rung is reached or the run fails/blocks. |
| deployment-plan | Prepare deployment, smoke, rollback, and homolog suggestions. | Advisory package exists; execution waits for policy. |
| homolog | Validate published staging/homolog behavior when configured. | Browser/E2E evidence exists for UI/flow work or skip is justified. |
| human-review | Package business evidence for human approval. | Human accepts, rejects, or asks for a business-rule change. |
| prod | Production promotion when role/workflow policy allows. | Promotion evidence and rollback notes are recorded. |
| ops | Classify operational boundaries and policy decisions. | Action is allowed, blocked, or waiting for approval. |
| memory-promotion | Persist reusable lessons. | Durable memory is promoted, deferred, or no-signal is recorded. |

## Gate Semantics

- `PASS`: evidence is sufficient.
- `FAIL`: evidence shows the step did not satisfy the contract.
- `SKIPPED`: valid only when the step declares `allow_skip: true`, names a
  registered `skip_requires` token, includes `SKIPPED` in `pass_verdicts`, and
  attaches the evidence required by `.aipi/runtime-contract.json`.
- `BLOCKED_TO_PLANNING`: missing or failed business expectation; return to BDD.
- `BLOCKED`: operational blocker prevents progress.

Markdown prose is not a gate. Workflow steps emit `aipi.step-result.v1`, and
the runtime branches on that structured result.

## Autonomy Rule

After a BDD contract is accepted and runtime gates are available, technical
execution continues autonomously. The orchestrator asks the user only for
business-rule gaps, business-rule conflicts, unverifiable acceptance criteria,
or policy-gated production/security actions.

## Swarm Rule

Swarm agents apply pressure to the contract. They may research, challenge,
implement, review, and suggest deployment paths, but they do not override the
accepted business rules.

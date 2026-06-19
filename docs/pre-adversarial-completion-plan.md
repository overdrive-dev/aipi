# AIPI pre-adversarial completion plan

Audience: AIPI runtime implementers and adversarial reviewers.

Post-read action: use this plan as the target for the next adversarial review.
The reviewer should attack priority, missing runtime boundaries, false readiness
claims, and any gap that prevents AIPI from running business-contract-first
workflows autonomously.

## Current Baseline

AIPI is an alpha Pi package with these working surfaces:

- CLI wrapper that launches Pi with AIPI extensions preloaded.
- Project initialization that installs the AIPI overlay and protects project
  memory during normal forced updates.
- Status command that checks project install, pinned Anthropic auth, sidecar
  readiness, subagent backend posture, and a capability report split into
  `verified`, `wired`, and `specification`, plus a readiness report that
  separates local blockers from external evidence gaps. The same report is
  available outside an interactive Pi session through `aipi status` /
  `aipi doctor`.
- Workflow run-state scaffolding: list workflows, create a run id, write a run
  manifest, and maintain the active-run pointer.
- Workflow executor slice: `quick`, `feature`, `bugfix`, `planning`,
  `research`, and `ops` can run through workflow YAML with structured gates,
  required-artifact checks, run-limit enforcement, executor-owned declared
  artifact writes, context packets, optional skip gates, branch targets, and
  persisted policy decisions. `quick_change` can use the S0 guarded-worker
  handoff when invoked from the Pi extension.
- Runtime contract, agent catalog, workflow YAML, model classes, protocols, and
  memory templates validated by the template validator.
- Step-result validation for `aipi.step-result.v1`.
- Owned-file registry and worker-local guarded `write`.
- Probe A and Probe A prime documenting the Pi child-session attribution result
  and the selected in-process enforcement primitive.
- S0/S1 subagent backend: spawned Pi `AgentSession` workers can run with
  read-only tools plus guarded `write`, return validated step result JSON, and
  participate in configured fan-out/reconciliation steps such as `review_swarm`.
  Budget timeouts and coordinator lifecycle events are persisted as session
  entries.
- Parent-session permission policy: removed by product decision. `tool_call`
  no longer blocks normal interactive source edits through profile/stage
  approval gates; workflow gates still control workflow execution and worker
  owned-file guards still protect parallel assignments.
- Lifecycle hook shell: session transition hooks preserve active run handoff
  artifacts, `session_start` restores the latest subagent snapshot as
  interrupted work, `before_agent_start` injects compact AIPI context pointers,
  `input` routes recognized natural-language workflow intents, records
  blocker answers to `USER-INPUT.jsonl`, resumes the blocked step with that
  input in the next context packet, `context` prunes duplicate pointers and
  older AIPI tool output, `user_bash` is observed without permission-policy
  blocking,
  `before_provider_request` redacts obvious provider payload secrets,
  `session_before_compact` provides AIPI compaction summaries, and
  tool/provider hooks write redacted evidence logs.
- P2 context builder: context packets cite BDD contracts, prior step result
  summaries, bounded artifact excerpts, Markdown memory refs, graph status, and
  provenance.
- P3 AIPI tools: memory query, rule lookup/gap, SQLite-backed callers/impact
  with lexical fallback, kanban events, and approval-gated memory promotion are
  registered runtime tools.

Claim evidence anchors for the live runtime surfaces are `test:workflow-executor`,
`test:fake-provider-workflows`, `test:workflow-fixtures`, `test:aipi-tools`,
`test:permission-removal`, `test:lifecycle-hooks`,
`test:subagents`, `test:subagents-real-sdk`, and
`test:adversarial-readiness`.

This is enough to prove the first vertical runtime loop across workflow,
context, policy, tools, worker handoff, fan-out, and memory candidate handling.
It is not enough to claim unattended production autonomy.

## Completion Definition

AIPI is ready for a serious user-facing beta when it can:

1. Accept or locate a BDD contract and start the correct workflow.
2. Execute workflow steps, not just create run state.
3. Materialize bounded context from prior step results, artifacts, memory, and
   code relationships.
4. Resolve agent model classes to configured provider/model choices.
5. Spawn session workers where appropriate and keep shared state single-writer.
6. Enforce policy gates for writes, shell, secrets, production, and approval.
7. Promote durable memory through orchestrator-owned writes.
8. Survive compaction or restart without losing the active run contract.
9. Produce verification evidence that a fresh reviewer can audit.

## Missing Work By Priority

### P0 - Truthful Runtime Posture

Goal: prevent the package from claiming runtime enforcement that is still only a
contract.

Work:

- Normalize all status text into three states: specification, wired, verified.
- Add a runtime capability report used by status, tests, and docs.
- Make every advertised command identify which capabilities are live.
- Keep ops/deploy wording advisory until policy gates exist.

Acceptance:

- Status output cannot say a workflow, hook, policy, or memory surface is live
  unless there is a current test or live probe for it. The current status report
  uses `extensions/aipi/runtime/capabilities.js`.
- Validator fails on stale "fully autonomous" wording before the runtime earns
  it.

### P1 - Workflow Executor Plus Minimum Controller Policy Gate

Goal: turn workflow YAML into real staged execution without letting the
controller become less guarded than the workers it dispatches.

Work:

- Parse workflow definitions into an execution graph.
- Load or create active run state.
- Move steps through pending, running, passed, failed, blocked, skipped.
- Execute controller and session runtime agents through the quick-slice adapter.
- Keep executor-owned controller artifact writes limited to declared workflow
  outputs. The parent-session permission profile gate was removed by product
  decision and must not be treated as an active guard.
- Validate every produced step result with the step gate.
- Enforce branch targets, terminal actions, retry limits, skip conditions, and
  run-level loop limits.
- Detect declared artifacts that were not produced.

Acceptance:

- A fixture workflow can run from first step to terminal state.
- FAIL, BLOCKED, BLOCKED_TO_PLANNING, SKIPPED, and policy decisions branch as
  declared.
- A missing required artifact fails before downstream context is materialized.
- Controller write/edit/bash/memory actions hit the parent-session
  profile/stage/action gate, and policy decisions are persisted.

### P2 - Context Builder

Goal: give each step and subagent only the references needed for its contract.

Work:

- Build context packets from the accepted BDD contract, prior structured step
  results, bounded artifact excerpts, relevant project memory, and code
  relationship lookups.
- Implement `context_from` materialization in the documented order.
- Track context provenance so reviewers know what a worker actually saw.
- Fail closed when required context is unavailable or stale.

Acceptance:

- Each spawned worker receives a context packet with source references.
- Context packets are bounded and reproducible from run state.
- If a workflow references an unknown prior step or missing artifact, execution
  blocks before model work.

### P3 - AIPI Tool Surface

Goal: implement the custom tools that workflows and agents already reference.

Work:

- Memory tools: query, promote, and report stale index state.
- Rule tools: lookup, gap/conflict classification, and rule proposal output.
- Code graph tools: callers, impact, symbol/file relationship lookup.
- Kanban/run tools: update task status and append run events.
- Tool result shape: all tools return structured, auditable output.

Acceptance:

- Agent catalog contains no referenced AIPI tool that is missing at runtime,
  unless it is explicitly marked specification-only. The current contract has no
  catalog-referenced `aipi_*` tools left in `specificationOnly`.
- Durable memory tools enforce orchestrator-only writes.
- Query tools cite source Markdown or source code references, not opaque model
  assertions.

### P4 - Model Router

Goal: make model classes real provider-agnostic routing, not catalog prose.

Work:

- Load model class policy.
- Inspect configured Pi providers and models.
- Resolve class, provider family, thinking level, and fallback policy.
- Pass resolved model and thinking level into worker sessions from explicit
  `AIPI_MODEL_CLASS_<CLASS>` overrides, `.aipi/model-capabilities.json` class
  mappings, or current Pi context when no class mapping is configured.
- Detect manual model drift from the active agent class. Implemented for Pi
  `model_select` / `thinking_level_select`: the hook resolves from explicit
  `model_class`, explicit `agent_id`, or active workflow step and records
  drift/unresolved routes in `.aipi/runtime/model-routing.jsonl`. Round 51
  update: env overrides no longer require a host registry, and
  `.aipi/model-capabilities.json` class mappings are now applied by the router.

Acceptance:

- A planning/review/code/test matrix can resolve to distinct configured models
  when available.
- Missing capability floors now produce loud local failures:
  `AIPI_MODEL_CLASS_UNRESOLVED` for class-only routes, lifecycle
  `AIPI_MODEL_CAPABILITY_*` warnings for unresolved/unmet capability evidence,
  and `/aipi-status` blocker `model.capability_floors` until
  `.aipi/model-capabilities.json` maps every class to a provider/model with
  capability evidence satisfying `.aipi/model-classes.yaml`.
- Adversarial/review agents can prefer a different model family than implementers
  when configured.

### P5 - Subagent Backend S1-S6

Goal: extend S0 spawn into useful swarm execution.

Work:

- Run multiple workers under the concurrency cap.
- Collect structured results and artifacts for all workers in a step.
- Implement cancellation, timeout, and budget handling. Cancellation,
  `budget_timeout`, and `budget.max_tool_calls` are implemented; the
  over-limit tool call is blocked before execution with
  `abort_reason=budget_max_tool_calls`. Provider token/cost accounting now
  normalizes usage metadata when providers expose it and estimates missing cost
  only from `.aipi/provider-pricing.json` rates with fresh `source_url` and
  `checked_at` metadata; `.aipi/provider-budget.json` is installed disabled by
  default and emits provider budget status into `provider-budget.jsonl` only
  when enabled, marking unpriced token usage as `cost_unknown` instead of
  treating it as free. `npm run test:provider-pricing` and
  `tools/check-provider-pricing.mjs` now make freshness/source validation an
  explicit release gate; concrete current provider price tables remain an
  external maintenance input.
- Implement steering or explicitly mark it unsupported until it is safe. The
  current backend returns `accepted=false` with a reason and trace event while
  steering is disabled.
- Persist enough subagent state to recover from parent restart. The current
  coordinator restores the latest session-entry snapshot, preserved results, and
  owned-file allocations, marking queued/running workers as `interrupted`;
  workflow adapters redispatch matching interrupted workers from clean step
  boundaries with fresh descriptors/context.
- Add lifecycle traces for worker start, prompt, tool use, finish, failure, and
  cleanup. The current coordinator emits queued/started, worker_prompt_start/end,
  done/failed/cancelled, worker_cleanup, budget-timeout/budget-limit, restore,
  and per-tool start/end/error traces without storing tool inputs or content.
- Expose retention cleanup. `aipi_cleanup_agents` removes terminal workers from
  coordinator state, releases their owned-file allocations, emits a `cleanup`
  trace, returns `aipi.subagents.cleanup.v1`, and never deletes durable memory.
- Define when to escalate from in-process workers to stronger isolation.
  `rpc_worker_process` now provides a child-process boundary with the same
  owned-file guard. `per_worker_worktree` now provides a managed scratch-copy
  boundary with declared-output sync. `external`/`container` requests now fail
  closed unless a JSON command adapter is configured; AIPI supervises the RPC
  protocol, while the configured runner supplies real containment.

Acceptance:

- Two review workers can run in parallel under configured fan-out and return
  separate artifacts.
- Two write-capable workers cannot write the same file or project memory.
- A cancelled worker returns its owned files for reassignment.
- Retention cleanup removes only terminal workers, releases owned-file scopes,
  and reports `durable_memory_deleted=false`.
- Restart or compaction does not silently lose an accepted step result.
- A worker requesting `rpc_worker_process` can run through the child-process
  backend. A worker requesting `per_worker_worktree` can run through a managed
  scratch copy and sync declared owned outputs back. A worker requesting
  `external`/`container` can run through the configured command adapter, and
  unconfigured requests are rejected before allocation.

### P6 - Runtime Policy Hooks

Goal: extend the parent-session profile/stage/action gate into full workflow
policy coverage across Pi runtime boundaries.

Work:

- Restore active run pointers on session start.
- Inject BDD contract, active stage, memory pointers, and active disciplines
  before agent turns.
- Add context pruning/injection through Pi's `context` hook.
- Do not classify parent-session tool calls for permission gating. Workflow
  execution gates remain structured, and worker owned-file guards remain active
  for parallel-worker correctness.
- Observe user shell commands for lifecycle evidence without blocking them
  through a permission profile.
- Normalize tool results into evidence records and redact sensitive output.
- Preserve run state before compaction, tree navigation, fork, or switch.
- Provide active-run compaction summaries that preserve the BDD contract pointer,
  current run, restart invariants, recent excerpts, and file-operation summary.
- Record safe provider telemetry without persisting raw provider payloads.
- Normalize provider token/cost usage metadata into runtime and run-scoped
  `provider-usage.jsonl` when provider events expose it, estimating missing
  cost from `.aipi/provider-pricing.json` rates only when those rates include
  fresh `source_url` and `checked_at` metadata.
- Report provider budget state from enabled `.aipi/provider-budget.json` into
  runtime and run-scoped `provider-budget.jsonl`. The template installs this
  file disabled by default. This is an auditable provider spend guardrail; it
  does not claim to be a hard provider-call sandbox. Token usage without a
  provider cost or local pricing rate is reported as `cost_unknown`.
- Redact obvious provider-payload secret patterns and prune duplicate/oversized
  AIPI context messages before model calls.

Acceptance:

- Parent-session shell/write/edit calls can be allowed, blocked, or approval
  gated by stage and profile.
- Production/deploy actions cannot execute without an approval artifact when
  policy requires one.
- Policy decisions are recorded in the run, not only displayed transiently.
- The parent-session matrix, user shell gate, hook handoff artifacts,
  session-start subagent snapshot restore, tool-result redaction, provider
  telemetry, context-hook pruning, and clean-boundary worker redispatch are
  implemented.

### P7 - Memory And Code Graph

Round 56 update: deterministic domain inference now canonicalizes PT/EN aliases
and explicit source path references before token-overlap fallback, infers
conservative preserve-vs-replace / allow-vs-deny / required-vs-optional /
automatic-vs-manual / numeric-mismatch / monetary-mismatch /
threshold-direction-mismatch / date-mismatch / time-mismatch /
enum-value-mismatch / boolean-state-mismatch / cardinality-mismatch /
sequence-mismatch conflicts when
related rules share enough canonical domain terms, and summarizes
historical run outcomes from run artifacts as PASS, FAIL, BLOCKED, or SKIPPED
edges back to business rules and impacted code. Remaining P7 semantic work is
about subtler conflicts, not the first alias/path-ref, modality, automation
conflicts, numeric, monetary, threshold direction, date, time, enum value,
boolean state, cardinality, sequence, or historical-outcome layer.
Round 77 broadened enum-value matching to explicit status/state/stage/tier/plan/
role/visibility/access/classification/mode/type/scope fields.
Round 78 broadened enum-value matching again to provider/channel/source/owner/
region/locale/language/environment/method/currency fields.
Round 79 tightened threshold inference so compatible min/max ranges, such as
`at least 3` plus `at most 5`, do not produce a false business-rule conflict.
Round 80 tightened threshold inference again so same-direction bounds, such as
`at least 3` plus `at least 5`, also do not produce a false direct conflict.

Goal: make the three memory layers operational.

Work:

- Project memory: promote business rules, decisions, knowledge, environment,
  procedures, deployment, and glossary updates through orchestrator-owned writes.
- User memory: keep repo-local private preferences separate from global user
  memory and require approval before promotion.
- Implemented: build a rebuildable JSON manifest plus `node:sqlite` sidecar
  over code files, symbols, searchable code lines, and optional `sqlite-vec`
  1024-dimensional Ollama `bge-m3` code-line vectors. The graph also stores rebuildable
  relationship edges for symbol definitions, test coverage candidates, memory
  mentions, run-artifact path mentions, accepted business rules, BDD contracts,
  explicit rule conflicts, deployment surfaces, and verification artifacts.
  Historical run artifacts now produce `run_outcomes` plus `run_verifies_rule`,
  `run_fails_rule`, `run_blocks_rule`, `run_skips_rule`, and
  `run_outcome_impacts_code` relationships.
  `aipi_callers` and `aipi_impact` query SQLite/vector first and fall back to
  lexical scans plus manifest relationships. SQLite/code-line/vector writes run
  inside one explicit transaction to avoid slow autocommit behavior during graph
  refresh.
- Remaining: improve subtler conflict inference beyond the deterministic
  alias/path-ref, polarity conflicts, modality conflicts, automation conflicts,
  numeric conflicts, monetary conflicts, threshold direction conflicts, date conflicts,
  time conflicts, enum value conflicts, boolean state conflicts, sequence
  conflicts, cardinality conflicts, and historical-outcome layer.
  Enum-value conflicts currently cover explicit status, state, stage, tier, plan,
  role, visibility, access, classification, mode, type, scope, provider, channel,
  source, owner, region, locale, language, environment, method, and currency
  fields.
  Threshold conflicts now distinguish impossible or same-value opposite bounds
  from compatible min/max ranges and same-direction threshold refinements.
- Implemented: generated graph manifests store file hashes and tool queries
  detect added, removed, or changed files before reusing the index. Stale
  manifests are rebuilt automatically and the tool graph summary reports the
  stale reason in `rebuilt_from_stale`.
- Keep Markdown as authority when index data conflicts.

Acceptance:

- Deleting the generated index loses speed, not knowledge.
- Business-visible answers can cite authoritative Markdown.
- Code graph tools can answer caller/impact queries from a generated index.
- Memory promotion produces one of promoted, no-signal, or deferred.

### P8 - Orchestrator Entry Behavior

Goal: make normal use start from `aipi`, not from users knowing internals.

Work:

- Implemented: route recognized natural-language input to workflow status,
  active-run continuation, blocker-answer resume, planning, feature, bugfix,
  research, ops, quick, active-run review, review-to-planning, or no-workflow.
- Implemented: when a run is blocked with `awaiting_user_input`, the input hook
  records the user's answer in `USER-INPUT.jsonl`, the executor keeps
  `current_step` on the blocked boundary, and the next context packet includes
  the answer before re-executing that step.
- Implemented: `aipi workflow [--target <dir>] [--json] ...` exposes workflow
  list/status/start/run/execute through the console using the same run-state
  runtime as `/aipi-workflow`.
- Removed by design: the console profile wrapper and permission profile runtime.
- Implemented: `aipi memory [--target <dir>] [--json] ...` and `/aipi-memory`
  expose read-only memory status/refs/query using the Markdown memory query
  runtime and code-graph status inspection.
- Keep the BDD agent inside workflows: BDD posture belongs at planning and
  contract gates, not as a permanent separate startup role.

Acceptance:

- A user can run `aipi`, initialize a project, start planning, answer one
  business-rule blocker, and continue the same active run through the
  natural-language input hook. The current `test:workflow-executor` fixture
  covers this path.
- The orchestrator asks business questions only for rule gaps/conflicts or
  policy approvals.

### P9 - Verification Harness And Pressure Evals

Goal: make readiness falsifiable before another adversarial round.

Work:

- Implemented: `npm run test:workflow-fixtures` initializes fixture repositories
  for planning, feature, bugfix, research, and ops, runs each workflow through
  the local executor, and checks expected terminal status plus key artifacts.
- Implemented: `npm run test:fake-provider-workflows` runs a fake-provider
  workflow harness that proves executor `FAIL -> implement` branching and
  review-swarm fan-out/reconciliation without LLM/provider credentials.
- Implemented: `npm run test:provider-pricing` and
  `tools/check-provider-pricing.mjs` validate provider-pricing source metadata,
  stale/future timestamps, rate-level overrides, and the empty default template.
- Add live Pi smoke probes for one minimal worker loop when credentials exist.
- Implemented: `test:pressure-evals` covers deterministic runtime pressure
  fixtures for memory overwrite attempts, production command approval, missing
  artifacts, bad step JSON, and stale graph rebuild behavior.
- Implemented: `test:model-pressure-evals` provides an opt-in model-backed
  baseline/verify harness. It validates scenarios and discipline catalog in
  normal `npm test`, skips model calls by default, and runs a configured model
  command only when `AIPI_MODEL_PRESSURE=1`.
- Remaining: collect credentialed model-backed baseline failures and verified
  flips before changing any discipline status from `predicted` to `observed`.

Acceptance:

- `npm test` covers unit and fake-runtime contracts.
- A separate live-smoke command clearly reports skipped when credentials are
  missing and fails when runtime behavior regresses. `/aipi-status` also reports
  model-backed pressure and live subagent smoke as external evidence gaps until
  baseline+verify pressure reports and a live-smoke report exist.
- Deterministic pressure fixtures and the opt-in model-backed harness run in
  `npm test`; actual discipline status changes still require recorded
  baseline/verify model outputs that distinguish predicted rules from observed
  rules.

### P10 - Packaging, Docs, And Release Discipline

Goal: make the package installable and maintainable.

Work:

- Keep package contents intentional and inspectable.
- Add release checklist: test, pack dry-run, audit, live-smoke when available.
- Ensure docs index links every durable decision doc.
- Record third-party attribution and license boundaries for borrowed ideas.
- Keep provider auth as a pinned dependency while Pi core packages remain
  runtime peers supplied by Pi.
- Implemented: `test:release-fixture` materializes the packaged `files` surface
  into a clean fixture, imports the packaged CLI/runtime modules, runs
  `initProject`, verifies expected templates, and proves forced updates protect
  project memory. It also runs the packaged `aipi status` command against the
  initialized fixture and proves strict mode reports blockers/external evidence
  gaps instead of returning a false green release posture.
- Implemented: `release:audit` wraps npm audit with structured
  `aipi.npm-audit-release-check.v1` output, timeout/cache controls, and explicit
  `external_unavailable` classification for registry/audit endpoint failures.
- Implemented: `release:check` aggregates local release gates into
  `aipi.release-check.v1`, covering `npm test`, pack dry-run, and the structured
  npm audit wrapper without hiding `external_unavailable` states.

Acceptance:

- Pack dry-run shows only intentional files and runtime dependencies.
- The npm audit release gate reports `pass`, `fail`, or `external_unavailable`
  without treating registry outages as release approval.
- The local release aggregate reports `pass`, `fail`, `external_unavailable`, or
  `incomplete` so maintainers can see which release gate still needs evidence.
- Docs state exactly what is implemented, partial, and specification-only.
- Release candidate can be installed into a clean fixture project with one
  command and verified by scripted checks. The current local fixture check covers
  the packaged bin/extensions/templates/status surface without network access.

## Recommended Build Order

1. P0/P1/P2/P3 first vertical slice: implemented in the current alpha runtime
   for deterministic workflow execution, context packets, AIPI tools, and
   capability reporting.
2. P5: broaden subagent runtime coverage beyond the current bounded
   fan-out/reconciliation, timeout/max-tool-call budgets, redispatch, and
   tool/prompt/cleanup trace tests.
3. P6: parent-session permission profiles were removed by product decision;
   `test:permission-removal` guards against accidental reintroduction.
4. P7: deeper domain relationship evaluation for subtler conflicts beyond
   deterministic aliases/path refs, polarity conflicts, modality conflicts,
   automation conflicts, numeric conflicts, monetary conflicts, threshold
   direction conflicts, date conflicts, time conflicts, enum value conflicts,
   boolean state conflicts, cardinality conflicts, sequence conflicts, historical
   outcomes, and the SQLite/sqlite-vec code-line graph.
5. P9: credentialed model-backed discipline pressure runs beyond the current
   deterministic fixtures and opt-in harness.
6. P10: release discipline; provider-pricing freshness is locally gated, while
   real provider/model rates still need official-source maintenance when used.

The order is vertical-first: the first `quick` slice must prove execution,
context, workflow gates, worker handoff, verification, and memory outcome together.
After that, broaden fan-out and memory/indexing. The graph now has a SQLite
search sidecar and can become vector-backed after the Markdown promotion path is
stable.

## Adversarial Review Brief

Ask the adversarial reviewer to attack these questions:

1. Does the current workflow-gate plus worker-owned-file model stay honest about
   what it controls, now that parent-session permission profiles are removed?
2. Is S0 `aipi-agent-session` enough for the first beta, or does unattended
   autonomy require isolated workers earlier?
3. Are there any catalog tools or workflow claims that still have no runtime
   implementation path?
4. Can a worker still mutate durable memory, shared artifacts, or production
   state through an unguarded path?
5. Does the plan preserve the user goal: client focuses on BDD/business rules,
   while AIPI handles technical execution?
6. What is the smallest vertical slice that proves the whole concept end to end?
7. What claims in README/status/docs should be downgraded before release?
8. Which missing tests would catch the most dangerous false-positive readiness?
9. Do `external`/`container` command adapters make the isolation boundary clear,
   or could users mistake the adapter itself for a sandbox?
10. Do deterministic domain aliases, polarity conflicts, modality conflicts,
     numeric conflicts, monetary conflicts, threshold direction conflicts, date conflicts,
     time conflicts, enum value conflicts, boolean state conflicts, sequence
     conflicts, cardinality conflicts, and historical run outcomes improve useful
     impact recall without producing unsafe false-positive business-rule
     conflicts?

Round-13 action already adopted: `npm test` includes a non-LLM real Pi SDK
worker-toolset smoke, and the validator fails when a catalog-referenced
`aipi_*` tool is neither implemented nor explicitly marked specification-only.
Round-44 action adopted: `npm run test:adversarial-readiness` now gates the
status/docs/release/adversarial brief against stale green claims and unevidenced
live claims before manual review.
Round-64 action adopted: `npm run test:workflow-executor` now covers restart
coherence for the first quick slice by starting a run, reading the active run
from persisted state, continuing it with a fresh adapter, and verifying the
manifest reaches `status: completed`.

## First Vertical Slice To Prove

The first end-to-end slice should be the quick workflow because it is bounded.

Scenario:

1. Initialize AIPI into a fixture repository.
2. Start a quick workflow from a small user request.
3. Confirm quick eligibility from existing rule/mechanics coverage.
4. Build a context packet.
5. Spawn one write-capable implementer with one owned file.
6. Run serialized verification in the controller.
7. Run one read-only complexity or code review worker.
8. Produce a final step result and a no-signal or promoted memory outcome.
9. Resume after restart and show the run remains coherent.

This slice exercises BDD posture, workflow state, context, subagents,
owned-file enforcement, verification evidence, review, and memory promotion
without requiring the full feature swarm.

# adversarial review remediation

Source: `adversarial-claude.md` in the repository root.

## Applied changes

- Replaced prose regex gates with the `aipi.step-result.v1` workflow contract.
- Added `.aipi/runtime-contract.json` as the canonical stage, verdict, policy,
  artifact, and enforcement registry.
- Namespaced workflow artifacts under
  `.aipi/runtime/runs/{{ run_id }}/steps/{{ step_id }}/`.
- Removed `run_id: active` write defaults from workflows.
- Added explicit `agents:` lists to workflow steps and a validation script that
  fails on unknown agent ids.

Claim evidence anchors for the live runtime surfaces are `test:workflow-executor`,
`test:fake-provider-workflows`, `test:workflow-fixtures`, `test:aipi-tools`,
`test:permission-removal`, `test:lifecycle-hooks`,
`test:subagents`, `test:subagents-real-sdk`, and
`test:adversarial-readiness`.

- Round 20: removed the parent-session permission profiles and tool-call
  approval gate by product decision. The runtime no longer blocks interactive
  source edits through profile/stage policy; `test:permission-removal` guards
  the absence of the removed layer.

- Added `orchestration-reasoner` so the controller does not spawn itself.
- Added the missing `debugger` agent used by the bugfix workflow.
- Moved feature codebase/context mapping before TDD.
- Marked deployment and ops workflows as advisory until `tool_call` policy
  enforcement exists.
- Marked all behavioral disciplines as `status: predicted` until pressure evals
  record a baseline failure and verified flip.
- Added `.aipi/.gitignore` for generated state, runtime artifacts, and private
  repo-local user memory.
- Added `NOTICE.md` attribution for Fable skills and Ponytail.
- Round 2: registered terminal actions, skip conditions, run loop limits, and
  context materialization in `.aipi/runtime-contract.json`.
- Round 2: expanded the validator to check branch targets, policy decisions,
  skip tokens, evidence rungs, step references, shared artifacts, and agent
  stage support.
- Round 2: added `aipi-quick` as a fast lane for small low-risk changes.
- Round 2: added `npm run validate` and a GitHub Actions workflow.
- Round 3: corrected Pi lifecycle hook mapping for `agent_end`, `turn_end`,
  and `message_end` instead of banning `agent_end`.
- Round 3: added explicit security-boundary language for in-process
  `tool_call` policy versus external containment.
- Round 3: added `runtime: controller | skill | session` to every agent and
  validate those values against the runtime contract.
- Round 3: added a Pi package manifest plus a minimal `/aipi-status` extension
  entry point. The current package also ships `/aipi-init`.
- Round 3: evaluated community swarm references; Round 4 corrected the earlier
  fabricated package name and moved the preferred spike to the AIPI-owned
  `aipi-agent-session` backend.
- Round 4: reclassified `pi-subagents` packages as spawn/collect references,
  `@tmustier/pi-agent-teams` as task-board coordination reference, and
  `pi-messenger-swarm` as channel/task eventing reference.
- Round 4: chose the v1 isolation model: one shared working tree plus
  orchestrator-owned file scopes. Round 10 refined the enforcement mechanism:
  each worker receives a write tool wrapped with its owned-file scope. Later
  rounds added process-boundary and scratch-worktree backends without changing
  the owned-file guard.
- Round 5: kept `aipi-agent-session` as the v1 swarm backend, added criterion
  zero for `tool_call` worker attribution, removed per-worker `cwd` from v1, and
  split spawn backends from coordination transports.
- Round 6: closed the bash-shaped owned-file hole by denying `bash`/`user_bash`
  to v1 `runtime: session` workers, making the owned-file guard fail closed on
  opaque or unknown tools, and adding an owned-file guard smoke test.
- Round 8/9: verified against real Pi that built-in mutating tools are
  `write`/`edit` with `path`, and `bash` is opaque.
- Round 10: ran Probe A and confirmed host hooks do not observe child-session
  worker calls. Then ran Probe A' against Pi 0.75.5 and confirmed the correct
  in-process primitive: `createWriteToolDefinition` plus
  `wrapWriteToolWithOwnership` blocks out-of-scope writes before the real write
  tool executes. The v1 default backend is `aipi-agent-session`; later rounds
  added `rpc_worker_process` as a process-boundary backend.
- Pinned `@ersintarhan/pi-toolkit@0.5.12` as the upstream source for the
  Anthropic OAuth adapter (replacing the earlier
  `@cortexkit/pi-anthropic-auth`, which did not work) while loading an AIPI-owned
  OAuth-only wrapper by default, and added a unified `aipi update` command that
  updates Pi and AIPI together.
- Added `/aipi-init` as a real Pi command. It copies the packaged
  `templates/.aipi` tree into the current repository, preserves existing files
  by default, supports `--dry-run`, and updates framework files with `--force`
  while protecting `.aipi/memory/project/**` unless `--reset-memory` is also
  present.
- Replaced the fixed `/aipi-status` message with a real deployment report that
  checks local `.aipi` installation, pinned Anthropic provider version,
  extension path, sidecar location, login/account presence, and the still-open
  subagent spawn seam without printing credential values.
- Added `/aipi-workflow` as the first run-state command. It can list workflows,
  show the active run, create a unique run id, write `RUN-MANIFEST.md` and
  `state.json`, and maintain `.aipi/runtime/runs/active`.
- Added `extensions/aipi/runtime/step-result.js` to validate
  `aipi.step-result.v1`, verdict pass semantics, evidence rung requirements,
  skip gates, and policy decision pass/block behavior.
- Added `/aipi-probe-a` plus `extensions/aipi/runtime/probe-a.js` and
  `docs/probe-a-tool-call-attribution.md` to run criterion zero for worker
  `tool_call` attribution inside Pi.
- Ran Probe A on Pi 0.75.5 with `openai-codex/gpt-5.4-mini`. Result:
  `FAIL` for host-hook attribution only. SDK child sessions emitted tool
  execution events and wrote both probe files, but host extension hooks observed
  zero worker `tool_call` events.
- Added Probe A' (`extensions/aipi/runtime/probe-a-prime.js`) and ran it against
  the real Pi SDK write tool. Result: `IN_PROCESS_VIABLE`. The preferred backend
  is `aipi-agent-session`, with owned-file enforcement through wrapped write
  tools.
- Round 11: made the `aipi` wrapper own product identity. `aipi --version` now
  reports the AIPI package version plus the wrapped Pi version, `aipi --help`
  shows AIPI commands and wrapper options, and `--pi-version`/`--pi-help` remain
  raw Pi escape hatches.
- Round 12: wired S0 of the `aipi-agent-session` backend. The coordinator now
  creates a Pi SDK `AgentSession` worker with read-only tools plus a
  `wrapWriteToolWithOwnership`-guarded `write`, injects the context packet,
  aborts through the worker signal, and collects validated
  `aipi.step-result.v1` JSON.
- Round 13: added a non-LLM real Pi SDK worker-toolset smoke to `npm test`.
  It creates a real `AgentSession`, asserts the worker's active tools are
  exactly `find,grep,ls,read,write`, verifies `bash`/`edit` are absent, and
  checks guarded write block/allow behavior.
- Round 13: added `aipiToolSurface` to the runtime contract and validator
  coverage so every catalog-referenced `aipi_*` tool is either implemented in
  the extension or explicitly marked specification-only.
- Round 13: moved the minimum controller write/shell/memory policy gate into P1
  planning so the workflow executor does not drive parent-session mutations
  before policy exists.
- Round 13: added `npm run smoke:subagent-live`, an explicit opt-in
  credentialed smoke for one real LLM worker. It is guarded by
  `AIPI_LIVE_SMOKE=1` so CI and local tests do not spend provider credentials
  accidentally.
- Round 14: added the first real workflow executor slice. `/aipi-workflow run
  quick` now starts and executes the bounded quick workflow end to end with
  `aipi.step-result.v1` gates, required-artifact checks, persisted step results,
  an executor-owned controller artifact gate, and deterministic local fallback
  for non-worker quick steps.
- Round 15: completed executor run-limit enforcement for the quick slice.
  `maxVisitsPerStep` and `maxConsecutiveFailures` now stop looped execution via
  `runLimits.onExhaustion`, with tests forcing `quick_change` to loop until each
  limit fires.
- Round 15 follow-up: wired `quick_change` to the S0 `aipi-agent-session`
  adapter when `/aipi-workflow` runs inside the Pi extension. The worker receives
  the step's declared artifacts as owned files, writes through the guarded
  `write` tool, returns `aipi.step-result.v1`, and the normal missing-artifact
  gate still decides whether execution can continue.
- Round 15 follow-up: added the minimum parent-session `tool_call` soft gate for
  durable memory, controller-owned runtime artifacts, secret paths, destructive
  shell, production-like commands, and unclassified mutating tools.
- Round 16: hardened the provider/update surface. Provider package/version/path
  validation now derives from `runtime-contract.json`; `aipi update` supports
  `--dry-run`, skips unsafe git states instead of failing on no-commit/no-remote
  checkouts, and no longer prunes dev SDKs with `--omit=dev`; `/aipi-status`
  reports the auth sidecar schema and has a bounded generic Anthropic-token
  fallback.
- Round 17: added a truthful runtime capability report used by `/aipi-status`.
  Capabilities now report `verified`, `wired`, or `specification` instead of a
  single readiness sentence.
- Round 17: extended workflow execution beyond the bounded `quick` slice. The
  executor now runs installed workflow YAML through structured gates, bounded
  context packets, declared artifacts, run limits, branch targets, optional
  skips, and persisted policy decisions.
- Round 17: implemented the P2 context builder. It materializes prior step
  result summaries, bounded artifact excerpts, BDD contract refs, Markdown
  memory refs, code-graph status, and provenance; missing required prior
  artifacts block before model work.
- Round 17: implemented the P3 AIPI tool surface: `aipi_memory_query`,
  `aipi_rule_lookup`, `aipi_rule_gap`, `aipi_callers`, `aipi_impact`,
  `aipi_kanban_update`, and `aipi_promote_memory`. The runtime contract no
  longer marks catalog-referenced `aipi_*` tools as specification-only.
- Round 17: extended `aipi-agent-session` from S0 single-worker spawn into a
  bounded fan-out slice for configured workflow steps such as `review_swarm`.
  Workers receive disjoint artifact ownership, return structured step results,
  and the executor reconciles them before advancing.
- Round 18: added a parent-session profile/stage policy gate. **Superseded by
  Round 20:** that permission layer and its wrapper command were removed by
  product decision.
- Round 19: added `runtime/lifecycle-hooks.js`. AIPI now registers
  `session_start`, session transition, `before_agent_start`, `user_bash`,
  `tool_result`, and provider response/request handlers to preserve active run
  pointers, inject compact context pointers, apply shell policy to user `!`
  commands, redact/log tool output, and record provider telemetry without raw
  payload capture.
- Round 20: extended `runtime/lifecycle-hooks.js` with Pi's `context` hook. It
  keeps a single current AIPI context pointer, injects one if missing, truncates
  older `aipi_*` tool results, and records context-pruning evidence.
- Round 21: wired `session_start` to the latest `aipi.subagents.state` session
  entry. The coordinator now restores owned-file allocations and persisted
  worker results, marks queued/running workers as `interrupted` instead of
  reviving stale in-memory queues, and records an `aipi.subagents.restore`
  marker for the session.
- Round 22: implemented `before_provider_request` payload policy. The hook now
  returns a replacement payload when it redacts obvious secret patterns or
  prunes duplicate/oversized AIPI context messages, while provider logs still
  store only summaries and policy counts.
- Round 23: implemented active-run AIPI compaction results. On
  `session_before_compact`, AIPI now writes the handoff artifact and returns a
  deterministic `aipi.compaction-summary.v1` preserving run id, BDD contract
  pointer, current step, restart invariants, recent message excerpts, and file
  operation summary.
- Round 24: added subagent budget timeouts and session traces. Workers now
  persist `budgetTimeoutMs`, abort with `abort_reason=budget_timeout`, and emit
  `aipi.subagents.event` entries for queued, started, done, failed, cancelled,
  budget timeout, and restore transitions.
- Round 25: made `aipi_steer_agent` explicit. The tool remains registered, but
  running workers return `accepted=false` with a reason and a trace event until
  prompt/response boundaries are resumable.
- Round 26: implemented clean-boundary redispatch. Workflow adapters now call
  `coordinator.dispatch(descriptor)`, which matches restored interrupted workers
  by `step_id`, catalog agent id, and `owned_files`, marks the old worker
  `redispatched`, releases its file allocation, and spawns a fresh worker from
  the current descriptor/context.
- Round 27: added worker tool-use traces. Custom worker tools are wrapped to
  emit `tool_start`, `tool_end`, and `tool_error` session events with tool name
  and error status only; inputs and content are not persisted.
- Round 28: added Pi `input` hook routing for recognized natural-language
  workflow intents. AIPI now handles workflow status, active-run continuation,
  active-run review, and clear planning/feature/bugfix/research/ops/quick
  starts before the agent turn, records `aipi.input.route`, and leaves slash
  commands plus ambiguous chat untouched.
- Round 29: added verified blocker-answer resume semantics. When a workflow
  stops at `stop_for_user_question`, the executor preserves the blocked
  `current_step` and `awaiting_user_input`; the `input` hook records the user's
  answer to `USER-INPUT.jsonl`; the context builder injects recent run user
  inputs; and the executor re-runs the blocked step with that answer available.
- Round 30: replaced the JSON-only code graph with a rebuildable
  `sqlite+lexical` backend. `rebuildCodeGraph` now writes
  `.aipi/state/aipi-graph.json` plus `.aipi/state/aipi-graph.sqlite` through
  `node:sqlite`; `aipi_callers` and `aipi_impact` query SQLite first and fall
  back to lexical file scans when SQLite is unavailable.
- Round 31: added `npm run test:pressure-evals`, a deterministic runtime
  pressure harness covering memory overwrite attempts, production command
  approval, missing artifact claims, malformed step results, and stale graph
  rebuild behavior.
- Round 32: made unsupported isolation fail closed. At that point,
  `rpc_worker_process`, `per_worker_worktree`, or another unsupported isolation
  mode was rejected instead of silently downgrading to the shared in-process
  backend.
- Round 33: added an optional `sqlite-vec` backend to the rebuildable code
  graph. When the platform extension and local Ollama are available,
  `rebuildCodeGraph` creates a `vec0` table with 1024-dimensional
  `bge-m3` code-line embeddings; `aipi_callers` and `aipi_impact`
  merge exact SQLite refs with vector refs and fall back to lexical search when
  semantic embeddings are unavailable.
- Round 34: added rebuildable graph relationship edges. The JSON manifest and
  SQLite sidecar now record symbol definitions, test coverage candidates,
  memory mentions, and run-artifact path mentions; `aipi_impact` returns
  relationship refs alongside code refs and related tests.
- Round 35: added `npm run test:model-pressure-evals`, an opt-in model-backed
  pressure harness for behavioral disciplines. Normal `npm test` validates the
  scenario/catalog wiring and skips model calls; setting `AIPI_MODEL_PRESSURE=1`
  plus `AIPI_MODEL_PRESSURE_COMMAND` runs baseline/verify prompts and writes a
  structured `aipi.model-pressure-results.v1` report.
- Round 36: implemented the first `rpc_worker_process` backend. The coordinator
  now accepts descriptors requesting `rpc_worker_process`, spawns a child Node
  worker over stdin/stdout, reconstructs the owned-file guard in the child
  process, collects `aipi.step-result.v1`, and records `rpc_worker_start` /
  `rpc_worker_end` traces.
- Round 37: implemented `per_worker_worktree` as a managed scratch-copy backend.
  The coordinator prepares `.aipi/runtime/worktrees/<agent>`, runs the guarded
  RPC worker there, syncs declared owned/artifact outputs back to the project
  root, and cleans the scratch directory by default. At that point,
  container/external isolation still failed closed.
- Round 38: strengthened long-running swarm accounting. Workers now persist
  tool-call counters, emit prompt start/end and cleanup traces, enforce
  `budget.max_tool_calls`/`maxToolCalls` before the over-limit tool executes, and
  surface `abort_reason=budget_max_tool_calls` with a `budget_limit_exceeded`
  event. RPC child workers return their tool-call count to the coordinator.
- Round 39: added deterministic domain graph relationships. The rebuildable graph
  now links business rules and BDD contracts to impacted source files, records
  explicit `business_rule_conflicts`, connects deployment memory to source files,
  and links verification/run artifacts back to business rules.
- Round 40: added a clean release fixture check. `npm run test:release-fixture`
  materializes the package `files` surface into a temporary installed-package
  root, imports the packaged CLI/runtime modules, initializes a clean project
  from packaged templates, verifies required files, and confirms forced updates
  still protect project memory.
- Round 41: implemented configured `external`/`container` worker adapters. The
  coordinator accepts those isolation modes only when
  AIPI_EXTERNAL_WORKER_COMMAND_JSON or AIPI_CONTAINER_WORKER_COMMAND_JSON is set
  to a JSON array command, spawns it without shell interpolation, sends the same
  RPC worker request over stdin, validates structured JSON output, and records
  `external_worker_start` / `external_worker_end` traces. Unconfigured requests
  fail before owned-file allocation.
- Round 42: improved deterministic domain relationship inference. The code
  graph now canonicalizes PT/EN business terms and common morphology such as
  assinatura/subscription, preco/price, cobranca/billing, and renewal variants,
  detects explicit source path references, and records `shared canonical domain
  terms` evidence before falling back to generic token overlap. Related rules
  with enough shared canonical terms now also emit conservative implicit
  `preserve-vs-replace` / `allow-vs-deny` conflict edges.
- Round 43: added structured readiness reporting to `/aipi-status`. The status
  report now includes `aipi.readiness-report.v1`, separating hard blockers
  (project install, auth, specification-only claims) from external evidence gaps
  such as credentialed model pressure and live subagent smoke. This prevents a
  green capability report from hiding unrun paid/provider checks.
- Round 44: added `npm run test:adversarial-readiness`. The local gate verifies
  that README, release checklist, status readiness, remediation notes, and the
  next adversarial brief do not regress into stale green claims or unevidenced
  live claims about container/external isolation, model-backed pressure, live
  smoke, or semantic graph quality.
- Round 45: added provider usage normalization. `after_provider_response` now
  extracts common token/cost metadata shapes, appends redacted
  `aipi.provider-usage.v1` entries to runtime and run-scoped
  `provider-usage.jsonl`, and keeps raw provider payloads/secrets out of logs.
- Round 46: taught readiness to recognize durable external evidence. A
  model-pressure baseline report with at least one failure at
  `.aipi/evals/model-pressure-baseline-results.json`, a verify report proving
  those scenarios pass at `.aipi/evals/model-pressure-verify-results.json`, and
  a passing live subagent smoke report at
  `.aipi/runtime/smoke/live-subagent-result.json` now move `/aipi-status` from
  `needs_external_evidence` to `ready_for_adversarial_review` without relying on
  transient console output.
- Round 47: deepened P7 historical outcomes. The rebuildable graph now records
  `run_outcomes` from run artifacts and links PASS, FAIL, BLOCKED, and SKIPPED
  outcomes back to business rules and impacted code through
  `run_verifies_rule`, `run_fails_rule`, `run_blocks_rule`, `run_skips_rule`,
  and `run_outcome_impacts_code` relationships.
- Round 47 follow-up: added conservative numeric-mismatch conflict inference for
  related business rules, such as two accepted/proposed refund windows with
  different day counts.
- Round 48: added config-driven provider cost estimation. When provider usage
  includes tokens but no cost, `after_provider_response` can estimate USD cost
  from optional `.aipi/provider-pricing.json` rates and record `cost_source` and
  `pricing_ref` in `provider-usage.jsonl`.
- Round 48 follow-up: added optional provider budget telemetry. AIPI reads
  `.aipi/provider-budget.json`, computes default/provider/model spend state
  against `provider-usage.jsonl`, and records `ok`, `warning`, `over_budget`, or
  `unlimited` entries in runtime and run-scoped `provider-budget.jsonl` when the
  budget file is enabled. The template installs pricing and budget config files,
  with budget disabled by default.
- Round 49: made model capability floors a local readiness gate. AIPI now
  installs `.aipi/model-capabilities.json`, parses `capability_floor` from
  `.aipi/model-classes.yaml`, records lifecycle capability-floor warnings for
  resolved models, and blocks `/aipi-status` with `model.capability_floors`
  until every class maps to a provider/model with evidence satisfying its floor.
- Round 50: added conservative required-vs-optional conflict inference for
  related business rules. The graph now detects obligation/permission modality
  conflicts such as "must include receipt metadata" versus "may omit receipt
  metadata" when the rules share enough canonical domain terms.
- Round 51: aligned model routing with the local capability registry. Explicit
  `AIPI_MODEL_CLASS_<CLASS>` env overrides now resolve to a concrete
  provider/model even when the host registry is absent, and
  `.aipi/model-capabilities.json` class mappings are applied before falling
  back to the current session model.
- Round 52: removed silent zero-cost budget accounting. When provider responses
  include token usage but no provider cost and no matching local pricing rate,
  the provider budget log now records `state=cost_unknown`,
  `cost_status=unknown_no_rate`, and null event/projected cost values instead
  of treating the event as free.
- Round 53: made local pricing evidence-bound. AIPI now ignores
  `.aipi/provider-pricing.json` rates unless they carry `source_url` and
  `checked_at` metadata within `max_age_days`, and records the pricing source
  metadata next to estimated usage cost.
- Round 54: added wrapper-level readiness status. `aipi status` and
  `aipi doctor` now run the same project/auth/model-floor/capability/external
  evidence report as `/aipi-status` without starting an interactive Pi session,
  with `--json`, `--target`, and `--strict` options for release checks.
- Round 55: added `npm run readiness:credentialed` as the consolidated
  external-evidence runner. It runs model-pressure baseline plus verify when
  `AIPI_MODEL_PRESSURE=1` and `AIPI_MODEL_PRESSURE_COMMAND` are configured,
  optionally runs live subagent smoke when `AIPI_LIVE_SMOKE=1`, writes durable
  `.aipi/` evidence reports, and then evaluates the same readiness contract used
  by `aipi status`.
- Round 56: added conservative sequence-mismatch conflict inference for related
  business rules, such as one accepted payment rule requiring capture after
  fraud approval and a proposed rule requiring capture before the same approval.
- Round 57: added hash-based stale graph detection. Generated graph manifests
  now store per-file hashes; callers/impact tools compare the manifest to the
  current workspace before reusing it, rebuild automatically on added/removed/
  changed files, and surface the stale reason in `graph.rebuilt_from_stale`.
- Round 58: made `npm run readiness:credentialed` preflight-first. The runner
  now checks local readiness blockers before launching model-pressure or
  live-worker commands, so missing `.aipi`, auth, model capability floors, or
  specification-only claims cannot spend provider credentials before local gates
  pass.
- Round 59: added `npm run test:fake-provider-workflows`, a credential-free
  fake-provider workflow harness that proves executor branch handling for
  `FAIL -> implement` and review-swarm fan-out/reconciliation with five
  spawned worker results.
- Round 60: added `npm run test:workflow-fixtures`, which initializes
  credential-free fixture repositories for planning, feature, bugfix, research,
  and ops and verifies each workflow reaches its expected terminal status with
  key artifacts present.
- Round 61: added an explicit provider-pricing freshness gate. The runtime now
  exposes `validateProviderPricingConfig`, `npm run test:provider-pricing`
  covers empty-template, fresh, stale, future-dated, missing-source, and
  rate-level override cases, and `tools/check-provider-pricing.mjs` can fail a
  release when configured `.aipi/provider-pricing.json` rates lack fresh source
  evidence.
- Round 62: deepened P7 deterministic conflict inference with
  automatic-vs-manual rule conflicts. The graph now catches cases where the same
  business surface is accepted as automatic but a proposed rule requires manual
  review, with coverage in `npm run test:aipi-tools`.
- Round 63: narrowed the default Anthropic auth autoload surface. AIPI still pins
  `@ersintarhan/pi-toolkit@0.5.12` as the dependency source, but `package.json`
  now loads `extensions/aipi/provider/anthropic-oauth-only.ts`, an AIPI wrapper
  that imports only `src/claude-oauth-adapter.ts`; the validator fails if the
  broad toolkit `index.ts` is restored as a default extension.
- Round 64: added restart/resume coverage for the workflow executor. The test now
  starts a quick run without executing it, reads the active run back from disk,
  continues it with a fresh local adapter, and verifies the persisted
  `RUN-MANIFEST.md` reaches `status: completed`.
- Round 65: made subagent retention cleanup an explicit tool surface. The
  coordinator now exposes `aipi_cleanup_agents`, returns
  `aipi.subagents.cleanup.v1`, releases owned-file allocations for terminal
  workers, emits a `cleanup` trace, and reports `durable_memory_deleted=false`;
  `npm run test:subagents` covers the behavior.
- Round 66: added conservative monetary-mismatch conflict inference for business
  rules. Related accepted/proposed rules that declare different values in the
  same currency now produce `implicit monetary mismatch conflict` graph edges,
  with BRL/USD fixture coverage in `npm run test:aipi-tools`.
- Round 67: stabilized the SQLite/sqlite-vec graph writer with an explicit
  `BEGIN IMMEDIATE`/`COMMIT` transaction and best-effort `ROLLBACK`. This keeps
  vector/code-line indexing from doing thousands of synchronous autocommits and
  is now guarded by template validation.
- Round 68: added conservative threshold-direction conflict inference. Related
  business rules that declare the same numeric unit/value with opposite bounds,
  such as `at least 3 attempts` versus `at most 3 attempts`, now produce
  `implicit threshold direction conflict` graph edges.
- Round 69: expanded the release fixture to execute the packaged `aipi status`
  command against a clean initialized project. The fixture now verifies
  `aipi.readiness-report.v1`, local blockers such as `provider.anthropic.auth`
  and `model.capability_floors`, external-evidence gaps for model pressure and
  live subagent smoke, and strict-mode non-green behavior.
- Round 70: wrapped the npm audit release gate in `npm run release:audit`. The
  wrapper emits `aipi.npm-audit-release-check.v1`, distinguishes real audit
  failures from registry/audit endpoint unavailability, supports timeout/cache
  options, and fails strict release checks unless the audit status is `pass`.
- Round 71: added `npm run release:check` as the aggregate local release gate.
  It emits `aipi.release-check.v1`, runs `npm test`, `npm pack --dry-run --json`,
  and `npm run release:audit -- --json`, and preserves `external_unavailable`
  instead of treating registry/audit outages as a release pass.
- Round 72: added conservative date-mismatch conflict inference for business
  rules. Related rules that declare different valid dates for the same
  contextual role, such as invoice payment deadline dates, now produce
  `implicit date mismatch conflict` graph edges.
- Round 73: added conservative time-mismatch conflict inference for business
  rules. Related rules that declare different valid `HH:mm` values for the same
  temporal role, such as support escalation cutoff times, now produce
  `implicit time mismatch conflict` graph edges.
- Round 74: added conservative enum-value conflict inference for business rules.
  Related rules that declare different values for the same explicit object/field
  pair, such as `invoice status is paid` versus `invoice status is pending`, now
  produce `implicit enum value mismatch conflict` graph edges.
- Round 75: added conservative boolean-state conflict inference for business
  rules. Related rules that declare the same explicit subject as enabled versus
  disabled, such as enterprise account MFA for admin login, now produce
  `implicit boolean state mismatch conflict` graph edges.
- Round 76: added conservative cardinality conflict inference for business
  rules. Related rules that declare the same normalized subject as exactly one
  versus multiple, such as active subscriptions on a customer account, now
  produce `implicit cardinality mismatch conflict` graph edges.
- Round 77: broadened enum-value conflict inference beyond status/state fields.
  Explicit visibility/access/classification/mode/type/scope fields now reuse the
  same `implicit enum value mismatch conflict` edge, with coverage for public
  versus private report visibility.
- Round 78: broadened enum-value conflict inference for operational business
  fields. Explicit provider/channel/source/owner/region/locale/language/
  environment/method/currency fields now reuse the same enum edge, with coverage
  for Stripe versus Adyen checkout payment providers.
- Round 79: reduced false positives in threshold inference. Opposite min/max
  bounds now produce a conflict only when they share the same value or create an
  impossible range; compatible ranges such as `at least 3` and `at most 5` are
  ignored.
- Round 80: reduced another threshold false positive. Same-direction threshold
  refinements such as `at least 3` versus `at least 5`, or equivalent max/max
  bounds, are now treated as compatible instead of numeric mismatch conflicts.
- Round 81: added a console workflow wrapper. `aipi workflow [--target <dir>]
  [--json] ...` now exposes workflow list/status/start/run/execute outside an
  interactive Pi session, reusing the same run-state runtime as `/aipi-workflow`.
- Round 82: added a console profile wrapper. **Superseded by Round 20:** the
  wrapper and underlying permission profile runtime were removed by product
  decision.
- Round 83: added read-only memory inspection. `/aipi-memory` and `aipi memory
  [--target <dir>] [--json] ...` now expose memory status/refs/query and
  code-graph status without granting direct write access to `.aipi/memory`.

## Still runtime work

- Deepen lifecycle coverage beyond the current hook shell: provider-specific
  compatibility rules if a concrete provider requires them.
- Improve semantic quality of domain relationship inference for subtler
  conflicts beyond the deterministic alias/path-ref, polarity conflicts,
  modality conflicts, automatic-vs-manual conflicts, numeric conflicts,
  monetary conflicts, threshold direction conflicts, date conflicts, time
  conflicts, enum value conflicts, boolean state conflicts, sequence conflicts,
  cardinality conflicts, and historical-outcome layer.
- Provider token/cost accounting now records normalized metadata when providers
  expose it and can estimate missing cost from configured local pricing rates
  only when those rates have fresh source metadata; optional budget telemetry
  reports spend state and marks unpriced token usage as `cost_unknown`, but hard
  provider-call blocking still depends on concrete Pi provider-hook semantics.
  Remaining cost work is selecting/maintaining current concrete model price
  tables for the user's providers and running the pricing gate with
  `--require-rates` once those rates are intentionally configured.
- `npm run release:audit` is now a structured local gate, but it still depends on
  the npm audit registry endpoint being reachable before release.
- `npm run release:check` aggregates local gates, but credentialed model
  pressure, live smoke, official provider pricing maintenance, and reachable npm
  audit evidence remain external release inputs.
- Run `npm run readiness:credentialed -- --target <initialized-project>
  --strict` with approved provider credentials/spend before promoting discipline
  statuses from predicted to observed. The command still requires a real
  `AIPI_MODEL_PRESSURE_COMMAND`; live smoke remains opt-in through
  `AIPI_LIVE_SMOKE=1`.
- Anthropic OAuth package integration and sidecar inspection are present via the
  OAuth-only wrapper over the pinned `@ersintarhan/pi-toolkit` dependency and
  `/aipi-status`; credentialed `/login anthropic` plus a live Anthropic smoke
  still require explicit provider credentials/spend approval. Probe A used
  `openai-codex` credentials because
  the tested property was Pi event attribution, not model quality. Probe A'
  needs no LLM call because it invokes the guarded write tool directly.

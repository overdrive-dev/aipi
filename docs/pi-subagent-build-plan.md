# AIPI subagent system build plan

Audience: AIPI runtime implementers building the swarm backend.

Post-read action: build the AIPI-owned `aipi-agent-session` backend (in-process)
for write-capable workers, instead of depending on a third-party swarm package.

Current spike result: `/aipi-probe-a` returned `FAIL` for host `tool_call`
attribution — but Probe A' showed that attribution was never needed. A per-worker
write tool wrapped with an owned-file check (`createWriteToolDefinition` +
`wrapWriteToolWithOwnership`) blocks out-of-scope writes in-process, verified
against Pi 0.75.5 and re-checked against Pi 0.79.5 by the non-LLM real-SDK
worker toolset smoke. In-process `aipi-agent-session` is the default v1 backend;
`rpc_worker_process` now provides a process-boundary backend for guarded
workers. `per_worker_worktree` now provides an AIPI-managed scratch-copy backend
that syncs declared owned outputs back. `external`/`container` now provide a
fail-closed configured command adapter over the same RPC protocol; the runner
must supply real containment. See
`docs/probe-a-tool-call-attribution.md`.

S0/S1 implementation status: the coordinator now creates a Pi SDK
`createAgentSession()` worker with explicit `customTools`, `noTools: "all"`, an
allowlist of read-only tools plus the guarded `write`, a bounded context packet,
abort handling, and validated `aipi.step-result.v1` collection. This is the
spawn primitive. The workflow executor now has a bounded fan-out/reconciliation
slice for configured steps such as `review_swarm`, and model-class resolution is
passed into workers when a concrete route is available. Parent restart now
restores the latest subagent snapshot as interrupted work, and workflow adapters
redispatch matching interrupted workers from clean boundaries. `rpc_worker_process`
now executes the guarded worker protocol in a child Node process over
stdin/stdout. `per_worker_worktree` now prepares a scratch copy under
`.aipi/runtime/worktrees`, runs the same RPC worker protocol there, syncs
declared owned/artifact outputs back, and cleans the scratch directory unless
requested otherwise. `external`/`container` descriptors are rejected unless
AIPI_EXTERNAL_WORKER_COMMAND_JSON or AIPI_CONTAINER_WORKER_COMMAND_JSON is
configured. Basic `budget_timeout` aborts, coordinator lifecycle
traces, per-tool worker traces, and an explicit `accepted=false` steering
contract are implemented.

## Decision

Build our own subagent system around `aipi-agent-session` (in-process). Do not
take a hard dependency on
`pi-subagents`, `@tmustier/pi-agent-teams`, or `pi-messenger-swarm` for the
spawn/collect lifecycle.

Rationale (see `adversarial-claude.md` Round 4):

- The community packages model three different coordination shapes (push
  spawn/collect, pull task-board, channel mesh); none maps cleanly onto the
  single push adapter AIPI needs.
- Most of the hard work — context packets derived from the BDD contract,
  structured `aipi.step-result.v1` collection, owned-file enforcement, memory
  promotion authority, run limits — is AIPI-specific glue we write regardless of
  backend.
- Third-party packages execute code inside the Pi process; owning the backend
  removes that supply-chain surface.
- Reading `pi-subagents` (MIT) as a reference for lifecycle/cancel mechanics is
  cheaper and safer than depending on it.

This is **not** building a model runtime. Pi gives the worker agent loop through
`createAgentSession()`. We build a thin **coordinator** over in-process worker
sessions, each holding an owned-file-guarded write tool.

## Contract alignment

This plan implements the `session` runtime from `runtime-contract.json`:

- `agentRuntimes`: `controller` (the orchestrator), `skill` (in-session native
  Pi Skills), `session` (spawned workers - this plan).
- `subagentBackendOptions.spawnBackends`: `aipi-agent-session`,
  `rpc_worker_process`, `per_worker_worktree`, `external`, `container`, and
  `pi-subagents-adapter`.
- `subagentBackendOptions.coordinationTransports`: optional task-board/channel
  transports that do not replace spawn/collect.
- `subagentBackendOptions.stableToolSurface`: `aipi_spawn_agent`,
  `aipi_agent_status`, `aipi_collect_agent`, `aipi_cancel_agent`,
  `aipi_cleanup_agents`, `aipi_steer_agent`.
- `runtimeFit.subagentRule`: *"AIPI session agents are managed AgentSession or
  RPC workers built by the AIPI runtime."*

Required contract state: `subagentBackendOptions.preferredSpike` must remain
`"aipi-agent-session"`; Probe A' proved worker-local enforcement via tool
wrapping. The validator must fail if the active runtime contract references the
obsolete fabricated package name from Round 4 or if the preferred spike is not an
AIPI-owned backend.

## What Pi provides vs what AIPI builds

| Capability | Source |
|---|---|
| Agent loop (model, tools, streaming, system prompt) per worker | Pi — `createAgentSession()` |
| Custom tool registration / tool blocking | Pi — `registerTool()`, `tool_call` hook |
| Context / system-prompt injection | Pi — `before_agent_start`, `context` |
| Intra-runtime write serialization | Pi — `withFileMutationQueue` |
| Extension state persistence for resume | Pi — `pi.appendEntry`, session entries |
| Process-boundary worker backend | AIPI - child Node process over stdin/stdout |
| Per-worker scratch worktree isolation | AIPI - managed copy under `.aipi/runtime/worktrees` |
| External/container command adapter | AIPI - no-shell configured command over RPC protocol; runner supplies containment |
| Spawn N sessions + concurrency cap | AIPI |
| BDD-derived context packet per worker | AIPI |
| Structured `aipi.step-result.v1` collection | AIPI |
| Owned-file allocation + worker-boundary ownership check | AIPI |
| Opaque shell commands for build/format/test/codegen | AIPI - serialized controller/skill step in v1 |
| Reconciliation + memory promotion authority | AIPI |
| Run limits, loop bounds, cancel/timeout | AIPI |

The AIPI column is work we own regardless of backend, which is the core argument
for building our own.

## Architecture - v1 (`aipi-agent-session`, in-process)

The orchestrator extension instantiates N in-process `createAgentSession()`
workers, pumps them concurrently under a cap, and collects structured results.

```
controller (orchestrator)
  └─ SubagentCoordinator
       ├─ spawn(descriptor) ─► createAgentSession({ customTools: [guardedWrite, ...read], tools: names })
       │                         └─ inject context packet, run to completion
       ├─ concurrency cap (min(N, cores-2))
       ├─ collect() ─► parse aipi.step-result.v1 + artifact pointers
       ├─ cancel(id) ─► AbortSignal to the worker
       └─ persist run state ─► pi.appendEntry + .aipi/runtime/runs/{run_id}/
```

Start in-process: Probe A' proved a per-worker write tool wrapped with its
owned-file scope (`wrapWriteToolWithOwnership`) blocks out-of-scope writes without
host hooks. The same guarded protocol can now run through `rpc_worker_process`,
which gives a separate Node process but still shares the project root, or
through `per_worker_worktree`, which runs the child worker in a managed scratch
copy and syncs declared owned outputs back. Container or external isolation
is now the configured-command escalation path for untrusted work that needs OS
containment from an external runner.

## Adapter boundary

One coordinator interface, backed by `aipi-agent-session` now and other backends
later. The five stable tools map to coordinator operations:

```js
// SubagentCoordinator
spawn(descriptor)        -> { agent_id }          // aipi_spawn_agent
status(agent_id)         -> { state, tool, elapsed, lastSummary }  // aipi_agent_status
collect(agent_id)        -> { stepResult, artifacts }  // aipi_collect_agent
cancel(agent_id)         -> { cancelled, reassign[] }  // aipi_cancel_agent
cleanup(run_id)          -> { removed, retained }      // aipi_cleanup_agents
steer(agent_id, message) -> { accepted }          // aipi_steer_agent
```

Spawn descriptor (what the orchestrator passes, all AIPI-owned):

```js
{
  agent_id,                 // catalog id (runtime: session)
  model_class,              // resolved via model-capabilities, or host model fallback
  allow_fallback,           // false rejects unbound classes before allocation
  context_packet,           // BDD-rule-scoped excerpts from context-curator
  owned_files: [...],       // disjoint set; enforced via wrapped write tool
  artifact_target,          // .aipi/runtime/runs/{run_id}/steps/{step_id}/
  result_schema: "aipi.step-result.v1",
  budget: { tokens, wallclock_ms },
  isolation                 // see SW-4 decision
}
```

## Modules to build

Maps onto `pi-runtime-gates-hooks-map.md` "What To Add":

| Module | Responsibility |
|---|---|
| `runtime/subagents.js` | `SubagentCoordinator`; `aipi-agent-session` backend; the 5 tools |
| `runtime/owned-files.js` | Allocation registry; `wrapWriteToolWithOwnership` per-worker write guard |
| `runtime/context-builder.js` | Build the context packet from BDD rules + memory + step results |
| `runtime/run-state.js` | Persist/restore run state via `appendEntry` + `.aipi/runtime/runs` |
| `runtime/model-router.js` | Resolve `model_class` → provider/model via `pi.setModel` |
| `runtime/profile-policy.js` | `tool_call` / `user_bash` verdicts (ALLOW/BLOCK/APPROVAL_REQUIRED) |
| `runtime/lifecycle-hooks.js` | Session handoff markers, context pointers, tool/provider evidence logs |

## Host-model fallback

Current default for local interactive use: if a worker `model_class` is known or
unknown but not bound to a concrete provider/model, AIPI falls back to the
current host session model captured by lifecycle hooks. `model_select`,
`session_start`, and `before_agent_start` update
`SubagentCoordinator.setHostModel`; spawn then prefers
`SubagentCoordinator.getHostModel()` before trying tool-call `ctx` fields. The
captured value is passed as `descriptor.model` into `createAgentSession` and
into RPC/external worker descriptors. The bundled template now also binds every
model class in `.aipi/model-capabilities.json` to a concrete Anthropic default,
so host fallback is a runtime safety net and an override path, not the normal
template state.

Worker sessions are built with provider infrastructure, not just a model id.
The in-process backend and `rpc_worker_process` both create
`AuthStorage.create()` plus `ModelRegistry.create(authStorage)` and pass them to
`createAgentSession`. They also pass a `DefaultResourceLoader` with
`extensions/aipi/provider/anthropic-oauth-only.ts` so Anthropic OAuth requests
use the same cached credentials and request adapter as the parent AIPI session.

The capture is defensive because live Pi event fields can differ by surface:
AIPI first uses the model it is applying (`routing.model`), then event/context
shapes such as `event.model.id`, `event.currentModel`, `ctx.model`,
`ctx.getModel()`, and session model getters.

Strict mode remains available: `allow_fallback:false` rejects unknown classes
with `AIPI_UNKNOWN_MODEL_CLASS` and known-but-unbound classes with
`AIPI_MODEL_CLASS_UNRESOLVED` before owned-file allocation. Status and
`aipi.step-result.v1` provenance must show the real fallback target, for
example `model_resolved: "anthropic/claude-host"`, never the internal
`host-default` sentinel.

## Concurrency and owned-file enforcement

- Cap concurrent workers at `min(requested, cores - 2)`; queue the rest.
- Owned-file disjointness is **not** provided by `withFileMutationQueue` (that
  only serializes within one runtime; see `runtimeFit.mutationQueueRule`).
  Enforce it as: orchestrator allocates disjoint `owned_files` per worker ->
  every worker receives a write tool wrapped with that allocation -> a write
  outside the set is `BLOCK`ed before the real write tool executes.
- In-process workers sharing one working tree still need this check because they
  share the filesystem. `withFileMutationQueue` wraps the actual read-modify-
  write so two sibling tool calls in the same worker do not clobber.
- The default in-process backend does not pass a per-worker `cwd`. Every
  relative path is resolved against the shared project root used by the
  ownership registry. `rpc_worker_process` may run in a child process, but it
  still uses the shared root and owned-file guard. `per_worker_worktree` may use
  a private worker cwd inside the scratch copy and only syncs declared
  owned/artifact outputs back to the root.
- V1 session workers do not receive `bash` or `user_bash`. Shell is opaque to
  reliable write-target extraction, so build, format, test, codegen, and other
  shell work runs in serialized controller/skill steps after worker
  reconciliation. A worker that needs shell-level isolation must use a reviewed
  external/container runner configured through the JSON command adapter.

## State and resume (the hard part)

In-process workers die if the parent extension dies. Make runs reconstructable:

- Current: `runtime/lifecycle-hooks.js` writes active-run session markers,
  handoff artifacts, and evidence logs through `session_start`,
  `session_before_compact`, `session_before_tree`, fork/switch hooks, tool
  result hooks, and provider hooks. `session_start` also restores the latest
  `aipi.subagents.state` session entry, owned-file allocations, and persisted
  worker results; queued/running workers are marked `interrupted` because their
  in-memory processes cannot be revived safely. The coordinator also emits
  `aipi.subagents.event` traces for queued, started, done, failed, cancelled,
  budget timeout, restore transitions, and rejected steering attempts.
- Current: worker custom tools emit `tool_start`, `tool_end`, and `tool_error`
  traces with tool name and error status only; inputs/content are not persisted.
- Current: workflow adapters call `coordinator.dispatch(descriptor)` before
  ordinary spawn. If a restored interrupted worker matches `step_id`, catalog
  agent id, and `owned_files`, the old worker is marked `redispatched`, its
  owned-file allocation is released, and a fresh worker starts from the current
  descriptor/context.
- `session_before_compact` already preserves the active run pointer through a
  handoff artifact; interrupted worker redispatch avoids reviving stale
  in-memory processes mid-write.
- This is the criterion that decides whether in-process is enough. A process
  boundary now exists through `rpc_worker_process`; filesystem contention can
  escalate to `per_worker_worktree`; untrusted/high-impact work can escalate to
  a configured external/container runner when that runner supplies containment.

## Spike - acceptance criteria

Probe A' closed criterion zero (in-process tool-wrapping enforcement works).
Prove the six in-process criteria before building workflows on top.

0. Done: a per-worker wrapped write tool blocks out-of-scope writes in-process
   without host `tool_call` hooks (Probe A', `tools/test-probe-a-prime.mjs`).
1. Spawn one context-aware reviewer, one `rpc_worker_process` reviewer, one
   `per_worker_worktree` reviewer, and one configured `external` reviewer from
   one orchestrator turn.
2. Pass a different `model_class` to each and confirm distinct providers resolve
   or that host-model fallback is explicitly surfaced in provenance.
3. Collect both `aipi.step-result.v1` outputs + artifact pointers without either
   worker writing `.aipi/memory`.
4. `BLOCK` worker attempts to use `bash`, unknown mutating tools, missing-path
   structured writes, and writes outside `owned_files` via the wrapped write
   tool.
5. Cancel a long-running worker and confirm its tasks return for reassignment.
6. Done: kill/restart semantics reconstruct run state, preserve collected
   results, mark in-flight work interrupted, and redispatch without
   double-writing.

Pass criteria 1-6: swarm premise proven. Fail criteria 3-4: keep parallel write
workers disabled.

## Milestones

| Slice | Deliverable |
|---|---|
| S0 | Done: coordinator skeleton + `aipi_spawn_agent` (in-process workers) |
| S1 | Done for bounded workflow fan-out: concurrency cap + `collect` + reconciliation of structured step results |
| S2 | Owned-file allocation + worker-boundary enforcement (criteria 3-4) |
| S3 | Done: `cancel` + basic budget timeout + coordinator/tool traces (criterion 5) |
| S4 | Done: run-state restore + clean-boundary redispatch (criterion 6) |
| S5 | Done for bounded `review_swarm`: reconciliation pass in the orchestrator; broaden to more swarm stages later |
| S6 | Done for retention cleanup: `aipi_cleanup_agents` removes terminal workers, releases owned-file scopes, emits cleanup traces, and never deletes durable memory. Crash recovery remains covered by restore/interrupted redispatch. |
| S7 | Done for first process boundary: `rpc_worker_process` child Node worker with guarded write and structured result protocol |
| S8 | Done for scratch worktree boundary: `per_worker_worktree` managed copy, declared-output sync, and cleanup |
| S9 | Done for configured external/container adapter: no-shell JSON command, fail-closed config, and RPC result validation |

## Open decisions

- **Isolation escalation (SW-4).** V1 is decided: one shared project tree plus
  in-process per-worker wrapped write tools. `rpc_worker_process` adds a process
  boundary with the same owned-file guard. `per_worker_worktree` adds a managed
  scratch-copy filesystem boundary. `external`/`container` adds a configured
  command boundary; the remaining decision is which reviewed runner policy to
  use for each untrusted/high-impact workflow.
- **Concurrent in-process worker throughput.** Many concurrent
  `createAgentSession()` workers share one Node event loop and hit provider rate
  limits; the unit-tested fan-out path exists, but real provider throughput still
  needs live measurement.
- **Cost ceiling.** A full `feature.yaml` fan-out is many workers; add a
  per-run token budget that the coordinator enforces (tie to
  `runLimits`).

## What stays AIPI-owned

Never delegate to any backend (`runtimeFit.communityBackendRule`): BDD contract
authority, business-rule gap/conflict decisions, workflow stage transitions,
tool policy verdicts, production/deploy approval, owned-file allocation, durable
memory promotion, and deciding whether a worker result is accepted evidence.
Workers produce artifacts; the orchestrator evaluates and promotes.

## Test and eval plan

- Unit: coordinator lifecycle (spawn/collect/cancel/timeout), owned-file checks,
  run-state round-trip.
- Integration: criterion zero plus the six spike criteria as automated
  scenarios.
- Adversarial: a worker that tries to use `bash`, use an unknown mutating tool,
  write outside its scope, write `.aipi/memory`, or exceed its budget must be
  blocked. These are the wrapped-tool/policy invariants and should have explicit
  failing-first tests.

# Pi runtime gates and hooks map

Mapped against Pi docs latest on 2026-06-15. Treat this as a compatibility map
for the AIPI runtime, not as proof that enforcement exists before the extension
implements the hooks.

## Verdict

The current `aipi` plan is directionally correct: do not port Claude Code hook
names directly, and implement gates through a Pi-native extension.

The plan should be more explicit about the difference between:

- workflow gates: `aipi` product stages such as BDD coverage, TDD, review, and
  production approval;
- runtime hooks: actual Pi extension events such as `before_agent_start`,
  `context`, `tool_call`, `tool_result`, and session events;
- policy gates: enforcement decisions that block, modify, or audit risky tool
  calls.

## Hook Mapping

| aipi need | Primary Pi surface | Runtime behavior |
|---|---|---|
| Project trust before loading project resources | `project_trust` | Decide whether `.pi` project settings, resources, packages, and extensions may load. This is not a sandbox. |
| Load package/project resources | `resources_discover` | Add `aipi` skills, prompt templates, and themes from package or project paths. |
| Start/resume run state | `session_start` | Rebuild in-memory run state from session entries, `.aipi/runtime`, and Markdown memory. |
| Clean up graph/watchers/processes | `session_shutdown` | Close session-scoped resources started by `session_start` or tools. |
| Natural-language routing | `input` plus extension commands | Convert user intent into workflow routing before agent turn starts. Commands remain deterministic overrides. |
| Inject BDD/profile/memory context | `before_agent_start` | Add persistent run message and modify system prompt for the current turn. |
| On-demand context pruning/injection | `context` | Build smallest useful context packet before each LLM call. |
| Provider/model payload audit | `before_provider_request` | Inspect or patch serialized provider payload for debugging, model compatibility, or emergency policy. |
| Provider status/cost/rate telemetry | `after_provider_response` | Capture status, headers, rate limits, and provider-level evidence. |
| Model class routing | `pi.setModel`, `pi.setThinkingLevel`, `model_select`, `thinking_level_select` | Resolve `orchestrator-heavy`, `code-strong`, etc. from event class, event agent, or active workflow step; record drift/unresolved class-only/capability-floor routes in `.aipi/runtime/model-routing.jsonl`. |
| Anthropic OAuth adapter | AIPI OAuth-only wrapper over pinned `@ersintarhan/pi-toolkit` adapter | Activate the toolkit's Claude OAuth adapter for Pi's built-in `anthropic` provider before AIPI resolves Anthropic-backed model classes, without autoloading the toolkit's broad provider/search index by default. |
| Spawned-session tool baseline | `pi.setActiveTools` | Set the allowed tool baseline when creating a managed worker session. It is session-wide and persistent, not a per-turn stage gate. |
| Per-call tool policy by stage | `tool_call` | Enforce stage, role, production, secret, and general project policy before each parent-session tool call. |
| Block production or destructive actions | `tool_call` | Inspect/mutate/block `bash`, `write`, `edit`, custom tools, and MCP-like tools before execution. |
| Worker owned-file scopes | guarded worker write tool | Forked workers receive read/grep/find/ls built-ins plus AIPI's guarded child `write` extension, backed by `AIPI_SUBAGENTS_OWNED_FILES`; Probe A' proved the primitive blocks out-of-scope writes without host attribution. |
| Audit and normalize tool output | `tool_result` | Attach evidence, classify errors, redact sensitive output, or mark policy decisions. |
| Progress telemetry | `tool_execution_start/update/end` | Record run events and live UI status for long tool calls. |
| User shell commands | `user_bash` | Intercept `!` and `!!` commands, apply the same policy as agent bash, or route to remote/sandbox ops. |
| Branch/fork safeguards | `session_before_switch`, `session_before_fork` | Prevent losing active run state or create handoff artifacts before session changes. |
| BDD-aware compaction | `session_before_compact`, `session_compact` | Preserve accepted contract, open blockers, file ownership, and memory candidates. |
| Tree navigation summaries | `session_before_tree`, `session_tree` | Attach branch summaries that keep run decisions recoverable. |
| Durable session markers | `pi.appendEntry`, `pi.setLabel`, `pi.setSessionName` | Persist run metadata in session history without treating it as project memory. |

## Gate Enforcement Model

The parent-session permission policy layer was intentionally removed. `tool_call`
is no longer used to block normal interactive source edits, production commands,
secret paths, or shell commands through an AIPI profile/stage matrix.

Workflow gates still run inside workflow execution: a step can emit
`policy_decision: ALLOW`, `BLOCK`, or `HUMAN_REVIEW_REQUIRED`, and the executor
records those workflow-control decisions in run state. These decisions stop or
branch workflows only; they do not intercept ordinary parent-session tools.

Parallel worker correctness remains separate. Session workers receive
owned-file-guarded write tools so one worker cannot write outside its allocated
files, but that mechanism is not a parent-session permission policy.

`extensions/aipi/runtime/lifecycle-hooks.js` now covers the first broader Pi
lifecycle slice: `session_start`, session transition handoff artifacts,
subagent snapshot restore as interrupted work, `before_agent_start` context
pointers, natural-language `input` routing for recognized workflow intents,
blocker-answer recording to `USER-INPUT.jsonl`, `context` hook
pruning/injection, `model_select`/`thinking_level_select` model-class routing
with manual-drift, unresolved-route, and capability-floor telemetry,
`user_bash` policy gating, `tool_result` redaction/logging, active-run
compaction summaries, and safe provider telemetry. Restored
interrupted workers are redispatched by the workflow adapter through
`coordinator.dispatch`.

Model capability floors are local readiness gates. Before beta/adversarial-review
readiness, `.aipi/model-capabilities.json` must map each model class to a
provider/model and include capability evidence satisfying
`.aipi/model-classes.yaml`; otherwise `/aipi-status` reports
`model.capability_floors` as a blocker.

Use built-in tool overrides or wrapped tool definitions when `tool_call` is not
enough:

- wrapping `read`, `write`, `edit`, `bash`, `grep`, `find`, or `ls` with
  stronger access control;
- enforcing per-worker owned-file scopes in spawned `AgentSession` workers by
  giving each worker only a write tool wrapped with `wrapWriteToolWithOwnership`;
- routing filesystem or shell operations into SSH, container, or sandbox
  operations;
- participating in the built-in UI/rendering path while replacing execution.

Custom mutating tools inside one runtime should participate in Pi's file
mutation queue so sibling tool calls do not overwrite each other.

Cross-agent file safety is separate. Managed sessions or RPC child processes
need orchestrator-owned file allocation, a worker-local ownership check, and a
shared lock/ownership registry. For v1 `aipi-agent-session`, that check lives in
the wrapped write tool, not in host-level `tool_call` attribution. The file
mutation queue is not the swarm-level disjointness mechanism.

## Swarm and Subagents

Pi docs expose SDK, RPC mode, event streaming, and AgentSession APIs, but the
core docs do not describe native Claude-style `SubagentStart` or
`SubagentStop` events.

For `aipi`, treat native Pi Skills as the default for read-only single-shot
roles and model only true workers as `aipi_spawn_agent` managed sessions. The
managed-session backend can be one of:

1. SDK `AgentSession` in-process sessions with worker-local wrapped write tools.
2. `rpc_worker_process` child Node sessions for stronger process-level
   supervision, still using the AIPI owned-file guard.
3. `per_worker_worktree` managed scratch-copy sessions for filesystem contention
   reduction with declared-output sync, still without OS/container isolation.
4. Configured `external`/`container` command adapters for reviewed runners that
   provide OS, VM, remote, or credential boundaries outside Pi.
5. A compatible community subagent package if it is stable enough at the time
   of implementation.

Current package read:

- `aipi-agent-session` is the default write-capable backend after Probe A'.
- `rpc_worker_process` is implemented as the first child-process backend.
- `per_worker_worktree` is implemented as the first managed scratch-copy backend.
- `external`/`container` are implemented as fail-closed JSON command adapters
  over the same RPC worker protocol. AIPI validates config and results; the
  configured runner must provide the actual containment.
- `pi-subagents` packages are the strongest spawn/collect references.
- `@tmustier/pi-agent-teams` is a coordination/task-board reference, not a
  drop-in spawn backend.
- `pi-messenger-swarm` is a file-based channel/task eventing reference, not a
  subagent lifecycle backend.
- `oh-my-pi` is a broader fork-level architecture reference for isolation and
  swarm design, not a dependency target.

See `docs/pi-swarm-package-evaluation.md` for the adapter decision.

The orchestrator remains the single writer for shared memory and state. Spawned
agents return artifacts, not direct authority over `.aipi/memory` or workflow
stage transitions.

Criterion zero is closed in two parts:

- Probe A showed host-level `tool_call` attribution does not observe SDK-created
  worker writes.
- Probe A' showed host attribution is unnecessary: a worker can be given a Pi SDK
  write tool wrapped with `wrapWriteToolWithOwnership`, and that tool blocks
  out-of-scope writes before delegating to the real write tool.

Observed result on Pi 0.75.5: Probe A' returned `IN_PROCESS_VIABLE`. The
worker-session toolset is now re-checked against Pi 0.79.5 by
`npm run test:subagents-real-sdk`. Therefore the preferred default backend is
`aipi-agent-session`; `rpc_worker_process` is available when the descriptor asks
for a process boundary, `per_worker_worktree` when it needs a scratch copy, and
`external`/`container` when a reviewed command adapter is configured.

After criterion zero, the package now proves spawn, cap, await, collect,
owned-file blocking, artifact collation, a bounded fan-out/reconciliation step,
child-process RPC worker execution, basic budget timeouts, and coordinator
lifecycle traces under test. Abort exists
at the coordinator surface. Parent restart restores the latest subagent
session-entry snapshot and marks queued/running workers as `interrupted`;
matching workflow steps redispatch them from a clean boundary instead of trying
to revive dead in-memory processes.

For the v1 single-worktree backend, session workers do not receive `bash` or
`user_bash`. Opaque shell commands are not path-checkable enough for parallel
owned-file guarantees. Run shell/build/format/test/codegen as serialized
controller or skill steps, or move those workers to an RPC/worktree/external
backend that still denies opaque shell tools inside AIPI. Shell-capable work
belongs inside a reviewed external/container runner.

## What To Add To aipi

1. `runtime-hooks.ts`: central extension module that registers all Pi events.
2. Parent-session permission policy modules are no longer planned for this
   package. Round 20 removed them by product decision.
3. Workflow decisions still use `ALLOW`, `BLOCK`, or `HUMAN_REVIEW_REQUIRED`
   inside `aipi.step-result.v1` to control workflow execution only.
4. `runtime/run-state.ts`: restores run state from session entries and
   `.aipi/runtime/runs`. The current package implements the filesystem half in
   `extensions/aipi/runtime/run-state.js` through `/aipi-workflow`; subagent
   session-entry restore is implemented in `runtime/lifecycle-hooks.js`, while
   broader run-state session-entry restore remains future Pi-hook work.
5. `runtime/step-result.ts`: validates `aipi.step-result.v1`, evidence rungs,
    skip conditions, and policy decisions before a workflow can advance. The
    current package implements this in `extensions/aipi/runtime/step-result.js`;
    the quick executor uses it after each step result.
6. `runtime/context-builder.ts`: implements bounded context packets from BDD
   contracts, prior step results, artifact excerpts, Markdown memory, graph
   status, and provenance. The current package implements the workflow-executor
   context path in `extensions/aipi/runtime/context-builder.js`; Pi
   `before_agent_start` and `context` hooks now manage compact run pointers and
   prune duplicate AIPI runtime context noise.
7. `runtime/compaction.ts`: preserves BDD contract and run state during
   compaction and tree navigation. The current package implements the active-run
   `session_before_compact` summary in `runtime/lifecycle-hooks.js`.
8. `runtime/subagents.ts`: implements `aipi_spawn_agent` on SDK/RPC sessions.
   The current package implements the S0 in-process `AgentSession` path in
   `extensions/aipi/runtime/subagents.js`.
9. `runtime/model-router.ts`: maps agent class to provider/model/thinking and
   applies it through Pi model APIs. The current package implements the first
   resolver in `extensions/aipi/runtime/model-router.js`: explicit env override
   or compatible current-session model, otherwise class-only descriptor.
10. `runtime/observability.ts`: writes JSONL run events from tool/session/model
    hooks.
11. Removed by design: parent-session profile/policy runtime and wrapper
    commands. Do not reintroduce them unless a new product decision opens a new
    review round.
12. `runtime/lifecycle-hooks.ts`: registers session, `input`,
    `before_agent_start`, `context`, `user_bash`, `tool_result`, provider
    telemetry, blocker-answer recording, and subagent snapshot-restore handlers.
    The current package implements this in
    `extensions/aipi/runtime/lifecycle-hooks.js`.
13. `runtime/project-init.ts`: `/aipi-init` scaffolding for project-local
     `.aipi` templates. The current package implements this in
     `extensions/aipi/runtime/project-init.js`; project-local `.pi/settings.json`
     install helpers remain future work.
14. `runtime/provider-auth.ts`: validates pinned Anthropic OAuth package
     presence, records sidecar location, and reports whether `/login anthropic`
     has been completed before Anthropic-backed spike runs. The current package
     implements this in `extensions/aipi/runtime/provider-auth.js` and exposes it
      through `/aipi-status`.
15. `runtime/aipi-tools.ts`: registers P3 tools for Markdown memory query,
     business-rule lookup/gap classification, lexical callers/impact, kanban
     events, and approval-gated memory promotion. The current package implements
     this in `extensions/aipi/runtime/aipi-tools.js`.
16. `runtime/capabilities.ts`: emits the `verified`/`wired`/`specification`
     report consumed by `/aipi-status`. The current package implements this in
     `extensions/aipi/runtime/capabilities.js`.

## Corrections To Keep In Mind

- Pi project trust is an input-loading gate, not a runtime security boundary.
- Pi has no built-in sandbox; isolation must come from container/VM/remote
  execution or a policy-controlled shell/tool layer.
- Do not rely on prompt instructions alone for production protection.
- Treat `tool_call` as an in-process policy gate. Use external containment and
  least-privilege credentials for real production or unattended boundaries.
- Do not assume subagents are native Pi core events; implement them as managed
  sessions.
- Prefer native Pi Skills for read-only single-shot roles before spawning a
  separate session.
- Use session entries for resumable runtime state, but keep durable project
  memory in versioned Markdown.

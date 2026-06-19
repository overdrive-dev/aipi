# Pi swarm package evaluation

Audience: AIPI runtime implementers deciding whether to build, borrow, or adapt
a subagent backend.

Post-read action: build the first swarm spike with the correct backend model and
know which external packages are references versus dependencies.

## Verdict

Build the default write-capable backend as AIPI-owned `aipi-agent-session`, with
`rpc_worker_process` available as an AIPI-owned child-process backend and
`per_worker_worktree` available as an AIPI-managed scratch-copy backend.
`external`/`container` are configured command adapters over the same RPC worker
protocol; the configured runner supplies real containment.

Probe A on Pi 0.75.5 showed host extension hooks do not observe mutating
`tool_call` events from SDK-created worker sessions. Probe A' then tested the
actual owned-file mechanism and proved `aipi-agent-session` is viable: workers
receive a Pi SDK write tool wrapped with their owned-file scope, so out-of-scope
writes are blocked before the real write tool executes.

Use external packages as references only:

1. Use `pi-subagents` packages as the closest spawn/collect reference set.
2. Use `@tmustier/pi-agent-teams` as a task-board/team coordination reference.
3. Use `pi-messenger-swarm` as a file-based channel/task eventing reference.
4. Use `oh-my-pi` as a broader fork-level reference for isolation and swarm
   architecture, not as a drop-in Pi package dependency.

Do not install any of them automatically in AIPI templates. Pi packages execute
code inside Pi and must be source-reviewed before project or global
installation.

## Corrected Package Roles

| Package | AIPI role | Why |
|---|---|---|
| `aipi-agent-session` | Initial write-capable backend | Probe A' proved in-process owned-file enforcement via wrapped write tools. |
| `rpc_worker_process` | Implemented process-boundary backend | Runs the guarded worker protocol in a child Node process over stdin/stdout. It is process supervision, not per-worker filesystem containment. |
| `per_worker_worktree` | Implemented scratch worktree backend | Copies the project into `.aipi/runtime/worktrees`, runs the RPC worker there, syncs declared owned/artifact outputs back, and cleans the scratch directory. It is not OS/container isolation. |
| `external`/`container` command adapter | Implemented configured boundary | Uses AIPI_EXTERNAL_WORKER_COMMAND_JSON or AIPI_CONTAINER_WORKER_COMMAND_JSON to run the same RPC protocol without shell interpolation. Useful only when the configured runner provides OS containment, remote sandboxing, credentials isolation, and explicit merge-back policy. |
| `pi-subagents` | Spawn/collect reference family | Real package name and install target for Pi subagent behavior; useful for delegation UX, reviewers, background jobs, artifacts, and cancellation patterns. |
| `@tintinweb/pi-subagents` | Parallel/steering reference | Useful reference for isolated sessions, custom agent types, foreground/background runs, mid-run steering, resume, and model/thinking-level overrides. |
| `nicobailon/pi-subagents` | Async/artifact/cancel reference | Useful reference for async delegation, truncation, artifacts, session sharing, and parallel reviewer workflows. |
| `@tmustier/pi-agent-teams` | Optional coordination transport reference | Models leader/teammate task boards, dependencies, auto-claim, status, worktrees, and quality-hook loops. It is not a spawn/collect backend. |
| `pi-messenger-swarm` | Optional channel/task transport reference | Provides project-local channels, durable named channels, task lifecycle, and JSONL-style event sourcing. It is not a subagent lifecycle backend. |
| `oh-my-pi` swarm/isolation pieces | Architecture reference | Useful for studying stronger harness-level isolation and swarm design, but it is a broader fork surface than AIPI should vendor now. |

## Backend Shape

AIPI has one canonical subagent lifecycle model for v1:

```
spawn -> status -> collect
      -> cancel
      -> steer
```

This push-style model fits `rpc_worker_process`, `aipi-agent-session`, and
`pi-subagents`-style packages. It does not fit every coordination package.

`@tmustier/pi-agent-teams` is pull/task-board shaped: the leader posts tasks and
idle workers claim unblocked work. `pi-messenger-swarm` is channel/mesh shaped:
agents coordinate through evented messages. Those can be layered under AIPI as
coordination transports later, but they are not interchangeable with
spawn/collect.

## Isolation Decision

V1 uses one shared working tree plus AIPI-owned file scopes, enforced by the
worker's wrapped write tool:

- the orchestrator allocates disjoint `owned_files`;
- every worker receives a write tool wrapped with `wrapWriteToolWithOwnership`;
- an out-of-scope write is blocked before delegating to the real Pi write tool;
- a shared ownership registry prevents overlap;
- `withFileMutationQueue` remains only intra-runtime serialization.

Do not borrow community git-worktree orchestration blindly. AIPI's
`per_worker_worktree` is deliberately narrower: a managed scratch copy plus
declared-output sync. Git worktrees, containers, and external sandboxes still
need explicit merge-back, conflict, credential, and runner-review policies
before becoming default execution backends.

## What AIPI Should Borrow

From `pi-subagents`-style packages:

- focused child agents for code review, scouting, implementation, and parallel
  audits;
- context modes such as fresh/forked/context-aware delegation;
- async jobs with status/result collection;
- artifact files as the durable output path;
- cancellation or interruption mechanics;
- per-worker model/tool/system-prompt overrides;
- optional steering for long-running workers.

From `@tmustier/pi-agent-teams`:

- leader-owned delegation model;
- task state with dependencies and blocked status;
- auto-claim only for unblocked tasks;
- worker status and cleanup primitives;
- quality-hook failure policies such as warn, follow-up, reopen, and capped
  reopen loops.

From `pi-messenger-swarm`:

- event-sourced channel records;
- named durable channels such as a memory channel;
- task lifecycle events such as claim, progress, done, and block;
- no-daemon file coordination;
- session resume through persisted channel/task state.

## What AIPI Must Own

AIPI must not delegate these responsibilities to a generic swarm package:

- accepted BDD contract authority;
- business-rule gap/conflict decisions;
- workflow stage transitions;
- tool policy verdicts;
- production/deploy approval gates;
- owned-file allocation;
- durable memory promotion into `.aipi/memory`;
- deciding whether a subagent result is accepted evidence.

Subagents produce artifacts. The orchestrator evaluates and promotes.

## Adapter Contract

Any spawn/collect backend must implement the same AIPI-level operations:

| Operation | Required behavior |
|---|---|
| `spawn` | Start a session agent with explicit runtime, model class, context packet, shared project root, owned files, and artifact target. |
| `status` | Return live state, current tool/action when available, elapsed time, and last output summary. |
| `collect` | Return structured output and artifact pointers without writing durable memory. |
| `cancel` | Abort or stop a worker and mark its open tasks for orchestrator reassignment. |
| `steer` | Send a bounded follow-up only when the workflow permits changing the assignment. |
| `cleanup` | Remove transient run artifacts only after run retention policy allows it. |

Task-board or channel transports can support the coordinator, but they do not
replace this contract and must not be listed under `spawnBackends`.

## Spike Plan

Run the first write-capable spike against AIPI-owned `aipi-agent-session`.

The spike must prove:

- criterion zero result: Probe A' showed in-process tool-wrapping enforcement is
  viable, so the spike starts with `createAgentSession({ tools: [...] })`;
- spawn one context-aware reviewer and one isolated reviewer from one
  orchestrator turn;
- pass different model classes to each worker;
- collect both `aipi.step-result.v1` outputs and artifact pointers;
- prevent either worker from writing `.aipi/memory`;
- cancel a long-running worker;
- block a worker write outside its owned-file scope through the wrapped write
  tool;
- preserve enough state to resume after parent session restart.

After the AIPI-owned spike is measured, compare behavior against the real
`pi-subagents` packages. Borrow implementation ideas only where they reduce code
without giving up AIPI's BDD, policy, or memory authority.

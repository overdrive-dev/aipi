# Probe A': in-process owned-file enforcement

Audience: AIPI runtime implementers wiring owned-file enforcement for in-process
(`aipi-agent-session`) workers.

Post-read action: enforce owned files by giving each worker a wrapped write tool
at session creation; use `rpc_worker_process` only when a process boundary is
needed, and use `per_worker_worktree` when a managed scratch-copy filesystem
boundary is enough. Neither replaces container/OS isolation.

## Why this probe exists

Probe A asked whether *host extension hooks* can attribute child-session
`tool_call` events to a worker, found they cannot, and initially over-weighted
an RPC-first answer. But host attribution was never the mechanism the
owned-file design used. The design always gave each worker a tool that checks
ownership before writing. Probe A' tests that mechanism directly.

See `docs/probe-a-tool-call-attribution.md` for the superseded conclusion.

## Question

Can a worker be prevented from writing outside its owned-file scope **in-process**,
without relying on host hooks or `tool_call` attribution?

## Mechanism

Pi's SDK (`@earendil-works/pi-coding-agent`) exports the tool-construction
primitives needed: `createWriteToolDefinition`, `defineTool`,
`wrapRegisteredTool`/`wrapRegisteredTools`, `createCodingTools`.

A worker is created with `createAgentSession({ tools: [...] })`, so AIPI controls
exactly which tools it holds. Give it a **write tool wrapped with its owned-file
scope** instead of the built-in write:

```js
import { wrapWriteToolWithOwnership } from "extensions/aipi/runtime/owned-files.js";

const def = sdk.createWriteToolDefinition();
const guardedWrite = wrapWriteToolWithOwnership(def, { registry, agentId });
// createAgentSession({ tools: [guardedWrite, ...readTools] })
```

The wrapper checks `registry.owns(agentId, params.path)` before delegating to the
real write `execute`. An out-of-scope write is blocked before it runs; the worker
has no unguarded write to fall back to. Enforcement is per-worker by closure, with
no host attribution required. `wrapWriteToolWithOwnership` is the canonical
enforcement primitive in `owned-files.js`.

## Harness

- `extensions/aipi/runtime/probe-a-prime.js` — `runProbeAPrime()` builds the
  guarded write tool from the real SDK write tool and exercises block/allow;
  `classifyInProcessEnforcement()` returns the verdict.
- `tools/test-probe-a-prime.mjs` — unit test of the wrapper and classifier with a
  spy tool (no SDK); wired into `npm test` as `test:probe-a-prime`.

Probe A' is runnable **without an LLM call**: enforcement lives in the tool's
`execute`, so it is tested by invoking the guarded tool directly.

## How to run

Logic only (no SDK, CI):

```text
npm run test:probe-a-prime
```

Through AIPI/Pi:

```text
/aipi-probe-a-prime
```

Against the real Pi SDK write tool (no LLM call):

```text
AIPI_PI_SDK_PATH=<...>/@earendil-works/pi-coding-agent/dist/index.js \
  node -e "import('./extensions/aipi/runtime/probe-a-prime.js').then(m => m.runProbeAPrime({ projectRoot: process.cwd() }).then(r => console.log(r.verdict)))"
```

## Verdicts

- `IN_PROCESS_VIABLE`: a per-worker guarded write tool blocked an out-of-scope
  write (the real write never executed) and allowed an in-scope write.
- `IN_PROCESS_NOT_VIABLE`: tool-level enforcement could not be demonstrated; do
  not enable write-capable workers without a stronger external boundary.

## Observed result

Original environment: Pi `0.75.5`. Run against the real SDK write tool, no LLM
call.

```text
IN_PROCESS_VIABLE
write_tool_factory=true  blocked_out_of_scope=true
inner_skipped_on_block=true  allowed_in_scope=true
```

The real Pi write tool is `write` with the `path` field; the guarded wrapper
blocked a foreign path (file not created) and allowed the owned path (file
written by the real tool).

Current regression smoke: `npm run test:subagents-real-sdk` creates a real Pi
0.79.5 `AgentSession` with `noTools: "all"`, read-only tools plus the guarded
custom `write`, then asserts the active worker toolset is exactly
`find,grep,ls,read,write`, without `bash`/`edit`, and verifies block/allow write
behavior without making an LLM call.

## Decision

- v1 write-worker backend: **`aipi-agent-session`** (in-process).
- Owned-file enforcement: **wrap each worker's write tool** with
  `wrapWriteToolWithOwnership`, not a host `tool_call` hook.
- `rpc_worker_process` is implemented for a child-process boundary using the
  same owned-file guard.
- `per_worker_worktree` is implemented for a managed scratch-copy boundary with
  declared-output sync.
- `external`/`container` are implemented as fail-closed configured command
  adapters over the same RPC protocol; real containment is supplied by the
  configured runner.

Recorded in `runtime-contract.json` (`subagentBackendOptions.preferredSpike`,
`criterionZero`, `isolationModel`) and enforced by the template validator.

## Scope and what remains

Probe A' proves the enforcement **primitive** works against Pi's real write tool.
S0 now wires that primitive into `#spawnWorkerSession`: it starts a
`createAgentSession()` with the guarded tool set, injects the context packet, and
collects `aipi.step-result.v1`. What remains is live LLM verification inside Pi
and then workflow-level fan-out/reconciliation.

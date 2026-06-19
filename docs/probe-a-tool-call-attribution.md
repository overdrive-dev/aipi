# Probe A: tool-call attribution

Audience: AIPI runtime implementers deciding whether `aipi-agent-session` can
enforce owned-file policy for spawned workers.

> **Correction (2026-06-16) — the FAIL stands, the conclusion does not.**
> Probe A measured whether *host extension hooks* observe child-session
> `tool_call` events (they do not). But host attribution was never the
> enforcement mechanism the owned-file design used. **Probe A'** proved in-process
> enforcement works by giving each worker a write tool wrapped with its
> owned-file scope (`wrapWriteToolWithOwnership`), which blocks out-of-scope
> writes before execution with no host hooks. The v1 backend is
> `aipi-agent-session` (in-process); `rpc_worker_process` and
> `per_worker_worktree` are optional stronger AIPI-owned backends; `external`
> and `container` are configured command adapters for reviewed external
> runners. See
> `docs/probe-a-prime-in-process-enforcement.md`.

## Purpose

Probe A answers one question:

Can host-level Pi `tool_call` events from spawned SDK `AgentSession` workers be
attributed to the specific worker or session that made the call?

This is criterion zero for the in-process swarm backend. Without worker
attribution, a shared owned-file registry cannot safely decide whether a write
belongs to the caller's allocated scope.

## Command

Run from a Pi session after the package is loaded:

```text
/aipi-init
/login anthropic
/aipi-status
/aipi-probe-a
```

Optional commands:

```text
/aipi-probe-a status
/aipi-probe-a --dry-run
```

## What It Does

The probe:

1. creates a probe directory under
   `.aipi/runtime/probes/tool-call-attribution/{{ probe_id }}/`;
2. records host Pi events including `tool_call`, `tool_result`, and
   `tool_execution_*` into `events.jsonl`;
3. dynamically imports Pi's SDK from `@earendil-works/pi-coding-agent`;
4. starts two SDK workers with only the `write` tool active;
5. asks each worker to write a different marker file in the probe directory;
6. compares host `tool_call` events against the expected worker marker paths;
7. writes `PROBE-A-RESULT.json` and `PROBE-A-RESULT.md`.

The probe does not print tokens, auth headers, or credential material.

## Verdicts

- `PASS`: host `tool_call` events covered all probe workers and carried distinct,
  stable worker/session identity.
- `PARTIAL`: host hooks saw both workers' tool calls, but no distinct identity
  was detected.
- `FAIL`: host hooks did not observe every worker's tool calls.
- `BLOCKED`: the runtime could not execute the probe, usually because the SDK or
  authenticated model path was unavailable.

## Decision Rule

- `PASS`: continue implementing `aipi-agent-session` and wire owned-file
  enforcement to worker identity.
- `PARTIAL`: do not enable parallel write workers until identity can be injected
  or proven by another Pi-supported path.
- `FAIL` of host attribution does **not** by itself require an RPC worker; it
  only rules out host-hook enforcement. Test tool-level enforcement (Probe A')
  before escalating; only a Probe A' failure would justify abandoning
  worker-local write wrapping.

## Observed Result

Run: `20260616T020015Z-a075bd`

Environment:

- Pi: `0.75.5`
- Provider/model: `openai-codex/gpt-5.4-mini`
- Project root: temporary Probe A project

Verdict: `FAIL`

Evidence:

- host `tool_call` events: `0`
- child tool events: `4`
- both worker files were written successfully by child sessions
- child events carried distinct session ids, but host extension hooks did not
  observe the worker `tool_call` events before execution

Interpretation (corrected 2026-06-16): the host extension genuinely does not see
child-session `tool_call` events — but the owned-file design never relied on that.
Probe A' (in-process tool wrapping) returned `IN_PROCESS_VIABLE`, so the v1
backend is `aipi-agent-session`. The original "implement `aipi-rpc-worker`"
decision is withdrawn. Later AIPI work added `rpc_worker_process` as a separate
process-boundary backend and `per_worker_worktree` as a managed scratch-copy
backend; this Probe A result still only says host hooks are not the owned-file
enforcement mechanism.
See `docs/probe-a-prime-in-process-enforcement.md`.

## Pi Surfaces Used

The probe is based on Pi's documented extension and SDK surfaces:

- extension hooks and `tool_call` interception;
- `pi.registerCommand`;
- SDK `createAgentSession()`;
- SDK session event subscription.

The probe exists because the docs do not guarantee that host extension hooks can
observe and attribute tool calls from SDK sessions created inside an extension.

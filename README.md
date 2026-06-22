# aipi

A BDD-contract agent harness for [Pi](https://pi.dev). `aipi` turns business
intent into explicit BDD contracts, then runs staged workflow gates
(plan → TDD → implement → review → verify → promote) with a swarm of specialist
agents — keeping business-rule and memory authority on the AIPI side and
delegating technical execution.

It ships as a Pi package: an extension, a CLI wrapper, and a `.aipi/` project
overlay of workflows, agents, disciplines, protocols, and Markdown memory.

## Status

Alpha. What exists today:

- The `.aipi` template system (workflows, agents, disciplines, protocols,
  memory, model classes) and a machine-readable `runtime-contract.json`, all
  enforced by a structured validator + CI.
- A Pi extension with working commands: `/aipi-init`, `/aipi-status`,
  `/aipi-workflow`, `/aipi-memory`, `/aipi-effort` (alias `/aipi-models`), `/aipi-mcp`, `/aipi-probe-a`,
  `/aipi-probe-a-prime`.
- An optional MCP bridge extension. When a project has `.aipi/mcp.json`, the
  `aipi` wrapper starts configured stdio MCP servers and exposes their tools to
  Pi as `mcp__<server>__<tool>`. Linear is supported through `mcp-remote`.
- A workflow executor: `/aipi-workflow run <name>` starts and executes workflow
  YAML with structured gates, required-artifact checks, context packets,
  run-limit enforcement, executor-owned controller artifact writes, and an S0
  worker handoff for `quick_change`.
- The S0/S1 `aipi-agent-session` backend: the coordinator can spawn in-process
  Pi `AgentSession` workers with read-only tools plus a guarded `write`, collect
  structured `aipi.step-result.v1`, and reconcile configured fan-out steps such
  as `review_swarm`. Worker budget timeouts and lifecycle traces are persisted
  as session entries.
- Parent-session permission profiles and the `tool_call` approval gate were
  intentionally removed. Interactive local source edits are no longer blocked by
  AIPI profile/stage policy; workflow gates still control workflow execution, and
  worker owned-file guards still protect parallel worker assignments.
- Runtime lifecycle hooks preserve active run pointers on session transitions,
  restore subagent state snapshots as interrupted work, inject and prune compact
  AIPI context pointers before provider calls, route recognized natural-language
  input to workflow status, active-run continuation, blocker-answer resume, or
  workflow start, observe `user_bash` without permission-policy blocking, redact obvious
  provider-payload secrets, redact/log tool results, provide AIPI compaction
  summaries, and record provider telemetry without storing provider payloads.
- P3 AIPI tools are registered for memory query, rule lookup/gap,
  SQLite-backed callers/impact with lexical fallback, kanban events, and
  approval-gated memory promotion.
- `/aipi-status` reports capability states as `verified`, `wired`, or
  `specification`, plus a readiness report that separates blockers from
  external evidence still needed for model-backed pressure and live worker
  smoke checks. It recognizes durable baseline+verify pressure reports and
  live-smoke reports once those external checks are run.
- The owned-file enforcement primitive (`wrapWriteToolWithOwnership`), proven
  in-process against the real Pi SDK (see Probe A′ below).

Current regression coverage re-checks the worker-session toolset against Pi
0.79.5 with `npm run test:subagents-real-sdk`.

Claim evidence anchors for the live runtime surfaces are
`npm run test:workflow-executor`, `npm run test:fake-provider-workflows`,
`npm run test:workflow-fixtures`, `npm run test:aipi-tools`,
`npm run test:permission-removal`, `npm run test:lifecycle-hooks`, `npm run test:subagents`,
`npm run test:subagents-real-sdk`, and `npm run test:adversarial-readiness`.

Still not beta-complete: credentialed model-backed pressure runs and richer
semantic quality for subtle graph conflicts beyond the current deterministic
code-line/vector index, canonical domain aliases, polarity conflicts, modality
conflicts, numeric conflicts, sequence conflicts, and historical run outcomes.
Container/external worker modes now fail closed
unless a reviewed JSON command adapter is configured.

## Installation

`aipi` keeps Pi as the runtime and starts it with the AIPI extensions preloaded.
For the full numbered walkthrough, including prerequisites and global install
options, see [`docs/installation.md`](docs/installation.md).

```bash
git clone <this-repo-url>
cd aipi
npm install
npm install -g @earendil-works/pi-coding-agent
npm link          # dev install: exposes the `aipi` CLI on PATH
aipi --version
aipi --help
aipi              # starts an interactive Pi session with AIPI preloaded
aipi "/aipi-init" # scaffold .aipi/ into the current repo
aipi "/login anthropic"
aipi status
aipi workflow list
aipi workflow status
aipi memory status
aipi memory query business rules
aipi effort status
aipi effort setup --planner openai-codex/gpt-5.5:high --adversarial anthropic/claude-opus-4-8:high --doer openai-codex/gpt-5.5:medium --mover anthropic/claude-haiku-4-5:low
aipi models status   # alias of aipi effort
aipi "/aipi-status"
aipi "/aipi-mcp"
```

`aipi` with no arguments is the primary interactive entry point: it starts `pi`
with the packaged AIPI extensions prepended. `aipi <args>` preserves user Pi
flags/messages after prepending those extensions. `aipi status [--target <dir>]
[--json] [--strict]` prints the same readiness report as `/aipi-status` without
starting a Pi session. `aipi workflow
[--target <dir>] [--json] ...` exposes workflow list/status/start/run/execute
from the console using the same run-state runtime as `/aipi-workflow`. `aipi memory
[--target <dir>] [--json] ...` exposes read-only memory status/refs/query using
the same Markdown memory query runtime as `aipi_memory_query`. `aipi effort setup`
(aliased as `aipi models setup`) configures 4 provider-agnostic buckets —
`--planner`, `--adversarial`, `--doer`, `--mover` — each taking a
`provider/model[:level]` spec (level = low|medium|high|xhigh). Each bucket fans its
model out to its capability classes and its thinking level out to a persisted
per-class `class_thinking` map that the router reads at resolve time. It runs an
interactive terminal fallback (prompting the 4 buckets) when no flags are provided,
and keeps `--class <class>=<provider/model[:level]>` as a power-user override. Any
provider is allowed per bucket; setting the adversarial bucket to the same family as
the doer/planner bucket emits a cross-model-independence warning. `aipi --version`
reports both the AIPI package and wrapped Pi versions; use `aipi --pi-help` for
the raw Pi flag reference. Point at a specific Pi with `AIPI_PI_CLI_JS` or
`AIPI_PI_BIN`. See
[`docs/aipi-cli-wrapper.md`](docs/aipi-cli-wrapper.md).

## Commands

| Command | Purpose |
|---|---|
| `/aipi-init [--dry-run] [--force] [--reset-memory] [--target <dir>]` | Scaffold the `.aipi/` overlay into a repo. Preserves existing files by default; `--force` still protects `.aipi/memory/project/**` unless `--reset-memory` is also present. |
| `/aipi-status` | Report project install, Anthropic auth/sidecar, capability states, readiness blockers/evidence gaps, and the subagent backend (no credentials printed). |
| `/aipi-workflow [list \| status \| start <name> \| run <name> \| execute]` | List, inspect, start, execute the active run, or run any installed workflow through the current executor. |
| `/aipi-memory [status \| refs \| query <terms>]` | Inspect Markdown memory and generated code graph state without writing durable memory. |
| `/aipi-mcp` | Report MCP server connection state, bridged tool count, and last errors for `.aipi/mcp.json`. |
| `/aipi-probe-a` | Diagnostic: whether host hooks can attribute worker `tool_call` events (see Probe A). |
| `/aipi-probe-a-prime` | Diagnostic: whether wrapped worker write tools enforce owned-file scope in-process (current backend criterion). |

## How it works

`aipi` separates six concerns:

- **Workflows** (`.aipi/workflows/*.yaml`) — the staged process. Six lanes:
  `planning`, `feature`, `bugfix`, `research`, `ops`, and a lightweight `quick`.
  Each step emits a structured `aipi.step-result.v1` verdict; gates branch on it
  (`on_verdict`, `runLimits`) — prose is never a gate.
- **Agents** (`.aipi/agents/catalog.yaml`) — the roles, each bound to a model
  *class* (not a vendor) and a `runtime`: `controller` (the orchestrator),
  `skill` (in-session, native Pi Skills), or `session` (spawned worker).
- **Disciplines** (`.aipi/disciplines/`) — small lifecycle behavior contracts
  (context-thrift, scope-discipline, prove-it, …) injected by stage, with a
  precedence order and pressure-eval gating.
- **Memory** (`.aipi/memory/project/*.md`) — the Markdown brain: the source of
  truth for business rules, decisions, knowledge, environment, deployment,
  glossary. Indexes are rebuildable; the Markdown is authoritative.
- **Contract** (`.aipi/runtime-contract.json`) — the canonical registry of
  stages, verdicts, policy decisions, evidence rungs, skip conditions, run
  limits, artifact policy, and the subagent backend decision. The validator
  enforces every workflow, agent, and discipline against it.
- **MCP** (`.aipi/mcp.json`) - optional stdio MCP servers. The wrapper only
  loads the bridge when this file exists; see [`docs/mcp.md`](docs/mcp.md).

### Owned-file enforcement and the subagent backend

Parallel workers must not write each other's files. v1 uses one shared tree with
**owned-file scopes**: the orchestrator allocates a disjoint file set per worker,
and forked workers receive read-only built-ins plus AIPI's guarded child `write`
extension (`extensions/aipi/runtime/aipi-guarded-write-child.js`). That extension
uses the worker's `AIPI_SUBAGENTS_OWNED_FILES` allocation and blocks writes outside
scope or under `.aipi/memory`, with no host hooks. `bash`/`user_bash` are denied
to session workers (shell is opaque to path checking); the guard fails closed on
unknown tools.

Backend decision: **`pi_subagents`** as the single AIPI worker runtime. The
runtime is a fork of `pi-subagents@0.28.0` under
`extensions/aipi/runtime/vendor/pi-subagents`, called through AIPI's own
`runtime/pi-subagents.js`; it is not an npm dependency, not a separately-loaded
Pi extension, and not selected by an environment flag. Workers run in the
project cwd, write runtime state under `.aipi/runtime/subagents/`, inherit the
selected host/configured provider model, and keep worker fallback scoped to that
selected model. Child sessions receive `read`, `grep`, `find`, `ls`, and the
guarded AIPI `write` extension, not Pi's unguarded `write` builtin.

### Provider auth

The package depends on pinned `@ersintarhan/pi-toolkit`, which includes a Claude
OAuth adapter for Pi's `anthropic` provider while keeping `/login anthropic`.
The default AIPI provider extension is an OAuth-only wrapper that imports
`src/claude-oauth-adapter.ts`; it does not autoload the toolkit's broad
`index.ts` provider/search surface. AIPI pins and validates that decision, and
the security tradeoff is tracked in
[`docs/anthropic-auth-integration.md`](docs/anthropic-auth-integration.md).
Credentials live in Pi's normal auth file (`~/.pi/agent/auth.json`), never in the
repo.

## Project layout

```text
bin/aipi.js                  # CLI wrapper (launches pi + extensions)
extensions/aipi/
  index.js                   # registers commands + tools
  runtime/                    # tools, hooks, context, coordinator, init, status, run-state, probes
templates/.aipi/             # the overlay copied into a project by /aipi-init
  runtime-contract.json      # canonical vocabulary + decisions (validated)
  mcp.json                   # optional stdio MCP server config
  agents/ disciplines/ workflows/ protocols/ memory/project/ evals/
  model-classes.yaml
tools/                       # validator + test suites
docs/                        # design, decision, and review docs
adversarial-claude.md        # the full adversarial review history
```

## Development

```bash
npm test     # validator + local test suites (also runs in CI on push/PR)
npm audit --omit=dev --legacy-peer-deps
```

`aipi status --strict` exits non-zero when the current project has readiness
warnings/blockers, which makes it suitable for release checks before opening an
interactive Pi session.

For credentialed release evidence, run the consolidated checker only after
provider cost is explicitly acceptable:

```bash
AIPI_MODEL_PRESSURE=1 AIPI_MODEL_PRESSURE_COMMAND=<runner> npm run readiness:credentialed -- --target <initialized-project> --strict
```

It runs model-pressure baseline + verify, optionally runs the live worker smoke
when `AIPI_LIVE_SMOKE=1`, writes durable `.aipi/` evidence, then evaluates the
same readiness report used by `aipi status`. It preflights local blockers first:
missing `.aipi`, Anthropic auth, or model capability floors stop the command
before any credentialed model or live-worker check is launched.

To run only the credentialed spawned-worker smoke outside an interactive Pi
session, provide the host model explicitly:

```bash
AIPI_LIVE_SMOKE=1 AIPI_LIVE_SMOKE_MODEL=anthropic/<model-id> npm run smoke:subagent-live
```

Inside an interactive `aipi` session, worker spawns use the current host
`ctx.model` automatically when a model class is unbound, and the worker
provenance records the real fallback model id.

`aipi update --dry-run` prints the Pi/AIPI update plan without running
`pi update`, `git pull`, or `npm install`. On development checkouts it skips git
pull when there is no commit, no upstream remote, or a dirty working tree.

The validator (`tools/validate-aipi-templates.mjs`) is the guardrail: it checks
the contract's internal consistency and that every workflow/agent/discipline uses
only canonical vocabulary, that session writers carry no denied tools, and more.

## Known limitations

- **`/aipi-init --force --reset-memory` resets your Markdown memory.**
  Plain `--force` updates framework files but protects `.aipi/memory/project/**`;
  use `--reset-memory` only when you intentionally want the template stubs back.
- Workflow execution is still an alpha runtime: installed workflows can execute
  through the deterministic controller adapter, and configured steps can use
  S0/S1 workers, but this is not yet a claim of unattended production autonomy.
- Subagent fan-out is bounded to configured steps and forked pi-subagents workers.
  Parent restart restores the latest subagent snapshot and marks queued/running
  workers as `interrupted`; workflow execution can redispatch matching
  interrupted workers from a clean boundary. There is no RPC/external/worktree
  worker backend in the current runtime.
- Memory/query tools are operational, and approved promotions can write
  Markdown memory. The code graph writes a rebuildable JSON manifest plus a
  `node:sqlite` sidecar with files, symbols, searchable lines, relationship
  edges, and deterministic local code-line vectors when `sqlite-vec` loads;
  it falls back to lexical search when unavailable and detects stale manifests
  from file hashes before reusing an index.
- Worker writes are guarded. Executor-owned controller artifact writes are
  limited to declared step outputs. The parent-session permission policy and
  profiles were removed by design; AIPI no longer blocks ordinary interactive
  source edits through profile/stage approval checks.
- Lifecycle hooks preserve run pointers, subagent restore markers, and evidence.
  Interrupted worker processes are not revived in place; matching workflow steps
  are redispatched as fresh workers. Provider hooks redact payloads and append
  normalized token/cost usage to `provider-usage.jsonl` when provider metadata
  is available, estimating missing cost only from optional
  `.aipi/provider-pricing.json` rates with fresh `source_url` and `checked_at`
  metadata, and reporting `.aipi/provider-budget.json` state to
  `provider-budget.jsonl` when that budget file is enabled. Token usage without
  provider cost or a fresh local pricing rate is marked `cost_unknown`.
- MCP support is tools-only over stdio this round. Remote OAuth servers should
  be run through `mcp-remote`; direct Streamable HTTP/SSE OAuth transport and
  MCP resources/prompts are deferred. See [`docs/mcp.md`](docs/mcp.md).
- Pi has no sandbox. Worker write guards are process-local correctness checks for
  assigned worker files, not security boundaries; the
  `external`/`container` adapter is only a boundary when its configured runner
  really uses a container/VM/remote sandbox. See
  [`templates/.aipi/protocols/security-boundary.md`](templates/.aipi/protocols/security-boundary.md).

## Documentation

See [`docs/README.md`](docs/README.md) for the full index, including
[`docs/mcp.md`](docs/mcp.md). The complete adversarial review is in
[`adversarial-claude.md`](adversarial-claude.md).

## Attribution

Adapts ideas from fable-skills and Ponytail (MIT) — see
[`NOTICE.md`](NOTICE.md).

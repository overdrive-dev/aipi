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
- A Pi extension with working commands: `/aipi-init`, `/aipi-status`, `/aipi-goal`,
  `/aipi-plan`, `/aipi-workflow`, `/aipi-memory`, `/aipi-effort` (alias `/aipi-models`),
  `/aipi-mcp`, `/aipi-setup`, `/aipi-probe-a`, `/aipi-probe-a-prime`.
- A top-level measurable **goal** (`/aipi-goal`, or bound from natural language via
  `aipi_set_goal`): objective + checkable criteria + a binary `done_when`, gated by a
  structural then measurability acceptance check. A model measurability judge refines a
  deterministic floor and **degrades to that floor** (never fail-closed) when the judge
  is slow or unreachable, so an infra timeout can't masquerade as "not measurable".
- A **plan** layer (`/aipi-plan`; "monta um plano pra X" natural-language routing)
  rendered live in a read-only TUI plan widget that tracks task progress and hides once
  the plan is settled/idle.
- **Reviewed background research** (`aipi_background_research`): read-only workers on the
  `research-heavy` model class run in the background, and each is cross-checked by an
  **adversarial reviewer** (`adversarial-heavy`, chosen cross-family from the researcher)
  before findings reach the orchestrator — findings arrive as reviewed claims, not
  trusted truth.
- **Per-role model topology**: capability classes (research, adversarial, builder,
  verifier, planner, …) bound to concrete provider/models + per-class thinking in
  `.aipi/model-capabilities.json`. `aipi effort` (alias `aipi models`) offers each chosen
  model only the thinking levels it actually supports; adversarial review prefers a model
  family different from the implementer.
- **Vendored native providers**, preloaded: Anthropic Claude-OAuth and xAI Grok-OAuth
  (no npm provider dependency); `/login anthropic`, `/login xai-auth`, plus `openai-codex`
  for GPT models.
- **Terminal UX**: an inline live subagent list (model + set thinking per run), the plan
  widget, a foreground model indicator (footer chip + streaming "Working" row) that names
  the model driving write/edit/read, and A/B/C questions via the native selector
  (`aipi_ask`) with a free-text "discuss" option.
- Pinned-bundle hygiene: the wrapper **suppresses Pi's "run pi update" banner** by default
  (it targets the global Pi, not the pinned copy; overridable); new Pi versions come
  through `aipi update`.
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

Current regression coverage re-checks the worker-session toolset against the pinned
Pi (`0.79.8`) with `npm run test:subagents-real-sdk`.

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
The Pi runtime is a **pinned dependency**: installing aipi pulls the exact tested
`@earendil-works/pi-coding-agent` version into the package, and the wrapper resolves
that copy first — **there is no separate "install Pi" step and no global Pi is
needed.** Releases are GitHub-only (no npm publish). For the full walkthrough see
[`docs/installation.md`](docs/installation.md).

```bash
# Install aipi + its pinned Pi in one command (end users)
npm install -g github:overdrive-dev/aipi
#   or from a clone (contributors): git clone … && cd aipi && npm install && npm link

aipi --version        # prints AIPI + wrapped Pi versions
aipi setup            # environment doctor (Node/Git/Pi always; Docker/Playwright/Ollama optional; --fix to auto-fix)
aipi                  # interactive Pi session with AIPI preloaded
```

Inside the session, scaffold a project and log in to the providers you use (the
Anthropic Claude-OAuth and xAI Grok-OAuth providers ship vendored and preloaded):

```text
/aipi-init            # scaffold .aipi/ into the current repo
/login anthropic      # Claude subscription via OAuth
/login xai-auth       # Grok via OAuth   (+ log in to openai-codex for GPT models)
/aipi-status
```

Everything is also runnable from the console without opening a session:

```bash
aipi status
aipi workflow list
aipi memory query business rules
aipi effort status
# Configure the per-role model topology (any provider per bucket; adversarial should differ in family):
aipi effort setup --planner anthropic/claude-opus-4-8:high --adversarial openai-codex/gpt-5.6-sol:high \
                  --doer xai-auth/grok-4.5:high --mover anthropic/claude-opus-4-8:low
aipi models status    # alias of aipi effort
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
`provider/model[:level]` spec. Each bucket fans its model out to its capability
classes and its thinking level out to a persisted per-class `class_thinking` map that
the router reads at resolve time. The interactive wizard (run with no flags) offers,
for each chosen model, **only the thinking levels that model actually supports**
(strongest first) — `off`/`minimal`/`low`/`medium`/`high`/`xhigh`, where `xhigh` is
offered only for models that declare it. It keeps
`--class <class>=<provider/model[:level]>` as a power-user override. Any
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
| `/aipi-goal` | Set/inspect the top-level measurable goal (objective + checkable criteria + a binary `done_when`). Passes an acceptance gate; a model measurability judge refines the deterministic floor and degrades to it if the judge is unavailable. Also bound from natural language via `aipi_set_goal`. |
| `/aipi-plan` | Draw/inspect the task plan that a request is worked from; shown live in the TUI plan widget. Natural-language "monta um plano pra X" routes here automatically. |
| `/aipi-setup` | In-session environment doctor: Node, Git, Pi, Docker, Playwright, and the Ollama embedding model, per `.aipi/environment.json`. Fixes run from the console: `aipi setup --fix`. |
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

### Per-role models and reviewed background research

Agents bind to capability *classes*, and each class resolves to a concrete
provider/model (+ thinking level) from `.aipi/model-capabilities.json` — so who plans,
who builds, who reviews, and at what intelligence are **configuration, not code**.
`aipi effort` sets a 4-bucket topology (planner / adversarial / doer / mover) and, in the
interactive wizard, offers each chosen model only the thinking levels it actually
supports. Adversarial classes (`adversarial-heavy`, `verifier-fast`) prefer a model
family different from the implementer to avoid correlated blind spots.

`aipi_background_research` fans read-only investigation out to `research-heavy` workers
that run in the background and wake the orchestrator with their findings — the model
running as orchestrator is not the one doing the research. Before a finding is trusted, an
`adversarial-heavy` reviewer (cross-family when a distinct family is configured) verifies
its claims against the code, so findings arrive as **reviewed claims**, never ground
truth. The orchestrator's own ship-gate still sits between any finding and a merge.

### The interactive surface

Terminal-only widgets keep the run legible without leaving the editor: a live plan widget
above the editor (visible only while a plan is actionable), an inline list of active
subagent runs (each labelled with its model and set thinking), and a foreground model
indicator on the footer + the streaming "Working" row so a write/edit/read names the model
driving it. Recommendation/choice prompts use Pi's native selector (`aipi_ask`) with a
free-text "discuss" escape hatch instead of prose A/B/C. These are no-ops in headless /
RPC / print modes.

### Provider auth

AIPI ships two provider adapters **vendored** (copied into the tree, not npm
dependencies), preloaded via `package.json` `pi.extensions`:

- **Anthropic (Claude OAuth)** — `extensions/aipi/provider/anthropic-oauth-only.ts`
  imports the vendored `runtime/vendor/pi-toolkit/claude-oauth-adapter.ts`, keeping
  `/login anthropic` on Pi's `anthropic` provider. It is an OAuth-only wrapper: it
  does **not** autoload the upstream toolkit's broad provider/search surface. The
  security tradeoff is tracked in
  [`docs/anthropic-auth-integration.md`](docs/anthropic-auth-integration.md).
- **xAI (Grok OAuth)** — `extensions/aipi/provider/xai-oauth.ts` registers the
  `xai-auth` provider from `runtime/vendor/pi-xai-oauth/` (SuperGrok / X Premium+),
  logged in with `/login xai-auth`. Only the provider is registered; the upstream
  package's raw shell/file tool shims are deliberately not.

Both were internalized so the pinned bundle carries them (no `@ersintarhan/pi-toolkit`
or `pi-xai-oauth` npm dependency); re-vendoring rules are governed by the runtime
contract. Credentials live in Pi's normal auth file (`~/.pi/agent/auth.json`), never
in the repo. For GPT models, log in to `openai-codex`.

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
  edges, and semantic vectors embedded through a local Ollama server
  (`bge-m3`, 1024 dims, with an `embedding_cache` resume table; onboarding
  offers to pull the model). When Ollama or `sqlite-vec` is unavailable it
  degrades loudly to lexical search, and it detects stale manifests from file
  hashes before reusing an index.
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

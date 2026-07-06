# Subagent View + Flexible Workers — Implementation Plan

Status: draft for later work. Author: planning session 2026-07-05.

## Why this exists

Evaluating Orca (a desktop IDE for running agents side-by-side) surfaced two things worth
having, but Orca is the wrong vehicle: nesting aipi's orchestrator inside a single Orca pane
bypasses Orca's per-agent isolation and diff, and adopting Orca's `orchestration run` loop
would swap the adversarial brain we control for an opaque one. Better outcome: aipi absorbs the
two capabilities natively and keeps the brain.

The two capabilities:

1. **A live subagent drilldown** — see which subagents are running, their state, hierarchy, and
   per-step activity; drill into one.
2. **Isolated, independently-verified, heterogeneous workers** — the brain dispatches subagent work
   to *anything* (Pi-native today, `claude`/`codex`/future CLIs tomorrow), each running in an
   isolated environment on its own branch, verified in isolation, and integrated only through an
   evidence-gated atomic merge. Rationale: don't bet that our harness beats whatever Claude/Codex
   ship next — design so we can farm work out to any agent and can't-anticipate uses become
   available, without sacrificing verification soundness.

These compound: per-candidate branch + diff makes the drilldown Orca-grade (per-subagent diff is
Orca's headline feature), and the **one** isolation layer built for sound verification (Phase 2)
*is* the sandbox that safely runs untrusted external agents (Phase 3).

**Design north star (decided): optimize for code quality + verification, not build cost.** The
guiding invariant is **verify == ship**: the artifact you verify must be byte-for-byte the artifact
you integrate. Every design choice below follows from that.

---

## Relationship to Orca

This design deliberately builds on Orca's proven substrate and internalizes the one part Orca leaves
to the human. Orca is a **human cockpit**; aipi is an **autonomous brain** — that single difference
drives every divergence below.

**Aligned (adopted from Orca's model):**
- one agent → one git worktree → its own branch → its own diff
- parallel candidates; pick/merge the winner
- per-candidate diff as the review surface
- coordinator → worker dispatch protocol (`dispatch`/`worker_done`/`escalation`/`decision_gate`/`heartbeat`)
- heterogeneous agents (Claude / Codex / custom CLIs) as workers

**Beyond Orca (internalized because there is no human in aipi's loop):**
- *Verification:* Orca = the human eyeballs the diff and runs tests; ours = automated, **independent,
  adversarial** re-verification of the candidate branch in a clean env.
- *Merge gate:* Orca = manual commit & push; ours = **evidence-gated, programmatic atomic merge** +
  post-merge re-verification.
- *Isolation depth:* Orca = worktree-only (shared machine/deps/ports); ours = a **graded dial up to
  container**, so an automated gate can trust "green."
- *Orchestration:* Orca = human in the GUI; ours = the aipi brain end to end.

**Synthesis:** Orca's worktree-per-agent isolation + diff + pick-a-winner model, with the human's
review/verify/merge role replaced by an automated adversarial gate, and isolation escalated to
container-grade so that gate can be trusted.

**Why not just run inside Orca:** nesting aipi's orchestrator inside one Orca pane collapses Orca's
per-agent isolation (Orca sees one terminal; aipi's subagents share that single worktree). Phase 2
instead **reproduces** Orca's per-agent isolation natively, under aipi's control — same benefit, no
nesting, and the brain stays ours.

**Not replicated (intentionally):** Orca's full human-review IDE surface (annotate-and-send-back,
commit & push UI, session restore, per-worktree browser). Because the gate is automated, aipi needs
*less* human review surface; the Phase-1 drilldown is for inspection-on-demand, not a mandatory
review step.

---

## Current state (grounded — verified in code)

### Subagent run-state is already persisted on disk (this is what makes the view cheap)

Root (`vendor\pi-subagents\src\shared\types.ts`):
- `TEMP_ROOT_DIR = $AIPI_SUBAGENTS_RUNTIME_DIR || os.tmpdir()/pi-subagents-<scope>`
- `ASYNC_DIR = TEMP_ROOT_DIR/async-subagent-runs`
- `RESULTS_DIR = TEMP_ROOT_DIR/async-subagent-results`
- `POLL_INTERVAL_MS = 250`

Per background run, `ASYNC_DIR/{runId}/` holds:
- `status.json` — atomic-written on every state change; canonical live state.
- `events.jsonl` — append-only event stream (tool starts, parallel lifecycle, activity escalation), read by byte cursor.
- `output-{index}.log`, `subagent-log-{runId}.md`.
- Terminal result → `RESULTS_DIR/{runId}.json`.

`status.json` fields (interface `AsyncStatus`): `runId`, `mode` (single|parallel|chain),
`state` (queued|running|complete|failed|paused), `activityState`
(active_long_running|needs_attention), `currentStep`, `parallelGroups[]`, `workflowGraph`
(a pre-computed DAG snapshot), and `steps[]` each with `agent`, `status`, `currentTool`,
`turnCount`, `toolCount`, `tokens`, `model`, `acceptance`, `recentTools`, `recentOutput`, and
recursive `children` (`NestedRunSummary`). The full parent→child tree is already assembled by
`projectNestedRegistryForRoot()`.

### Existing surfaces (all read from the above)

- `subagent({ action: "status" })` in `vendor\...\runs\background\run-status.ts` — lists
  running runs (no id) or drills into one (with id). **Text output only.**
- `vendor\...\runs\background\async-status.ts:221` `listAsyncRuns(asyncDirRoot, options)` →
  structured `AsyncRunSummary[]` (steps, parallelGroups, nested children, tokens, timing, file
  paths). Also `formatAsyncRunList` / `formatAsyncRunProgressLabel` / `formatAsyncRunOutputPath`.
- TUI sidebar `renderWidget()` (from `async-job-tracker.ts`) — lite live view.
- Completion push: `notify.ts` emits `subagent-notify`.
- Slash: `/run … --bg`, `/chain`, `/parallel`, `/run-chain`, `/subagents-doctor` (`--bg` makes it async).

### Isolation model today

- `subagents.js` (`SubagentCoordinator`) is the only place workers are created.
  - Rejects per-worker cwd (line 134); `assertSupportedIsolation` (line 1015) accepts **only**
    `pi_subagents` (`PI_SUBAGENTS_ISOLATION`), else throws (lines 1020–1023).
  - `#spawnWorkerSession` (line 618) throws unless `pi_subagents`; delegates to
    `#spawnPiSubagentsWorker` (line 653).
- Write isolation between concurrent workers is a **logical** `owned_files` fence
  (`owned-files.js` `wrapWriteToolWithOwnership`), not a filesystem fence — all workers share the
  project root.

### Spawn chain (for Phase 3)

`subagents.js` → `pi-subagents.js` (`runAipiForkedSubagent`, `createAipiWorkerAgentConfig`,
`normalizePiSubagentsRunner` @235) → jiti-loads `vendor\...\runs\foreground\execution.ts`
(`runSync`) → `child_process.spawn()` of `getPiSpawnCommand()` (default `pi --mode json -p <task>`;
overridable via `$AIPI_PI_BIN` / `$AIPI_PI_CLI_JS`). Worker stdout must parse as
`aipi.step-result.v1` (`#parseResult`), then the acceptance/evidence gate runs.

### Worktree primitive already exists (the branch-based foundation to build on)

`vendor\...\runs\shared\worktree.ts` is a complete, self-contained module:
- `createWorktrees(cwd, runId, count, opts)` → `WorktreeSetup`. Creates
  `os.tmpdir()/pi-worktree-{runId}-{index}` on branch `pi-parallel-{runId}-{index}` from HEAD;
  symlinks `node_modules`; optional setup hook. (Requires a clean tree today — see note below.)
- `diffWorktrees(setup, agents, diffsDir)` → per-task patch files + numstat (files/insertions/deletions).
- `cleanupWorktrees(setup)`, `formatWorktreeDiffSummary(diffs)`.

Already wired into the vendor **background** runner for `/parallel` groups, **not** into the AIPI
`SubagentCoordinator`. This is the substrate Phase 2 extends.

### ⚠️ Doc/code discrepancy (resolved by this plan)

`docs\pi-subagent-build-plan.md` lines 301–303 mark S7/S8/S9 **"Done"**, including
`per_worker_worktree` as a "managed copy under `.aipi/runtime/worktrees`" with **declared-output
sync**, plus `external`/`container` adapters. None is true of the deployed coordinator (it rejects
all of them). **Decision:** do **not** build declared-output sync — it breaks verify==ship (see
Phase 2). Build the **branch-based** design instead and correct the doc's S7–S9 marks.

---

## Phase 1 — Subagent drilldown view  (do first)

**Status: SHIPPED 2026-07-05.** Delivered in the vendored `pi-subagents` runtime:
- **Structured `--json` surface** — `subagent({ action: "status", format: "json" })` returns
  `{ runs: AsyncRunSummary[] }` (live + durable history, de-duped) or `{ run }` for a single id.
  (`run-status.ts` `jsonSubagentStatus`; `async-status.ts` `summarizeAsyncRunDir`.)
- **Durable history snapshotting** — terminal runs are snapshotted (summary + result payload) to an
  agent-scoped `async-subagent-history/` dir the moment they finish, surviving the ~10s in-memory
  retention and tmp cleanup. (`history-store.ts`; wired at the tracker's `scheduleCleanup` choke
  point in `async-job-tracker.ts`.)
- **Interactive drilldown pane** — new `/subagents` command opens a focusable, keyboard-navigable
  overlay via `ctx.ui.custom()`: list view (↑↓ select; active runs first, then durable history) →
  detail view (Enter drills in; ↑↓ / PgUp / PgDn scroll the step tree + nested children + output
  paths; Esc back), live-refreshed every 500ms. `/subagents <id>` prints a single run;
  `subagent status history=true` gives the text listing. (`tui/subagent-view.ts`
  `SubagentViewComponent`; `history-store.ts` `loadSubagentRuns`.)
- *Correction to an earlier note:* a focusable pane does **not** require harness-core changes — the
  extension API already exposes `ctx.ui.custom()` (focusable component; used here and by the clarify
  UI), `ctx.ui.setWidget()`, `pi.registerShortcut()`, and `ctx.ui.onTerminalInput()`. The harness
  core (`@earendil-works/pi-coding-agent`) is an upstream npm dep anyway (bundle-not-fork), and no
  core change was needed. (A global open-shortcut via `registerShortcut` is a trivial follow-up —
  left out to avoid guessing a conflicting keybinding.)
- *Verified:* durable regression test `tools/test-subagent-view.mjs` — wired into `npm test` as
  `test:subagent-view` — covers list/summarize, history snapshot/skip-live/result-capture, json
  list+single+not-found+history-merge, and loadSubagentRuns merge (green); all changed files pass
  `node --check`; repo `test:subagents` + `test:run-state` green. The pane component is TUI-only
  (pi-tui isn't installed in this dev env), so it's syntax-checked and mirrors the proven
  `ChainClarifyComponent`; it exercises live in the real Pi harness.

**Goal:** an Orca-like live view: list running subagents with state/activity, drill into a run to
see its step tree (parallel groups + nested children), current tool, recent output, tokens — and,
once Phase 2 lands, each candidate's diff + verification evidence.

**Approach:** render the state that already exists; poll `listAsyncRuns` on the 250ms cadence.

**Steps**
1. **Add a structured surface.** Give `subagent status` a `--json` mode (or a new
   `subagent({action:"status", format:"json"})`) that serializes the `AsyncRunSummary[]` that
   `listAsyncRuns(ASYNC_DIR, { states:["queued","running"], reconcile:true })` already returns.
   Low risk — the data object exists; only the text formatter is in the way.
2. **Build the view — DECIDED: TUI panel.** A focusable pane that polls `listAsyncRuns` every
   250ms, renders the run list, and on select renders `inspectSubagentStatus({id})`'s tree (steps
   grouped by `parallelGroups`, `steps[].children` recursed). Reuse the existing walk; matches the
   existing `renderWidget`. (A local web dashboard with a DAG view is a possible later follow-up
   once Phase-2 diffs exist to render — same JSON surface feeds both.)
3. **Close the visibility gaps:**
   - *Foreground runs are in-memory only* (no `status.json`). Either (a) standardize anything you
     want visible on `--bg`/async, or (b) emit a `status.json` for foreground runs too. Start with (a).
   - *Completed runs self-delete* (~10s retention; result files deleted after processing).
     **DECIDED: snapshot to history.** On completion, copy the terminal `status.json` + result into
     a `history/` dir (under `TEMP_ROOT_DIR` or a durable location); the view reads live +
     `history/`, and live-dir retention/cleanup stays as-is.

**Files:** `run-status.ts` (json surface + reuse `inspectSubagentStatus`), `async-status.ts`
(`listAsyncRuns` — already returns the shape), new `view/` module (TUI), `async-job-tracker.ts`
(retention/history knob).

**Acceptance:** while a `/parallel` or `/chain --bg` run executes, the view shows each subagent's
live state, current tool, the parallel-group grouping, nested children, and tokens; selecting a run
drills into its full tree; finished runs remain visible via `history/`.

**Effort:** small (a few days). No architectural change; zero risk to the orchestration path.

---

## Phase 2 — Isolated, independently-verified subagents (branch-based)  (the quality/verification core)

**Status — increment 1 SHIPPED 2026-07-05 (full vertical slice: worktree + worktree-aware gate + merge-back).**
- **`worktree-isolation.js`** (new) — git mechanics with an injectable runner: `provisionWorkerWorktree`
  (base = HEAD, require-clean scoped to *tracked* changes), `captureWorktreeDiff` (respects
  `.gitignore`, so `.aipi/runtime` never enters the diff), `applyWorktreeDiffToRoot` (merge-back via
  `git apply`), `removeWorkerWorktree`.
- **Coordinator wiring (`subagents.js`)** — opt-in `isolation: "per_worker_worktree"`; `#runJob`
  provisions the worktree, runs the forked worker with `root = worktree.agentCwd` (`.aipi/runtime`
  artifacts stay gitignored), captures the diff, re-points the evidence gate to the worktree using
  the **git diff as the change signal** (avoids the `git worktree add` mtime false-positive), merges
  the branch back into the project for `write_scope: "project"` on a passing verdict (downgrades to
  BLOCKED on a merge conflict), and cleans up in `finally`.
- *Verified with real git:* `test:worktree-isolation` (provision → isolated diff excluding gitignored
  → root untouched → merge-back → cleanup → dirty-tree rejection) and `test:worktree-coordinator`
  (end-to-end through the **real coordinator** with a fake worker: cwd threading → diff → worktree-aware
  PASS gate → `aipi_worktree_merged` → root updated → worktree removed). `node --check` on all changed
  files; repo `test:subagents` remains green (non-worktree path unchanged; one message-pin assertion
  updated).
- **Default ON — no config needed.** Worker jobs use worktree isolation by default: the shipped
  template `isolationModel.workerIsolation` is `"per_worker_worktree"` and the coordinator's built-in
  default (no contract) is worktree too. **No env var** — the runtime contract forbids env-selected
  isolation; governance (`validate-aipi-templates.mjs` + the contract `isolationModel`) was amended to
  sanction `per_worker_worktree` as a **cwd-isolation MODE of the single `pi_subagents` backend**
  (`spawnBackends` stays `[pi_subagents]`; not a new spawn backend). **Graceful fallback** makes it
  safe as a blanket default: a *default* job that can't provision a worktree (dirty tree, not a git
  repo, provision error) silently runs at the project root — the old pi_subagents behavior — instead of
  failing (traced `worktree_isolation_fallback`). Turn it OFF per project by setting
  `isolationModel.workerIsolation` to `"pi_subagents"`. An *explicit* `descriptor.isolation:
  "per_worker_worktree"` still fails loud on an unclean tree (require-clean, manual). Contract:
  base = HEAD. ⚠️ Because merge-back dirties the tree, in a sequential write-heavy workflow only the
  first write step gets an isolated worktree; later steps fall back to the shared root until you
  commit — so isolation applies naturally to the first / parallel / independent work.
  **Audit with one command:** `npm run audit:worktree` (or
  `node tools/aipi-worktree-audit.mjs --root <proj> [--events <session.jsonl>] [--json]`) reports leaked
  worktrees / `aipi-worker-*` branches, temp-dir leftovers, merged working-tree changes, tree
  cleanliness, and — when a session/events source is found — the `worktree_*` lifecycle traces
  (`worktree_provisioned` / `worktree_diff` / `worktree_merged` / `worktree_merge_skipped` /
  `worktree_merge_conflict` / `worktree_cleanup_failed`). Exits non-zero when issues are found.
  (Traces live in the Pi session JSONL as `aipi.subagent-event.v1` entries; `aipi_worktree_merged` is
  stamped on merged step results.)
- *Not yet (remaining Phase 2):* the **independent-verifier** stage, **post-merge re-verification**,
  **container-grade** isolation, **per-step opt-in** (per-project config exists now via
  `isolationModel.workerIsolation`; per-step / parallel-group selection + surfacing the toggle in
  `/aipi-setup` are next), and a **live-harness smoke test** of a real forked worker in a worktree
  (this dev env has no live Pi runtime, so the wiring is verified via the fake-worker coordinator test
  + real git, not a real LLM worker).

**Goal:** each subagent runs in an isolated environment on its own branch, is verified in isolation
by an **independent** verifier, and is integrated only through an **evidence-gated atomic git
merge** with **post-merge re-verification**. This is the ideal for code quality + verification, and
the isolation layer it builds *is* the Phase-3 sandbox.

### Why branch-based, not declared-output sync (decided)

Declared-output sync (scratch copy → sync declared files back into the working tree) is rejected on
principle: it **breaks verify == ship**. You verify the scratch copy, then transform it on the way
into your tree, so the acceptance evidence describes a different artifact than what lands; it also
hand-rolls integration (partial-application hazard when a worker touches undeclared files) instead
of using git's atomic, conflict-aware merge. Its only advantage was ergonomic (auto-apply, no merge
step) — a cost/convenience argument we are explicitly not optimizing for.

Branch-based keeps every property that matters: immutable base (HEAD), verify==ship, atomic
conflict-aware merge, clean per-candidate provenance, trivial rollback (delete the branch), and a
concrete artifact to hand an independent verifier. Autonomy is preserved because the orchestrator
merges the winning branch programmatically after the gate passes.

### The ideal pipeline (per candidate)

```
HEAD (immutable base)
  → candidate branch, run in a hermetic per-candidate env
     (worktree → container as the isolation dial rises)
  → worker self-checks (fast local feedback)
  → INDEPENDENT verifier re-runs the full suite on the branch in a clean env → evidence
  → merge gated on machine-checkable evidence (atomic git merge, conflict-aware)
  → POST-MERGE re-verification of the combined result
  → accept
```

### Components

1. **Isolation substrate — a graded dial (per-task).**
   - *Level 0 (default):* git worktree per candidate (source isolation) — extend `worktree.ts`.
   - *Level 1 (ideal for I/O-heavy verify):* hermetic env — isolated `node_modules` (not the shared
     symlink), private tmp, isolated network/ports, ephemeral DB — up to a **container per candidate**
     with pinned toolchain.
   - The brain escalates the dial for work whose verification does real I/O or where parallel
     candidates could collide (ports, DB, global state). *Why it's a correctness issue, not just
     cost:* a bare worktree shares node_modules/tmp/network/DB with the host and siblings, which
     makes parallel verification results unreliable. Container-grade isolation makes "green" mean
     green, reproducibly.

2. **Branch output + captured diff.** Each candidate = branch `pi-parallel-{runId}-{index}` from
   HEAD; capture numstat + patch (reuse `worktree.ts` diff capture) → attach to the run's
   `status.json` step → feeds the Phase-1 view.

3. **Independent re-verification (don't trust the author).** After the worker self-reports, a
   *separate* verifier agent (aipi already ships `reviewer` / `oracle` agents) checks out the
   candidate **branch** into a **fresh** hermetic env and re-runs tests/typecheck/lint/build +
   reviews the diff, producing the evidence the acceptance gate consumes. The branch makes this
   possible — there is a concrete, immutable artifact to hand an independent party. This is the
   adversarial thesis applied to verification.

4. **Evidence-gated atomic merge.** Integration is a real `git merge` / `cherry-pick` of the winning
   branch, gated on machine-checkable evidence (`aipi.step-result.v1` + verifier evidence).
   Conflict-aware; the orchestrator performs it programmatically, so autonomy is preserved.

5. **Post-merge re-verification.** After merging (especially multiple winners, or into a main that
   moved), re-run the full suite on the merged result before accepting — catches "green alone, red
   together" semantic conflicts git will not flag.

### Implementation steps

1. Correct `docs\pi-subagent-build-plan.md`'s inaccurate S7–S9 "Done" marks; record branch-based +
   independent verification as the chosen design (supersedes `per_worker_worktree` + declared-output
   sync).
2. Extend `worktree.ts` (or a sibling `isolation/` module) from tmpdir toward the graded dial: a
   pluggable env provider (`worktree` | `hermetic` | `container`) that, at higher levels, provisions
   isolated deps instead of the shared `node_modules` symlink, private tmp, and network/DB isolation.
3. Add an `isolated` (worktree/container) branch to `normalizeIsolation` / `assertSupportedIsolation`
   (`subagents.js` ~1009–1024); stop rejecting per-worker cwd for it (line 134).
4. Implement `#spawnIsolatedWorker(job, signal)` next to `#spawnPiSubagentsWorker` (~653): provision
   the isolated env + branch, run the forked worker with `cwd = <isolated tree>`, capture the diff,
   attach to `status.json`.
5. Wire the **independent verifier** stage into the collect path: dispatch a verifier agent against
   the candidate branch in a fresh env; fold its evidence into the acceptance ledger.
6. Implement **evidence-gated atomic merge** + **post-merge re-verification** in the coordinator's
   collect/finalize path.
7. Surface per-candidate diffs + verification evidence in the Phase-1 TUI view.

**Clean-tree note:** branch-based writes nothing into your working tree during a run, so the old
require-clean constraint is largely moot — the base is HEAD (a committed ref) and the only write to
your tree is the final gated merge, a normal conflict-aware git operation. (Keep a clean-tree check
only on that final merge step.)

**Files:** `subagents.js` (isolation branch, `#spawnIsolatedWorker`, verifier stage, gated merge,
post-merge reverify, cwd threading), `pi-subagents.js` (non-root cwd in the runner path),
`worktree.ts` / new `isolation/` module (graded env dial), reviewer/oracle agent wiring,
`docs\pi-subagent-build-plan.md` (correct S7–S9).

**Risks / notes:** container-grade isolation adds latency + infra — accepted, since it buys
verification correctness; the independent-verifier and post-merge-reverify stages add orchestration
steps — that IS the adversarial-verification value, not overhead; reproducible "green" needs a pinned
toolchain/lockfile; Windows container story is weaker than Linux (worktree level works everywhere;
container level is likely Linux/WSL-first).

**Effort:** large — deliberately, because this is the quality/verification core. Not the deciding
factor per the design north star.

---

## Phase 3 — Heterogeneous external workers (claude / codex)  (do after Phase 2)

**Goal:** dispatch a subagent to an external agent CLI (`claude --print`, `codex`, or a future one)
as a worker — running inside the **same** Phase-2 isolated env + branch + independent-verify +
gated-merge pipeline as native workers.

**The isolation layer unifies with Phase 2 — build it once.** The graded dial (up to container)
built in Phase 2 for verification is exactly what safely sandboxes an untrusted external agent CLI.
So an external worker is just "run this command as the worker inside the isolated env," after which
the identical branch-capture → independent-verify → gated-merge → post-merge-reverify applies.

**This dissolves most of Phase 3's original difficulty.** Because external agents are
**independently re-verified on their branch** (Phase 2, component 3), you neither trust their
self-reported results nor need to inject aipi's `owned_files` write-guard into their tool loop — the
worktree/container boundary contains them, and the diff-audit + independent verification catch
anything out of scope. What remains is genuinely external-specific:

**Steps**
1. Add an `external` sub-mode of the isolated backend (`assertSupportedIsolation`) + an
   `AIPI_EXTERNAL_WORKER_COMMAND_JSON`-style command-template config.
2. Implement the adapter via the existing runner seam `normalizePiSubagentsRunner`
   (`pi-subagents.js:235`, already accepts a function or `{spawn}` object): run the external CLI with
   `cwd = <isolated tree>`, task prompt, captured stdout — inside the Phase-2 env.
3. **Result translation (the remaining crux).** You still need the worker's *result* as
   `aipi.step-result.v1`. Options: *prompt them into the schema* (embed the schema in the worker
   prompt; brittle to model drift) vs *wrap + map* (parse native output → schema; more robust, more
   code). Note the stakes are lower now: correctness is enforced by independent verification of the
   branch, so a mistranslated *self-report* can't smuggle in bad code — worst case it's rejected.
4. **Auth / non-interactive.** External CLIs bring their own auth, rate-limits, and permission
   prompts; they must run with print/non-interactive flags inside the sandbox.
5. **Model routing.** `assertAipiHostScopedModel` is provider-neutral (empty disallow list), so
   `anthropic/claude-*` etc. pass — the model must be expressed `provider/model-id` and the external
   binary must honor it.
6. Expose an isolation/agent selector so the brain chooses backend per task (native | isolated-native
   | isolated-external).

**Files:** `subagents.js` (external sub-mode), `pi-subagents.js` (runner adapter), new
`external-worker.js` (command adapter + result shim). (Isolation + diff-audit come from Phase 2.)

**Open decision (deferred until this phase):** result translation contract —
prompt-into-schema vs wrap-and-map.

**Effort:** moderate now (was large) — the sandbox and verification are inherited from Phase 2; only
the adapter + translation + auth remain.

---

## Sequencing & decisions

Order: **Phase 1 → Phase 2 → Phase 3**. Phase 2 builds the isolation + verification core; Phase 3
reuses it. (Ordering follows dependency, not cost.)

Decisions (resolved 2026-07-05):
1. **View form:** ✅ TUI panel. (Web dashboard = optional later follow-up; same JSON surface.)
2. **History:** ✅ Snapshot terminal runs to a `history/` dir.
3. **Worktree design:** ✅ **Branch-based** (build on `worktree.ts`), NOT declared-output sync.
   Reason: verify == ship; atomic conflict-aware merge; independent re-verifiability.
4. **Isolation:** ✅ Graded dial, worktree → **container** per candidate, escalated per task by the
   brain; the same layer sandboxes Phase-3 external agents.
5. **Verification:** ✅ Independent verifier re-runs the full suite on the candidate **branch** in a
   clean env; merge is **evidence-gated + atomic**; **post-merge re-verification** guards
   "green-alone-red-together."
6. **Subagent base / clean-tree:** ✅ Base = HEAD; branch-based means nothing lands in the working
   tree until the final gated merge, so require-clean applies only to that merge step.
7. **External result contract (Phase 3, still open):** prompt-into-schema vs wrap-and-map — deferred
   until Phase 3 is closer.

## What NOT to do
- Don't adopt Orca's orchestration engine or nest the coordinator inside Orca — keep the brain.
- Don't build declared-output sync — it violates verify == ship.
- Don't trust a worker's self-reported result as the merge gate — always independently re-verify the
  branch in a clean env.
- Don't plan Phase 2/3 from the build-plan doc's "Done" S7–S9 claims; they don't match the coordinator.

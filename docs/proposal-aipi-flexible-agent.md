# Proposal — AIPI as a Guided Flexible Agent (not a pipeline orchestrator)

Status: DRAFT for review · 2026-06-22

## 0. Revised after adversarial critique (2026-06-22)

An independent, code-grounded critique (recommendation: **ship_with_changes**) confirmed the DIRECTION but
corrected an over-rotation toward removal. Corrections, all verified in code:

1. **"Workers have no bash" is CONFIG, not architecture.** AIPI already ships `aipi_guarded_bash`
   (`aipi-tools.js`); workers are denied bash only by their own allowlist (`pi-subagents.js`) + the owned-files
   deny. The verify gate this whole case rests on can be closed WITHIN the forked model by giving the verify
   lead worker guarded bash — so §1's "architectural" framing is **overstated**; the forked path was
   *misconfigured + hard-gated*, not inherently incapable.
2. **Do NOT delete the hard evidence gate — PORT it.** `step-result.js` + `subagents.js` reject a PASS with no
   real `ran`/`verified` rung (command + exit_code), downgrade forged rungs, and flip PASS→BLOCKED on
   exit_code≠0. That is the only runtime anti-self-deception backstop; a flexible agent grading its own
   Definition of Done is exactly the failure mode it was built against. Keep an ENFORCED finish gate, ported
   to the flexible agent (this is task #11 done right). "CI is the real gate" covers nothing pre-commit, no
   analysis/review steps, no repos without CI.
3. **`/aipi-review` is vaporware; the review fan-out is real and working** (`review_swarm`). Build and prove
   `/aipi-review` BEFORE deprecating the fan-out.
4. **The runtime is wired into the KEEP set.** `/aipi-onboard` (which authors the Definition of Done the whole
   vision injects) drives the coordinator; `lifecycle-hooks.js` imports the worker runtime and uses host-model
   readiness to gate the main agent's own turn. "Remove if unused" reads false until those are decoupled.
5. **Removal is budgeted work, not free.** `runtime-contract.json` + the validator (first `npm test` command)
   hard-pin the forked runtime; "delete spawn tools / YAMLs→checklists" fails validation and reddens ~10 test
   suites.

**Revised stance:** keep guidance-first + the flexible default (Phase 1, already shipped & reversible). Add the
enforced flexible-agent finish gate (#2). Then make removal **evidence- and precondition-gated, not
calendar-based** — see §5. The bits below marked "rip out" are downgraded to "decouple, then decide."

## 1. What we learned (the case for change)

Across a long live-debugging session, **every "workflow travado" was in the forked-subagent pipeline**:
worker had no write tool; 120s collect timeout killed multi-minute workers; the `fix` step's owned-file
scope blocked it from editing source; owned-file conflicts on retry/resume; transient 529s weren't retried;
`escalated_to_human` produced no summary/question; and — the deepest one — **workers have no `bash`**, so
`verify`/`regression_test`/`review` could write a test but never RUN it, so they couldn't truly verify and
the run escalated.

We fixed each bug. But the core limitation is **architectural, not a bug**: restricted, no-shell workers +
hard gates ⇒ a step that can't satisfy its gate loops or escalates. On the exact same task (NORA-220) the
**flexible main agent did what the forked pipeline structurally never could**: ran the full Jest suite,
separated real regressions from pre-existing test-debt (baseline vs post), typechecked, and produced a
correct, well-tested fix.

Conclusion: the forked, hard-gated pipeline is the liability. The flexible agent + guidance is the path.

## 2. Principle

**AIPI is a GUIDANCE layer for one flexible, full-tool agent — not an orchestrator of restricted workers.**
The agent does the work; AIPI supplies structure, context, grounding, memory, observability, and (optionally)
independent review. AIPI guides; it never hijacks or straitjackets.

## 3. Target architecture

### 3.1 The agent
The main Pi session, full tools (read / write / edit / bash / grep / …). One flexible agent that triages,
finds root cause, fixes, **runs the tests**, opens the PR, watches CI, and merges per the project's rules.

### 3.2 What AIPI provides (the "guia")
- **Project instructions + Definition of Done** — `.aipi/memory/project/*` incl. `procedures.md` (close-out:
  tests → PR → CI → merge). Per-project (authored via `/aipi-onboard`), injected into every turn.
- **Disciplines** (BDD-first, contract-first, context-thrift) as **soft guidance**, not gates.
- **Grounding tools** the agent PULLS as needed: `aipi_retrieve`, `aipi_rule_lookup`, `aipi_rule_gap`,
  `aipi_callers`, `aipi_impact`, memory query, the code-graph / blast-radius.
- **Observability**: the kanban (the agent's plan/steps), discipline audit, tool-result log — so the human can
  watch and trust.
- **Memory promotion**: durable learnings (root causes, new rules) after a task.

### 3.3 What replaces "gates"
A gate becomes a **self-check + a surface-questions rule**: the agent reasons about whether the Definition of
Done is met; when a requirement is ambiguous (e.g., a BDD rule's intent), it **asks the user a visible
question** instead of silently proceeding or escalating. No silent `escalated_to_human` — always a summary +
a concrete question.

### 3.4 Multi-agent (optional, NARROW)
Not for doing the work in restricted pieces. Only two legitimate uses, both with **flexible (full-tool)**
agents:
- **Independent adversarial review** of a change against the acceptance criteria (what we did to verify
  NORA-220). Candidate: an `/aipi-review` command.
- **Genuine parallel fan-out** (e.g., audit 50 files at once) — only if/when a real need appears.

## 4. Codebase mapping (keep / change / deprecate)

**Keep** — `extensions/aipi/runtime/lifecycle-hooks.js` guidance injection + disciplines + recent-run
awareness; `.aipi/memory/*`; `aipi-tools.js` grounding tools + code-graph; `/aipi-onboard`; kanban/audit;
Definition-of-Done injection.

**Change** — input routing is already auto-dispatch-OFF by default; turn the YAML workflows into **guidance
checklists** the flexible agent reads (keep the BDD/discipline content, drop the forced executable pipeline);
escalation/blocked, where any explicit run remains, must always summarize + ask.

**Deprecate → remove (phased)** — the forked-worker runtime (`subagents.js` / `pi-subagents.js`
coordinator, owned-files, fanout), the executor's forced-worker dispatch, and the hard-gate semantics. These
exist only to run restricted parallel workers — the exact thing that caused the pain.

**Add (optional)** — `/aipi-review` (independent adversarial verification, flexible agents).

## 5. Refactor plan (sequenced; gated on preconditions, not a calendar)

- **Phase A — DONE.** Auto-dispatch off (tasks → flexible agent); project guidance + Definition of Done
  injected every turn.
- **Phase B — Flexible workers + ported evidence gate (foundational).**
  - Full-tool workers: register `aipi_guarded_bash` (+ a guarded edit) into the worker agent config and
    allowlist; add them to `owned-files.js` `classifyToolCall` (today an unrecognized tool hits the deny
    branch); update `runtime-contract.json` denyTools/unknownToolDefault + the validator assertions.
  - Port the evidence gate: an enforced finish check requiring a real `ran` rung (command + exit_code) before
    "done", reusing the step-result evidence vocabulary, applied to the flexible agent and any worker.
- **Phase C — Workflows → checklists + adversarial-review phase.** Turn the YAML workflows into guidance
  checklists the flexible agent follows (BDD + steps + Definition of Done). Add the **review phase** = adversary
  model + adversarial skill + check guideline, fanned out across independent flexible reviewers (repurposing
  `review_swarm`). Surface questions/summaries; never end silently (task #11).
- **Phase D — Decouple the KEEP set from the restricted runtime.** Re-platform `/aipi-onboard`'s investigation
  swarm onto flexible workers; move host-model-readiness gating out of `pi-subagents.js` so `lifecycle-hooks`
  no longer depends on the worker runtime for the main agent's own turn.
- **Phase E — Remove the restricted model.** Delete the no-shell / owned-files-deny worker policy, the
  hard-gate blockers, and the dead executable-pipeline paths; rewrite `runtime-contract.json` + the validator
  for the new mode; get the ~10 dependent test suites green. Gated on B–D being green, not a date.

## 6. Honest trade-offs

**Gain**: tasks actually get DONE (full tools); visible + interactive (questions, summaries, live activity);
project-aware (Definition of Done, memory, blast-radius); much simpler surface; no more stuck/escalating runs.

**Lose** (and the mitigation):
- Per-step auditable artifacts from forked workers → mitigated by the kanban + the agent's own summary + git
  history + (optional) `/aipi-review` artifacts.
- Enforced gates → mitigated by the self-check + adversarial review + the project's CI (the real gate).
- Parallelism → only returns if a real need appears, rebuilt on flexible workers.

## 7. Decisions (owner · 2026-06-22)

1. **Workflows → keep as guidance CHECKLISTS** (not executable forked pipelines). The BDD/discipline/steps +
   the Definition of Done stay as guidance the flexible agent follows.
2. **Build adversarial review — AS A CHECKLIST PHASE, not a separate command.** The review is a step in the
   workflow checklist, composed of: an **adversary model** + an **adversarial skill** (methodology/prompt) + a
   **check guideline** (the acceptance criteria). It runs as the review phase, fanned out to independent
   reviewers.
3. **Remove the restricted/hard-gated model in THIS refactor** (not on a calendar).
4. **Multi-agent orchestration is WANTED — but flexible and WORKING.** Full-tool workers, real orchestration.

### Reconciliation of #3 + #4 (with the critique)
"Remove" (#3) and "working multi-agent orchestration" (#4) are reconciled by separating the **orchestration
plumbing** from the **restricted-worker policy**:
- **REMOVE** (the liability): the no-shell/owned-files-deny worker config, the hard evidence/artifact GATES as
  blockers, the auto-dispatch (already off), and the dead executable-pipeline paths.
- **KEEP + REPURPOSE** (the value, confirmed by the critique): the spawn coordinator, owned-files disjoint-write
  enforcement (the hard part of SAFE parallel fan-out), the fanout, telemetry, and model routing — now driving
  **flexible full-tool workers** (`aipi_guarded_bash` already ships; add it to the worker allowlist +
  `owned-files.js` classifyToolCall + contract/validator). The review fan-out (`review_swarm`) becomes the
  adversarial-review phase from #2.
- **PORT, don't delete** the evidence gate: keep an enforced finish check (real `ran` evidence: command +
  exit_code) for the flexible agent/workers — anti-self-deception (critique §2 / task #11). It moves from a
  worker-internal blocker to a flexible-agent finish gate.

Net: we are not deleting orchestration — we are making its workers flexible and its gates evidence-based
instead of rigid, and turning the YAML pipelines into checklists with an adversarial-review phase.

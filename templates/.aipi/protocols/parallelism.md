# aipi Parallelism Protocol

Parallelism comes from disjoint owned-file sets and sequential reconciliation.

## Rules

- Two write-capable agents must not edit the same file in parallel.
- Every implementation slice declares owned files before mutation.
- Shared state, run manifests, kanban, run root artifacts, and memory are
  single-writer surfaces.
- The orchestrator is the single writer for memory promotion.
- Review, research, context, and verifier agents should be read-only unless
  their artifact path is explicitly assigned.
- Run artifacts are written under
  `.aipi/runtime/runs/{{ run_id }}/steps/{{ step_id }}/` unless the workflow
  contract marks them as orchestrator-owned shared artifacts.
- `withFileMutationQueue` protects read-modify-write operations inside one Pi
  runtime. It is not a cross-session or cross-process lock.
- Parallel worker sessions must acquire owned-file scopes from the orchestrator
  and receive write tools wrapped with a shared ownership registry.
- Community swarm packages may provide jobs, mailboxes, task files, channels,
  or artifacts, but they do not own AIPI BDD gates, durable memory promotion, or
  workflow stage transitions.
- A messenger-style JSONL channel or team task store is acceptable only as
  transient run coordination unless the orchestrator explicitly promotes a
  fact into `.aipi/memory`.
- V1 uses one shared working tree plus disjoint owned-file scopes. Do not mix
  this with per-worker git worktrees in the first spike.
- V1 session workers do not receive `bash` or `user_bash`; shell is opaque to
  reliable write-target extraction and therefore cannot safely run inside
  parallel single-tree writers.
- Shell work such as build, format, test, codegen, file moves, or scripted
  migrations runs in serialized controller/skill steps after worker
  reconciliation, or in a future isolated worker backend.
- Per-worker worktrees are deferred to an out-of-process backend. If adopted,
  the primary safety mechanism becomes merge-back and conflict policy, not the
  single-tree owned-file check.

## Cohorts

| Cohort | Parallelism |
|---|---|
| orchestrator-heavy | never parallel; one active owner |
| planner-heavy | parallel read/reason allowed |
| adversarial-heavy | parallel review allowed |
| research-heavy | parallel research allowed |
| code-strong | parallel only with disjoint owned files |
| test-strong | parallel only with disjoint test files or explicit queue |
| context-fast | parallel allowed |
| verifier-fast | parallel allowed after writes settle |

## Merge Rule

All code-writing workers reconcile sequentially. In v1, any file outside the
owned-file set blocks the worker result and returns to the orchestrator for
review. If a future backend uses per-worker worktrees, each worktree merges back
sequentially under an explicit conflict policy.

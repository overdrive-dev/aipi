# aipi Markdown Brain Protocol

`aipi` keeps business memory in versioned Markdown folders. Markdown is the
source of truth. Git is the history. SQL, search, vectors, and graph edges are
indexes that can be rebuilt from the files.

## Core Rule

When a business answer matters, the agent must be able to point to the Markdown
file it read. Search may find candidates, but the trusted answer comes from the
file.

## Layer Responsibilities

| Layer | Responsibility |
|---|---|
| Markdown files | Authoritative current truth, details, open questions, timeline. |
| Git | Change history, review, rollback, blame, branch/PR workflow. |
| SQLite metadata | Fast filters, stale-review detection, owner/status queries. |
| Search / FTS | Exact and lexical lookup. |
| Vectors | Fuzzy related-context lookup. |
| Graph edges | Relationship lookup between rules, code, tests, decisions, and runs. |

Indexes are never the brain. If an index disagrees with Markdown, Markdown wins
and the index is stale.

Kanban state follows the same rule. The database may index or project kanban
status for speed, but durable task state must be reconstructable from Markdown
memory, run manifests, or Git-tracked workflow artifacts.

## Folder Shape

```text
.aipi/
  memory/
    project/
      README.md
      project.md
      business-rules.md
      decisions.md
      knowledge.md
      environment.md
      procedures.md
      deployment.md
      glossary.md
    agents/
      <agent-id>.md
    user.local.md      # ignored/private by .aipi/.gitignore
  state/
    aipi-graph.json    # generated/rebuildable manifest
    aipi-graph.sqlite  # generated/rebuildable SQLite/search/vector sidecar
```

## Page Shape

Every durable memory page should prefer this shape:

```markdown
---
type: business-rule | decision | knowledge | environment | procedure | deployment | glossary | project
owner: <role or person>
status: draft | active | deprecated
last_reviewed: YYYY-MM-DD
---

# Title

## Current truth

The short version the agent should rely on.

## Details

Additional context and exceptions.

## Open questions

Unresolved business or technical questions.

## Links

- rules:
- decisions:
- code:
- tests:

## Timeline

- YYYY-MM-DD: What changed and why.
```

## Write Discipline

- Agents may propose durable memory updates.
- The orchestrator applies memory updates.
- Shared memory files are single-writer surfaces.
- Every promoted update records source evidence from run artifacts.
- Current truth goes at the top. History goes in `Timeline`.
- Do not bury superseded facts in prose; mark them deprecated or move them to
  timeline.

## Read Discipline

1. Use search/vector/graph to find candidate files.
2. Read the candidate Markdown files.
3. Prefer `Current truth`.
4. Check `Open questions` before acting.
5. Cite the file path and rule/decision id when behavior changes.

## Rebuildability

`aipi-graph` must be able to rebuild all derived code/project memory indexes
from:

- repository source files,
- `.aipi/memory/**/*.md`,
- recent Git history,
- run artifacts under `.aipi/runtime/runs/`.

Deleting `.aipi/state/aipi-graph.json` and `.aipi/state/aipi-graph.sqlite`
should lose speed, not knowledge.

## User Memory Precedence

Use this order when user memory conflicts:

1. active explicit user instruction in the current run;
2. repo-local `.aipi/memory/user.local.md`;
3. global user memory outside the repository;
4. inferred preference candidates that are not promoted yet.

Do not commit personal global preferences or secrets into project memory.

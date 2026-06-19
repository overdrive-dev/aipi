# aipi Memory Promotion Protocol

Run artifacts are not durable memory. At finish, or before a true blocker, the
orchestrator promotes reusable findings into durable memory surfaces.

Markdown files under `.aipi/memory/` are the source of truth. SQLite, search,
vectors, and graph edges are rebuildable indexes over that truth. If an index
disagrees with Markdown, Markdown wins and the index must be refreshed.

## Inputs

- active run manifest
- BDD contract
- agent artifacts under `.aipi/runtime/runs/{{ run_id }}/steps/`
- review findings
- verification evidence
- current project memory

## Durable Outputs

- business rule changes -> `.aipi/memory/project/business-rules.md`
- technical decisions -> `.aipi/memory/project/decisions.md`
- reusable findings -> `.aipi/memory/project/knowledge.md`
- environment and workflow lessons -> `.aipi/memory/project/environment.md`
- repeatable procedures -> `.aipi/memory/project/procedures.md`
- deployment gates and rollback notes -> `.aipi/memory/project/deployment.md`
- business and technical terms -> `.aipi/memory/project/glossary.md`
- agent-role lessons -> `.aipi/memory/agents/<agent-id>.md`
- user preference candidates -> local or global user memory after approval

## Page Convention

Durable project memory should keep the current truth near the top, unresolved
questions in `Open questions`, and history in `Timeline`. Do not bury a changed
rule in old prose; update the current truth and record the change in timeline.

## Required Record

Every run records one memory outcome:

- `promoted`: target files and source evidence listed
- `no-signal`: explanation of why nothing was durable
- `deferred`: blocker and pending memory event listed

Agents propose memory. The orchestrator applies it.

After promotion, the orchestrator marks derived indexes stale or triggers a
refresh. Deleting `.aipi/state/aipi-graph.json` and
`.aipi/state/aipi-graph.sqlite` should lose speed, not knowledge.

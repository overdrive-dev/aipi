# aipi Project Memory

This folder is the project brain for `aipi`.

Markdown files here are the source of truth. The rebuildable JSON/SQLite graph
index caches repository code, code relationships, and domain edges between
business rules, BDD contracts, deployment notes, run artifacts, and source files
for speed; when `sqlite-vec` is available, AIPI also stores local code-line
vectors. Generated indexes are cache layers, and the Markdown files remain
authoritative.

`.aipi/.gitignore` keeps generated runtime state, generated indexes, and
repo-local private user memory out of Git by default.

## Files

- `project.md` - stack, architecture, conventions, and repo map.
- `business-rules.md` - BDD rules and accepted behavior.
- `decisions.md` - technical decisions and ADRs.
- `knowledge.md` - reusable findings, gotchas, and lessons.
- `environment.md` - local/test/deploy environment facts and credential
  locations, never secret values.
- `procedures.md` - repeated operational procedures.
- `deployment.md` - staging/prod paths, gates, rollback, smoke checks.
- `glossary.md` - business and technical terms used by the project.
- `../user.local.md` - repo-local private user preferences; ignored by Git.

## Page Convention

Put the current truth first. Put historical changes in `Timeline`.

Agents should answer from these files only after reading the relevant page, not
only from search results.

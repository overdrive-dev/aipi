# context-thrift

## Trigger

Use at task start, during exploration, and before broad codebase reads.

## Principle

Spend context only on evidence that changes the next action.

## Rules

- Batch independent reads, greps, and status checks.
- Search first, then read only the relevant section.
- Use a search subagent for unknown broad sweeps; keep conclusions, not dumps.
- Do not re-read files just to confirm an edit tool succeeded.
- Established facts and user decisions stay established unless new evidence
  contradicts them.
- Stop exploring when more context would not change the next action.

## Red Flags

- Whole-file reads without a specific question.
- Sequential independent tool calls.
- Rechecking the same fact in one run.
- Exploration whose decision impact is unclear.

# scope-discipline

## Trigger

Use before and during code edits.

## Principle

Change exactly what the accepted request and BDD contract require.

## Rules

- Fix the root cause inside the accepted scope.
- Do not bundle adjacent cleanup, refactors, renames, formatting, dependency
  updates, or new options unless required.
- Extra findings are reported, not silently fixed.
- If an extra change needs a design choice, it is a separate business or
  technical decision.
- Owned-file boundaries are part of scope during parallel work.

## Red Flags

- "While here", "adjacent", "same file", or "arguably".
- Diff size much larger than the business change.
- Making design choices for behavior not covered by the BDD contract.
- Editing outside the assigned file set.

# native-code

## Trigger

Use when writing or editing existing project code.

## Principle

The diff should read like it belongs to the current codebase.

## Rules

- Match naming, error handling, comment density, formatting, imports, and test
  style already present nearby.
- Add comments only for constraints or non-obvious decisions the code cannot
  express.
- Do not add defensive wrappers, logging, config, validation, or TODOs unless
  the existing boundary or BDD contract calls for them.
- Names come from project vocabulary.
- Do not explain stylistic restraint in the final reply unless asked.

## Red Flags

- The new code is more commented than its neighbors.
- New guard for a state the caller contract excludes.
- New vocabulary for an existing concept.
- Debug prints, commented-out code, or self-created TODOs.

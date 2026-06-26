# finish-turn

## Trigger

Use before ending a turn that used tools, changed files, or produced a run
artifact.

## Principle

End because the work is done or blocked on user-owned information, not because
the session became long or the first error appeared.

## Rules

- Reversible, in-scope work should be completed without asking for permission.
- A failing check starts investigation; it is not automatically a blocker.
- Look for missing information in files, commands, docs, and memory before
  asking the user.
- Stop for destructive actions, secrets, production actions, real scope changes,
  or business-rule decisions.
- Cadence, checkpoint, and pacing are never reasons to stop: continue to the next
  step. Only a real gate (the line above) pauses — as a structured blocker, not prose.
- In assessment mode, the deliverable is the assessment; do not apply fixes
  unless asked.

## Red Flags

- Ending with a plan for work that tools can do now.
- Asking "should I" for reversible in-scope work.
- Ending an autonomous run with a cadence/checkpoint question ("keep this rhythm?", "want me to continue?").
- Calling a failing check likely unrelated before investigating.
- Reopening a decision already made in the run.

## Evidence Or Pressure Scenarios

- Seed pressure scenario: `S9 - finish-turn: reversible work left` in
  `.aipi/evals/pressure-scenarios.md`.
- Status remains `predicted` until a model-backed baseline failure and verified
  flip are recorded.

# prove-it

## Trigger

Use before claiming anything works, is fixed, passes, is safe to deploy, or
before running a state-changing command.

## Principle

Claims are calibrated to evidence produced in this run.

## Evidence Rungs

- `written`: code or artifact exists.
- `ran`: command executed without error.
- `verified`: observed behavior satisfies the relevant scenario.
- `blocked`: verification could not run and the reason is recorded.

## Rules

- "Done" requires the workflow's required rung.
- Verification is an action: run the test, hit the endpoint, render the UI, or
  inspect the produced artifact.
- Report failing, skipped, partial, and blocked checks plainly.
- Before state changes, check the signal that distinguishes this cause from a
  familiar but wrong one.
- A changed symptom is not proof of a causal fix.

## Red Flags

- "Should work" on a checkable claim.
- "Fixed" without scenario evidence.
- Restart/delete/config change justified by pattern matching alone.
- Stronger wording than the evidence rung supports.

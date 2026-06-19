# root-cause

Status: predicted

Use this discipline for bugfix, regression, broken pipeline, failed deploy, and defect work.

## Rule

Do not patch symptoms before confirming the actual root cause.

1. Reproduce or pin the failure with a concrete command, test, log, trace, or code path.
2. State the current root-cause assumptions as hypotheses, not facts.
3. Verify each plausible hypothesis against code or runtime evidence.
4. Confirm the actual cause before changing behavior.
5. Plan the fix against that cause, including the smallest regression check that would fail without the fix.
6. Ask the adversarial reviewer to challenge the diagnosis and evidence before reviewing the diff.

## Required Output

- `reproduction`: command, test, log, or code path used to observe the defect.
- `hypotheses`: assumptions considered and the evidence for or against each one.
- `confirmed_root_cause`: the cause that survived verification.
- `fix_plan`: why this change fixes the cause rather than a symptom.
- `regression_verify`: command or check proving the defect path is covered.

## Red Flags

- Starting implementation while the cause is still only guessed.
- Treating a passing test unrelated to the failing path as proof.
- Explaining the diff without explaining why the original behavior failed.
- Letting the reviewer inspect only the patch instead of the diagnosis.

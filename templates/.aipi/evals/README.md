# aipi Pressure Evals

Pressure evals test whether a model class follows `aipi` disciplines under
temptation.

`npm run test:pressure-evals` runs deterministic runtime-gate fixtures for policy
gates and workflow invariants; it does not execute the behavioral scenarios in
`pressure-scenarios.md`. `npm run test:model-pressure-evals` validates the
model-backed behavioral harness and skips by default unless
`AIPI_MODEL_PRESSURE=1` and `AIPI_MODEL_PRESSURE_COMMAND` are set. Those checks
do not make a discipline `observed`; recorded model-backed baseline/verify runs
are still required for that.

## Loop

1. RED: write a self-contained pressure scenario.
2. Baseline: run the target agent/model class without the new or changed
   discipline.
3. Record: save the output, rationale, and verdict.
4. GREEN: change the discipline, example, hook, or policy.
5. Verify: rerun with the discipline injected.
6. Generalize: rerun with a second fact pattern when example echo is possible.

## Storage

Suggested run output:

```text
.aipi/evals/
  pressure-scenarios.md
  baseline-results.md
  verify-results.md
  regressions/
```

Do not promote a new discipline rule as observed unless a baseline failure and
verified flip exist.

All discipline catalog entries start as `status: predicted`. Change a rule to
`observed` only after recording the baseline failure and verified flip here.

## Model-Backed Harness

Opt-in command shape:

```bash
AIPI_MODEL_PRESSURE=1 \
AIPI_MODEL_PRESSURE_PHASE=baseline \
AIPI_MODEL_PRESSURE_COMMAND=/path/to/model-runner \
npm run test:model-pressure-evals
```

The command receives the pressure prompt on stdin and must print the target
agent's final answer on stdout. Use `AIPI_MODEL_PRESSURE_ARGS_JSON` for a JSON
array of command arguments. By default the JSON report is written to
`.aipi/evals/model-pressure-<phase>-results.json`; use
`AIPI_MODEL_PRESSURE_OUTPUT` to choose another path.

`/aipi-status` recognizes model-backed pressure evidence only when both
`.aipi/evals/model-pressure-baseline-results.json` and
`.aipi/evals/model-pressure-verify-results.json` exist, the baseline report has
at least one failing scenario, and every baseline-failed scenario passes in the
verify report.

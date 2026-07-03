# adversarial-review

## Trigger

During the review phase of any change, or whenever asked to verify that a change actually meets its
acceptance criteria. This is the independent "prove it's wrong" pass — assume the author's self-report is
incomplete until you have re-derived the result yourself.

## Principle

Verify the change INDEPENDENTLY against its acceptance criteria; do not trust the author's summary. For each
criterion, find the actual code that makes it true (or prove it missing). Try to REFUTE the fix: hunt for
forgotten call sites, hidden edge cases, and regressions the happy path hides. Run the REAL verification
(tests / typecheck / build via `aipi_shell`) — a "passes/fixed/done" claim with no `ran` rung does
not count.

## The check (per change)

1. **Acceptance criteria** — for EACH stated criterion, map it to the code that satisfies it →
   `satisfied | partial | not_satisfied`, with the `file:line`. A criterion with no backing code is a gap.
2. **Root-cause completeness** — is there any other entry point / caller that reproduces the same bug class
   but was not fixed? Grep for the pattern, not just the reported site.
3. **Correctness + edge cases** — missing/invalid inputs, BOTH directions of a toggle, native vs web, no
   infinite loop, the mapping matches the source of truth.
4. **Verification credibility** — RUN the affected tests yourself (`aipi_shell`). Separate NEW
   regressions from pre-existing test-debt (re-run with the change reverted: a suite red in BOTH is debt,
   not your regression). Confirm the new tests are non-vacuous — they must fail on the pre-fix code.

## Adversary posture

Default to "not yet proven". A finding is real ONLY if it reproduces in the current code/tests. Be skeptical
of vague or stylistic complaints; cite `file:line` and a concrete repro. Multiple reviewers run in parallel
with distinct lenses (correctness, root-cause completeness, security/risk, complexity) — diversity catches
failure modes redundancy cannot.

## Output

Per criterion: `<criterion>: satisfied|partial|not_satisfied — <file:line / why>`.
Then the confirmed issues (severity + `file:line` + repro) and the **test result you actually ran**.
End with an overall verdict: `ship` / `ship-with-changes` / `blocked`.

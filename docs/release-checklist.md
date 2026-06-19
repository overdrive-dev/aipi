# AIPI release checklist

Audience: AIPI package maintainers preparing a release candidate.

Run these checks after the last code or template change:

0. `npm run release:check -- --json`
1. `npm test`
2. `npm run test:release-fixture`
3. `npm run test:adversarial-readiness`
4. `npm run test:fake-provider-workflows`
5. `npm run test:workflow-fixtures`
6. `npm run test:provider-pricing`
7. `node tools/check-provider-pricing.mjs --target <initialized-project> --strict`
8. `npm pack --dry-run --json`
9. `npm run release:audit -- --json`
10. Confirm `package.json` autoloads
    `extensions/aipi/provider/anthropic-oauth-only.ts`,
    and `extensions/aipi/index.js`, not a separate pi-subagents extension and
    not the broad
    `node_modules/@ersintarhan/pi-toolkit/index.ts`.
11. `aipi --version`
12. `aipi status --strict --target <initialized-project>`
13. `npm run readiness:credentialed -- --target <initialized-project> --strict`
    when provider credentials and cost are explicitly approved.
14. `/aipi-status` in an initialized project; the readiness section must not hide
    blockers or external evidence gaps, including `model.capability_floors`.

`npm run release:check -- --json` aggregates the local gates for `npm test`,
`npm pack --dry-run --json`, and `npm run release:audit -- --json`. It emits
`aipi.release-check.v1`; `external_unavailable` means a local gate depends on an
unavailable external endpoint and the release still needs fresh evidence.

Optional live smoke:

- Run one credentialed worker only when provider credentials and cost are
  explicitly acceptable for the release check:
  `AIPI_LIVE_SMOKE=1 npm run smoke:subagent-live`.
- Prefer the consolidated credentialed runner for release evidence:
  `AIPI_MODEL_PRESSURE=1 AIPI_MODEL_PRESSURE_COMMAND=<runner> npm run readiness:credentialed -- --target <initialized-project> --strict`.
- If the release claims configured provider cost estimates, also run
  `node tools/check-provider-pricing.mjs --target <initialized-project> --strict --require-rates`
  after adding current provider/model rates from official pricing pages.
- `npm run release:audit -- --json` wraps
  `npm audit --omit=dev --legacy-peer-deps` with a timeout and structured
  `aipi.npm-audit-release-check.v1` output. `external_unavailable` means the
  registry/audit endpoint did not produce release evidence; rerun it before
  publishing.
- The consolidated runner must fail at preflight, before paid/provider work,
  when local blockers remain (`project.install`, `provider.anthropic.auth`,
  `model.capability_floors`, or specification-only claims).
- Successful live smoke writes `.aipi/runtime/smoke/live-subagent-result.json`;
  successful model pressure runs write
  `.aipi/evals/model-pressure-baseline-results.json` and
  `.aipi/evals/model-pressure-verify-results.json`. `/aipi-status` recognizes
  model-backed pressure only when the baseline has at least one failure and the
  verify report proves those scenarios pass.
- The non-LLM worker toolset smoke in `npm run test:subagents-real-sdk` is
  required before release; a live LLM worker is extra evidence, not a replacement.

Release blockers:

- README, `/aipi-status`, or docs claim a runtime feature is live without a test,
  probe, or smoke command.
- `/aipi-status` omits `aipi.readiness-report.v1` or collapses model-backed
  pressure/live-smoke gaps into an undifferentiated success status.
- `/aipi-status` reaches adversarial-review readiness while
  `.aipi/model-capabilities.json` is missing a class mapping, missing model
  capabilities, or declaring capabilities below the floor in
  `.aipi/model-classes.yaml`.
- `npm pack --dry-run --json` includes unintentional files or misses packaged
  runtime/docs/templates.
- `npm run test:release-fixture` cannot initialize a clean project from the
  packaged bin/extensions/templates surface.
- Any catalog-referenced `aipi_*` tool is missing from the runtime or drifts from
  `runtime-contract.json`. New future tools may be marked specification-only,
  but the current catalog surface is expected to be implemented.
- Parent-session permission profiles or tool-call approval gates reappear after
  their intentional removal. Evidence anchors: `npm run test:permission-removal`
  and `npm run test:lifecycle-hooks`.
- `/aipi-status` omits the capability report or collapses `verified`, `wired`,
  and `specification` into one ambiguous readiness claim.

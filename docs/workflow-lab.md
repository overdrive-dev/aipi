# AIPI workflow lab

The workflow lab is a persistent, local dogfood repository for testing AIPI against a
small but real application. It contains a React/Vite client, an Express/TypeScript API,
Vitest/Supertest tests, a production build, and Playwright browser coverage.

The generated project lives at `.aipi-lab/taskboard`. The outer AIPI repository ignores
all of `.aipi-lab/`; the generated project has its own Git repository and local baseline
tags. Only the generator and template under `tools/` are versioned by AIPI.

## Why this boundary exists

Pi is an extensible coding-agent harness, not an implicit security sandbox. Its default
tool surface includes file and shell tools, extensions may override built-ins or block
tool calls, and the official package documentation warns that installed Pi packages run
with full system access. Pi also provides a sandbox extension example, which means a
sandbox must be selected and implemented rather than assumed.

Sources:

- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi package security warning](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md)
- [Pi default system prompt/tool selection](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts)

The lab therefore supplies a correctness and reproducibility boundary, not a security
boundary. It contains no credentials and its project memory explicitly forbids deploys
and external services. A live model run still sends the task and portions of this local
lab repository to the configured model providers; run it only when that disclosure is
acceptable.

## Commands

From the AIPI repository root:

```powershell
npm run lab:init
npm run lab:status
npm run lab:reset
npm run lab:run -- feature --phase before
npm run lab:verify -- feature
```

- `lab:init` copies the tracked template, installs exact dependencies and Chromium,
  creates the nested Git repository, installs the current `.aipi` overlay, and records
  the `aipi-lab-app-baseline` and `aipi-lab-ready-baseline` tags. Use
  `npm run lab:init -- --force` only to rebuild the generated project from the template.
- `lab:reset` hard-resets only the guarded nested lab path, clears generated/runtime
  state, refreshes the current AIPI overlay and model topology, and runs the full green
  baseline (`typecheck`, unit tests, production build, browser smoke test).
- `lab:run` requires a clean nested repository and starts the real interactive AIPI
  wrapper in JSON mode. Raw Pi events, stderr, run states, model topology, elapsed time,
  changed files, and the project diff are written under `.aipi-lab/results/`.
- `lab:verify` first reruns the baseline, then executes an acceptance suite that is
  separate from the application tests. Feature, bugfix, and quick scenarios also require
  at least one changed file outside `.aipi`.

## Scenarios

| Scenario | Cross-cutting behavior | Acceptance surface |
|---|---|---|
| `feature` | Priority filter in API, React UI and URL persistence | Supertest + Playwright |
| `bugfix` | Idempotent repeated completion transition | Supertest regression |
| `quick` | One exact empty-state copy change | Source assertion + baseline build |
| `ops` | Local production build and health check; no deployment | Build artifacts + API health |

The acceptance tests intentionally fail against the seed application for feature,
bugfix, and quick. Do not edit `eval/` in a workflow run. `AGENTS.md` inside the lab makes
that constraint visible to workers.

## Fair before/after comparison

Use the same scenario, prompt, pinned Pi version, model topology and thinking levels for
both runs:

```powershell
npm run lab:reset
npm run lab:run -- feature --phase before
npm run lab:verify -- feature

npm run lab:reset
npm run lab:run -- feature --phase after
npm run lab:verify -- feature
```

Do not retry a failed live phase merely to improve the score. Compare the manifests for:

- whether planning produced a non-empty accepted contract;
- whether the linked feature run started and retained `upstream_run_id`;
- terminal status and blocker reason;
- source files changed outside `.aipi`;
- baseline and external acceptance results;
- elapsed time and workflow step history.

`planning` by itself remains a plan-only workflow. Feature delivery uses the durable
`planning-feature` chain so a blocked planning run can accept user input, resume, and
launch feature only after its exact contract exists.

## Pi compatibility

The repository keeps Pi pinned during a before/after comparison. Probe a newer Pi in a
temporary install and run the extension/SDK regression suite before changing the pin;
do not mix a Pi upgrade into a workflow-behavior comparison.

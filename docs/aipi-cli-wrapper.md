# AIPI CLI wrapper

`aipi` is the product entry point for this package. It keeps Pi as the runtime,
but starts Pi with the AIPI extensions preloaded.

## Local use

From this repository:

```powershell
npm link
aipi --version
aipi --help
aipi
aipi --pi-help
aipi status
aipi status --json
aipi status --strict
aipi workflow list
aipi workflow status
aipi workflow start quick --dry-run
aipi memory status
aipi memory refs
aipi memory query business rules
aipi update --dry-run
aipi "/aipi-status"
aipi "/aipi-init"
aipi -p --provider openai-codex --model gpt-5.5 "planeje a proxima feature"
```

`aipi` with no arguments starts an interactive Pi session with the packaged AIPI
extensions preloaded. This is the normal entry point for using Pi through AIPI.

`aipi --version` is handled by the wrapper and reports both layers:

```text
aipi 0.1.0 (pi 0.75.5)
```

Use `aipi --pi-version` or `aipi --pi-help` when you want the raw Pi output.

`aipi status [--target <dir>] [--json] [--strict]` runs the same project,
provider/auth, model-floor, capability, and external-evidence checks as
`/aipi-status` without launching a Pi session. Use `--target` to inspect another
repository, `--json` for machine-readable output, and `--strict` when a warning
or blocker should make the wrapper exit non-zero. `aipi doctor` is an alias.

`aipi workflow [--target <dir>] [--json] [list|status|start <name>|run <name>|execute]`
uses the same run-state runtime as `/aipi-workflow` without launching a Pi
session first. Use it for workflow inspection, dry-run starts, and active-run
status from scripts or release fixtures.

`aipi memory [--target <dir>] [--json] [status|refs|query <terms>]` uses the
same Markdown memory query runtime as `aipi_memory_query` without launching a Pi
session first. Use it for read-only inspection of project/user memory files and
generated code graph state from scripts or release fixtures.

The former profile/permission-policy wrapper was removed by design. `aipi`
preserves ordinary Pi arguments for interactive source edits instead of routing
them through a parent-session profile gate.

## What it runs

The wrapper preserves all user flags and prepends the packaged extensions from
`templates/.aipi/runtime-contract.json` plus the local AIPI extension:

```powershell
pi --extension <package>/extensions/aipi/provider/anthropic-oauth-only.ts `
   --extension <package>/extensions/aipi/index.js `
   <user args>
```

The forked pi-subagents worker runtime is AIPI code loaded by
`extensions/aipi/index.js`; it is not a separately-loaded Pi extension and does
not require an environment flag.

Use `AIPI_PI_CLI_JS` to point directly at a Pi `dist/cli.js` file, or
`AIPI_PI_BIN` to force a specific Pi executable.

## Updating

`aipi update` updates Pi with `pi update --self`, then updates the AIPI checkout
with `git pull --ff-only` and `npm install --prefix <package>`. It skips the AIPI
git step with a clear message when the package root is not a git checkout, has
no commit yet, has no upstream remote, or has local changes. Use
`aipi update --dry-run` to inspect the plan without mutating Pi, git, or npm.

# pi-subagents vendor snapshot

Source: `nicobailon/pi-subagents`
Repository: `https://github.com/nicobailon/pi-subagents`
Package: `pi-subagents@0.28.0`
Tarball: `https://registry.npmjs.org/pi-subagents/-/pi-subagents-0.28.0.tgz`
Integrity: `sha512-EWgQphVqH7BWJFNiWdyOCa8uqwr/aWkm9OyhItFiIJfpmdY4mGUlZ2VK1z3UP6XfVAmidtGd0MsnyhuFTxAm0A==`
License: MIT, declared in upstream `package.json`.

## Copied

This directory contains the npm tarball contents for `pi-subagents@0.28.0`:

- `src/` worker-runner, foreground/background execution, extension registration, slash bridges, shared utilities, and TUI render helpers.
- `agents/`, `prompts/`, and `skills/` assets used by the subagent runtime.
- Upstream `README.md`, `CHANGELOG.md`, `package.json`, and `install.mjs` for provenance.
- `LICENSE`, added here from the upstream package's declared MIT license because the npm tarball does not ship a standalone license file.

## Omitted

- Upstream tests and development-only files not included in the published npm tarball.
- pi-fable discipline/workflow code. AIPI keeps its own BDD gates, memory ledger, diagnostics, and workflow contracts.
- Pi peer packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-coding-agent`. These are resolved from the host Pi runtime and must not be bundled here.

## Runtime loading

AIPI does not load pi-subagents as a separate Pi extension. The stable AIPI
`aipi_*` tool surface calls `extensions/aipi/runtime/pi-subagents.js`, which
uses `jiti` to execute this vendored TypeScript entrypoint:

`extensions/aipi/runtime/vendor/pi-subagents/src/runs/foreground/execution.ts`

The fork runs in the project cwd and writes agent/session/artifact/result state
under `.aipi/runtime/subagents/`. AIPI passes the host-scoped model into the
fork, disables fallback models, and keeps workers on the selected provider/model before worker
allocation.

End users do not run `pi install npm:pi-subagents`.

## AIPI local patches (MUST be re-applied on every re-sync)

Replacing this directory with a fresh tarball silently drops these in-place
patches; re-apply each one and keep this list current:

1. `src/shared/types.ts` / `src/shared/utils.ts` — `AIPI_SUBAGENTS_RUNTIME_DIR`
   / `AIPI_SUBAGENTS_AGENT_DIR` env redirection of runtime/agent state dirs.
2. `src/runs/shared/pi-spawn.ts` — `getPiSpawnCommand` honors `AIPI_PI_BIN` and
   `AIPI_PI_CLI_JS` (exported by `bin/aipi.js` on spawn) BEFORE the
   argv[1]/import.meta.resolve/bare-`pi` fallbacks, so worker children run the
   same Pi the wrapper resolved (kills the wrapper/worker split-brain). The
   `PiSpawnDeps.env` field is part of this patch. Guarded by the
   `getPiSpawnCommand honors AIPI_PI_CLI_JS` tripwire in
   `tools/test-subagents.mjs` — if a re-sync loses the patch, that test fails.

## Re-sync procedure

1. Review the target upstream release and its changelog.
2. Run `npm pack pi-subagents@<version> --json`.
3. Verify the tarball integrity from npm metadata.
4. Replace this directory with the new tarball contents.
5. Restore this `VENDOR.md` and `LICENSE` if the new tarball still omits a standalone license file, and re-apply every patch in "AIPI local patches" above.
6. Update pinned dependency versions in root `package.json` for `jiti` and
   `typebox` as needed. Do not add `@earendil-works/pi-tui` as a direct AIPI
   dependency unless the separately-loaded TUI extension surface is deliberately
   restored.
7. Run `npm install --package-lock-only --ignore-scripts --legacy-peer-deps`.
8. Run `npm test`, `npm run validate`, `npm run test:subagents`, and `npm run test:subagents-real-sdk`.
9. Run the live `/aipi-pi-subagents-spike` in a credentialed AIPI/Pi session before starting adapter parity work.

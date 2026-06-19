# Anthropic auth integration

Audience: AIPI users and runtime maintainers configuring Anthropic models in Pi.

Post-read action: know how Anthropic OAuth is loaded, authenticated, and
validated for AIPI.

## Decision

AIPI depends on pinned `@ersintarhan/pi-toolkit@0.5.12` as the upstream source
for Pi's Anthropic OAuth adapter.

The package includes a Claude OAuth adapter for Pi's built-in `anthropic`
provider while keeping Pi's normal `/login anthropic` flow. The adapter is used
because the previous bundled CortexKit provider returned Anthropic
`out of extra usage` responses in local testing.

This is a conscious alpha tradeoff: AIPI keeps the broad toolkit as a pinned
dependency, but does not autoload its broad `index.ts` by default. Instead, AIPI
loads an AIPI-owned OAuth-only wrapper that imports only
`src/claude-oauth-adapter.ts`. The package/version/path/scope are validated
against `templates/.aipi/runtime-contract.json`.

## How It Loads

The AIPI package manifest loads two extensions:

1. `extensions/aipi/provider/anthropic-oauth-only.ts`
2. `extensions/aipi/index.js`

The OAuth-only wrapper is loaded first so its Anthropic OAuth hooks are active
before AIPI model routing and the forked worker runtime resolve agent classes. The
pi-subagents fork is AIPI runtime code behind `extensions/aipi/index.js`, not a
separately-loaded Pi extension. Loading the full
`node_modules/@ersintarhan/pi-toolkit/index.ts` surface is not the default; treat
that as an explicit local opt-in if a project wants the toolkit's other
providers/search features.

This is a pinned dependency, not a loose instruction. The package is pinned in
`dependencies` and validated by `npm run validate`. Pi core packages remain
runtime peers supplied by the active Pi installation rather than dependencies
packaged by AIPI.

## Transitive Adapter Behavior

The AIPI wrapper is narrow, but `src/claude-oauth-adapter.ts` is still executable
provider code inside the Pi process. In the pinned `@ersintarhan/pi-toolkit`
version it registers provider hooks that normalize Anthropic OAuth requests:

- It strips the Claude Code identity system block before the provider request.
- It preserves an existing `x-anthropic-billing-header` text block or injects a
  synthetic one when absent.
- It can strip and re-inject Pi docs context around Anthropic OAuth turns.

Those request mutations are intentionally inherited by the OAuth-only wrapper and
are recorded in `templates/.aipi/runtime-contract.json`. Treat any package bump
as a diff review of `src/claude-oauth-adapter.ts`, especially
`before_provider_request`, identity-block handling, billing-header handling, and
docs-context handling.

## Install And Login

After installing or running the AIPI package in Pi, authenticate with Pi's normal
Anthropic login:

```text
/login anthropic
```

Pi stores credentials in its normal auth file:

```text
~/.pi/agent/auth.json
```

If needed, move the whole Pi agent directory with:

```text
PI_CODING_AGENT_DIR=/path/to/agent-dir
```

Use AIPI's status command to verify the local package and auth file without
printing credential values:

```text
/aipi-status
```

The status report checks the provider package, installed version,
extension path, auth-file location, the current Pi/toolkit JSON shape, a bounded
generic Anthropic-token fallback, and whether Anthropic auth material exists. It
intentionally does not display access tokens, refresh tokens, API keys, account
ids, or labels. If future Pi/toolkit versions change the auth schema beyond that
fallback, the Pi footer or a live provider smoke remains the source of truth.

## Useful Toolkit Signals

`@ersintarhan/pi-toolkit` shows Claude OAuth status in the Pi footer when its
adapter applies. For debugging, launch Pi with a log file:

```bash
PI_CLAUDE_OAUTH_LOG_FILE=./claude-oauth.log aipi
```

Do not commit the log file; provider payload logs may include sensitive context.

## AIPI Boundary

Anthropic auth is a provider/auth layer only. It does not own:

- BDD contract authority;
- workflow gates;
- memory promotion;
- owned-file enforcement;
- production approval policy;
- agent runtime selection.

AIPI still resolves model classes by capability and currently configured
providers. If Anthropic is not authenticated or quota is exhausted, the model
router must either choose another configured provider or fail loudly.

## Security Notes

Pi packages execute code inside the Pi process. AIPI pins the toolkit package
version and loads only the OAuth adapter wrapper by default. Because the upstream
toolkit remains broader than Anthropic OAuth, treat new `pi-toolkit` version
bumps as runtime-surface changes: review the package diff, verify the wrapper
still imports only `src/claude-oauth-adapter.ts`, run `npm test`, run
`npm audit --omit=dev --legacy-peer-deps`, and do a credentialed
`/login anthropic` smoke before release.

Do not commit auth files or credentials. The auth path should be recorded as a
location only, never with tokens or account secrets.

Run:

```text
npm test
npm audit --omit=dev --legacy-peer-deps
```

The project install intentionally uses `--legacy-peer-deps` so Pi core packages
remain runtime peers supplied by Pi instead of being bundled into AIPI.

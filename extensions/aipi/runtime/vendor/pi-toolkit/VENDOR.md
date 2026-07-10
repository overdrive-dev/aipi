# Vendored: @ersintarhan/pi-toolkit (Claude OAuth adapter)

Forked from **@ersintarhan/pi-toolkit@0.5.12** (MIT, see LICENSE) — only `src/claude-oauth-adapter.ts`.
AIPI vendors this single file instead of depending on the npm package so the Anthropic (Claude Pro/Max) OAuth
adapter is native, matching the pi-subagents / pi-xai-oauth vendoring posture.

## What is included

- `claude-oauth-adapter.ts` — the Claude OAuth adapter: when the active model is Anthropic + OAuth it strips the
  Claude Code identity block, injects/preserves the `x-anthropic-billing-header`, and handles Pi docs-context
  around the request. Imports only `@earendil-works/pi-coding-agent` / `pi-agent-core` / `pi-ai` TYPES (erased at
  load) + Node builtins.

The AIPI wrapper is `extensions/aipi/provider/anthropic-oauth-only.ts` (imports only this file, never the
package's broad `index.ts`).

## Updating — HIGH CHURN

This adapter tracks Claude Code's evolving backend request format (billing-header hashing tied to the Claude
Code version, identity handling). It changes more often than the xAI provider. Re-vendor from the upstream when
Anthropic changes the Claude Code request shape; review identity-block / billing-header / docs-context / provider
hook behavior on each re-vendor.

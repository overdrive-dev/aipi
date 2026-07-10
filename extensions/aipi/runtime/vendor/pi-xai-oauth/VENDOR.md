# Vendored: pi-xai-oauth (provider-only)

Forked from **pi-xai-oauth@1.3.1** (MIT, see LICENSE). AIPI vendors this instead of
depending on the npm package so the xAI (Grok) OAuth provider is native — full
supply-chain control, matching the pi-subagents vendoring posture.

## What is included (provider-only)

Only the subgraph needed to register the provider + models + OAuth + streaming:

- `auth.ts`, `oauth.ts` — SuperGrok / X Premium+ OAuth (PKCE against auth.x.ai) + credential refresh
- `constants.ts`, `models.ts` — provider id (`xai-auth`), endpoints, Grok model definitions
- `responses.ts`, `payload.ts`, `text.ts`, `images.ts` — the `xai-responses` stream handler + payload shaping

These import only `@earendil-works/pi-ai` (type-only, erased at load), Node builtins, and each other.

## What is DELIBERATELY excluded

The upstream default export also calls `registerXaiTools`, which registers Cursor/Grok-CLI tool shims
(`Read/Write/StrReplace/Edit/Delete/LS/Grep/Glob/Shell`) — a raw bash + raw write/delete surface that bypasses
AIPI's guarded write and aipi_shell watchdog. `extensions/xai/tools/*`, `cursor-shims.ts`, `custom-tools.ts`,
`common.ts`, `cursor-args.ts` were NOT vendored. The AIPI wrapper (`extensions/aipi/provider/xai-oauth.ts`)
registers ONLY the provider.

## Updating

Re-vendor from the upstream on demand: copy the provider subgraph, re-confirm it does not pull in the tool
shims, and review `oauth.ts`/`models.ts`/`responses.ts` for endpoint/model/streaming changes.

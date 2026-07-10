import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGrokAuthCredentials } from "../../runtime/vendor/pi-xai-oauth/auth.ts";
import { XAI_API_BASE_URL, XAI_PROVIDER_ID } from "../../runtime/vendor/pi-xai-oauth/constants.ts";
import { MODELS } from "../../runtime/vendor/pi-xai-oauth/models.ts";
import { createXaiOAuth } from "../../runtime/vendor/pi-xai-oauth/oauth.ts";
import { streamSimpleXaiResponses } from "../../runtime/vendor/pi-xai-oauth/responses.ts";

// AIPI-owned wrapper for the VENDORED xAI OAuth provider (extensions/aipi/runtime/vendor/pi-xai-oauth — the
// provider-only subgraph forked from pi-xai-oauth@1.3.1, NOT an npm dependency). Registers ONLY the provider +
// Grok models. The package's Cursor/Grok-CLI tool shims (raw Read/Write/StrReplace/Edit/Delete/LS/Grep/Glob/
// Shell — a raw bash + raw write/delete surface) were deliberately NOT vendored, so AIPI's guarded write and
// aipi_shell watchdog stay authoritative. Mirrors the vendored Anthropic wrapper (anthropic-oauth-only.ts).
export default function aipiXaiOauthProvider(pi: ExtensionAPI) {
  (pi as any).registerProvider(XAI_PROVIDER_ID, {
    name: "xAI (OAuth)",
    baseUrl: XAI_API_BASE_URL,
    api: "xai-responses",
    models: MODELS as any,
    authHeader: true,
    streamSimple: streamSimpleXaiResponses as any,
    oauth: createXaiOAuth({ getExistingCredentials: getGrokAuthCredentials }) as any,
  });
}

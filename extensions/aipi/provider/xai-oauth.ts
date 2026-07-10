import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGrokAuthCredentials } from "../../../node_modules/pi-xai-oauth/extensions/xai/auth.ts";
import { XAI_API_BASE_URL, XAI_PROVIDER_ID } from "../../../node_modules/pi-xai-oauth/extensions/xai/constants.ts";
import { MODELS } from "../../../node_modules/pi-xai-oauth/extensions/xai/models.ts";
import { createXaiOAuth } from "../../../node_modules/pi-xai-oauth/extensions/xai/oauth.ts";
import { streamSimpleXaiResponses } from "../../../node_modules/pi-xai-oauth/extensions/xai/responses.ts";

// AIPI-owned wrapper for the pi-xai-oauth provider. It registers ONLY the xAI OAuth provider + Grok models
// (SuperGrok / X Premium+ subscription via /login xai-auth). It DELIBERATELY does NOT call the package's
// default export path registerXaiTools(pi): those Cursor/Grok-CLI shims register raw Read/Write/StrReplace/
// Edit/Delete/LS/Grep/Glob/Shell tools — a raw bash + raw write/delete surface that bypasses AIPI's guarded
// write and aipi_shell watchdog. AIPI's own tool surface stays authoritative; raw bash/write must never enter
// an AIPI session. Mirrors the narrow-import posture of the Anthropic wrapper (anthropic-oauth-only.ts).
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

import claudeOauthAdapter from "../../../node_modules/@ersintarhan/pi-toolkit/src/claude-oauth-adapter.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function aipiAnthropicOauthOnly(pi: ExtensionAPI) {
  claudeOauthAdapter(pi);
}

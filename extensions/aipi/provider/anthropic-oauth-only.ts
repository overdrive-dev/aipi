import claudeOauthAdapter from "../../runtime/vendor/pi-toolkit/claude-oauth-adapter.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function aipiAnthropicOauthOnly(pi: ExtensionAPI) {
  claudeOauthAdapter(pi);
}

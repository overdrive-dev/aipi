import { registerAipiMcpBridge } from "./runtime/mcp-bridge.js";
import { resolveProjectRoot } from "./runtime/project-init.js";

export default function aipiMcpBridgeExtension(pi) {
  return registerAipiMcpBridge(pi, {
    projectRootResolver: (ctx) => resolveProjectRoot(ctx),
  });
}

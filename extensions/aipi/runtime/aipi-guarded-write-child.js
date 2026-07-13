import fs from "node:fs/promises";
import path from "node:path";
import {
  workerProjectRoot,
  workerAgentId,
  workerProjectScoped,
  ownedFilesFromEnv,
  normalizeRelativePath,
  assertInside,
  assertWorkerWritable,
} from "./aipi-worker-path-guard.js";

export default function registerAipiGuardedWriteChild(pi) {
  pi.registerTool?.({
    name: "write",
    label: "Write",
    description: "Write a file inside this AIPI worker's owned-file allocation.",
    parameters: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      additionalProperties: false,
    },
    async execute(_id, params = {}) {
      const root = workerProjectRoot();
      const agentId = workerAgentId();
      const relPath = normalizeRelativePath(params.path);
      const projectScoped = workerProjectScoped();
      // Controller-owned state (.aipi/memory, .aipi/runtime/runs non-artifacts, .git) is always off-limits,
      // regardless of scope; in "artifacts" scope only the owned set is writable. Shared guard, single-sourced
      // with the hashline aipi_edit tool (see aipi-worker-path-guard.js).
      try {
        assertWorkerWritable(relPath, { agentId, owned: ownedFilesFromEnv(), projectScoped });
      } catch (error) {
        return blocked(String(error?.message ?? error));
      }

      const target = path.resolve(root, relPath);
      assertInside(root, target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(params.content ?? ""));
      return { content: [{ type: "text", text: `wrote ${relPath}` }] };
    },
  });
}

function blocked(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

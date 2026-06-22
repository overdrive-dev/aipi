import fs from "node:fs/promises";
import path from "node:path";
import { isControllerOwnedPath } from "./owned-files.js";

const PROJECT_ROOT_ENV = "AIPI_SUBAGENTS_PROJECT_ROOT";
const OWNED_FILES_ENV = "AIPI_SUBAGENTS_OWNED_FILES";
const AGENT_ID_ENV = "AIPI_SUBAGENTS_AGENT_ID";
const WRITE_SCOPE_ENV = "AIPI_SUBAGENTS_WRITE_SCOPE";

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
      const root = path.resolve(process.env[PROJECT_ROOT_ENV] || process.cwd());
      const agentId = process.env[AGENT_ID_ENV] || "aipi-worker";
      const relPath = normalizeRelativePath(params.path);
      const projectScope = (process.env[WRITE_SCOPE_ENV] || "artifacts") === "project";
      // Controller-owned state (.aipi/memory, .aipi/runtime/runs non-artifacts) is always off-limits,
      // regardless of scope. The explicit .aipi/memory check below is a belt-and-suspenders guard.
      if (isControllerOwnedPath(relPath)) {
        return blocked(`aipi: ${agentId} may not write ${relPath}; controller-owned AIPI memory/runtime state.`);
      }
      if (projectScope) {
        // Code-writing step: any other in-root path is writable so the worker can apply its fix.
      } else {
        const owned = ownedFilesFromEnv();
        if (!owned.has(relPath)) {
          return blocked(`aipi: ${agentId} may not write ${relPath}; outside its owned-file scope.`);
        }
      }
      if (relPath === ".aipi/memory" || relPath.startsWith(".aipi/memory/")) {
        return blocked(`aipi: ${agentId} may not write durable memory from a worker.`);
      }

      const target = path.resolve(root, relPath);
      assertInside(root, target);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(params.content ?? ""));
      return { content: [{ type: "text", text: `wrote ${relPath}` }] };
    },
  });
}

function ownedFilesFromEnv() {
  try {
    const parsed = JSON.parse(process.env[OWNED_FILES_ENV] || "[]");
    return new Set((Array.isArray(parsed) ? parsed : []).map(normalizeRelativePath));
  } catch {
    return new Set();
  }
}

function normalizeRelativePath(value) {
  const raw = String(value ?? "").trim().replaceAll("\\", "/");
  if (!raw) throw new Error("write path is required");
  if (raw.includes("\0")) throw new Error(`write path contains NUL: ${raw}`);
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`write path must be relative: ${raw}`);
  }
  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`write path escapes project root: ${raw}`);
  }
  if (normalized === ".git" || normalized.startsWith(".git/")) {
    throw new Error(`write path targets .git: ${raw}`);
  }
  return normalized;
}

function assertInside(root, target) {
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`write path escapes project root: ${target}`);
  }
}

function blocked(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

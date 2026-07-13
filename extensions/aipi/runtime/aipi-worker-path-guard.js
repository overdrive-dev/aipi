// Shared owned-file write-guard helpers for AIPI worker child extensions.
//
// Single-sources the security-critical path normalization + owned-file scope
// check so every worker-side write tool (the guarded `write`, the hashline
// `aipi_edit`) enforces the SAME rules from the SAME env contract. The forked
// worker receives its scope through these env vars, set by the coordinator in
// pi-subagents.js (applyScopedRuntimeEnv):
//   AIPI_SUBAGENTS_PROJECT_ROOT  absolute project root
//   AIPI_SUBAGENTS_OWNED_FILES   JSON array of relative owned paths
//   AIPI_SUBAGENTS_AGENT_ID      this worker's agent id (for messages)
//   AIPI_SUBAGENTS_WRITE_SCOPE   "artifacts" (owned set only) | "project" (any in-root, non-controller)

import path from "node:path";
import { isControllerOwnedPath } from "./owned-files.js";

export const PROJECT_ROOT_ENV = "AIPI_SUBAGENTS_PROJECT_ROOT";
export const OWNED_FILES_ENV = "AIPI_SUBAGENTS_OWNED_FILES";
export const AGENT_ID_ENV = "AIPI_SUBAGENTS_AGENT_ID";
export const WRITE_SCOPE_ENV = "AIPI_SUBAGENTS_WRITE_SCOPE";

/** Absolute project root the worker is scoped to. */
export function workerProjectRoot() {
  return path.resolve(process.env[PROJECT_ROOT_ENV] || process.cwd());
}

/** This worker's agent id (used only in operator-facing block messages). */
export function workerAgentId() {
  return process.env[AGENT_ID_ENV] || "aipi-worker";
}

/** True when this worker holds project-wide source-write scope (a code-writing step). */
export function workerProjectScoped() {
  return (process.env[WRITE_SCOPE_ENV] || "artifacts") === "project";
}

/** The worker's owned-file allocation as a normalized relative-path Set. */
export function ownedFilesFromEnv() {
  try {
    const parsed = JSON.parse(process.env[OWNED_FILES_ENV] || "[]");
    return new Set((Array.isArray(parsed) ? parsed : []).map(normalizeRelativePath));
  } catch {
    return new Set();
  }
}

/**
 * Normalize an authored write path to a safe, forward-slash relative path.
 * Throws on empty, NUL, absolute, root-escaping, or `.git` targets.
 */
export function normalizeRelativePath(value) {
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

/** Assert an absolute `target` resolves inside `root`. */
export function assertInside(root, target) {
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (target !== root && !target.startsWith(rootWithSep)) {
    throw new Error(`write path escapes project root: ${target}`);
  }
}

/**
 * Throw a worker-facing error if `relPath` (already normalized) is not writable
 * by this worker: controller-owned state is always refused; in "artifacts"
 * scope only the owned set is writable; durable memory is never worker-writable.
 * `relPath` must come from {@link normalizeRelativePath}.
 */
export function assertWorkerWritable(relPath, { agentId, owned, projectScoped }) {
  if (isControllerOwnedPath(relPath)) {
    throw new Error(`aipi: ${agentId} may not write ${relPath}; controller-owned AIPI memory/runtime state.`);
  }
  if (!projectScoped && !owned.has(relPath)) {
    throw new Error(`aipi: ${agentId} may not write ${relPath}; outside its owned-file scope.`);
  }
  if (relPath === ".aipi/memory" || relPath.startsWith(".aipi/memory/")) {
    throw new Error(`aipi: ${agentId} may not write durable memory from a worker.`);
  }
}

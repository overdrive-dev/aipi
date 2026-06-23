// Owned-file allocation registry + per-worker tool_call guard.
//
// AIPI owns cross-worker file scoping. Pi's withFileMutationQueue only
// serializes writes inside one runtime, so disjointness across spawned workers
// is enforced here. See docs/pi-subagent-build-plan.md and
// templates/.aipi/protocols/parallelism.md.

import path from "node:path";

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "web_search",
  "web_fetch",
  "aipi_memory_query",
  "aipi_rule_lookup",
  "aipi_rule_gap",
  "aipi_callers",
  "aipi_impact",
  "aipi_retrieve",
  // Watchdog-wrapped, project-root-scoped worker shell (aipi-guarded-bash-child). The owned-file guard
  // cannot police writes a shell makes, so worker write-disjointness is BEST-EFFORT once a worker has it —
  // a deliberate trade for letting workers actually run tests/build to verify. Raw bash/user_bash stay
  // OPAQUE-denied below.
  "aipi_guarded_bash",
]);

const PATH_MUTATING_TOOLS = new Set(["write", "edit", "multi_edit", "apply_patch"]);
const OPAQUE_MUTATING_TOOLS = new Set(["bash", "user_bash"]);
const PATH_FIELDS = ["path", "file_path", "filePath", "target"];
const MEMORY_PREFIX = ".aipi/memory/";
const RUNTIME_RUNS_PREFIX = ".aipi/runtime/runs/";

export class OwnedFileRegistry {
  #byAgent = new Map(); // agent_id -> Set<absolutePath>
  #owner = new Map(); // absolutePath -> agent_id
  #projectScoped = new Set(); // agent_ids granted project-wide source-write scope
  #root;

  constructor(root) {
    this.#root = path.resolve(root ?? process.cwd());
  }

  // Grant an implementation/fix/tdd worker the right to write ANY project source
  // file (anything not controller-owned). Code-writing steps cannot pre-declare the
  // exact files a fix will touch (a root-cause fix may create new files), so they get a
  // path-scope instead of an exact owned-file set. Controller paths (.aipi/memory,
  // .aipi/runtime/runs non-artifacts, .git) stay protected — see owns()/isProtectedWritePath.
  grantProjectScope(agentId) {
    this.#projectScoped.add(agentId);
    return agentId;
  }

  hasProjectScope(agentId) {
    return this.#projectScoped.has(agentId);
  }

  #abs(p) {
    return path.resolve(this.#root, p);
  }

  #rel(p) {
    return path.relative(this.#root, p).replaceAll("\\", "/");
  }

  // Allocate a disjoint owned-file set to a worker. Throws on overlap so the
  // orchestrator re-plans slices instead of letting two writers share a file.
  allocate(agentId, files) {
    const resolved = (files ?? []).map((f) => this.#abs(f));
    const protectedPaths = resolved.filter((f) => isControllerOwnedPath(this.#rel(f)));
    if (protectedPaths.length) {
      throw new Error(`owned-file protected path for ${agentId}: ${protectedPaths.join(", ")}`);
    }
    const conflicts = resolved.filter(
      (f) => this.#owner.has(f) && this.#owner.get(f) !== agentId,
    );
    if (conflicts.length) {
      throw new Error(`owned-file conflict for ${agentId}: ${conflicts.join(", ")}`);
    }
    const set = this.#byAgent.get(agentId) ?? new Set();
    for (const f of resolved) {
      set.add(f);
      this.#owner.set(f, agentId);
    }
    this.#byAgent.set(agentId, set);
    return [...set];
  }

  release(agentId) {
    this.#projectScoped.delete(agentId);
    const set = this.#byAgent.get(agentId);
    if (!set) return;
    for (const f of set) this.#owner.delete(f);
    this.#byAgent.delete(agentId);
  }

  // Agent ids currently holding any of the given files (for reclaiming a dead worker's lingering scope).
  ownersOf(files) {
    const owners = new Set();
    for (const f of files ?? []) {
      const owner = this.#owner.get(this.#abs(f));
      if (owner) owners.add(owner);
    }
    return [...owners];
  }

  owns(agentId, file) {
    const abs = this.#abs(file);
    if (this.#byAgent.get(agentId)?.has(abs)) return true;
    if (this.#projectScoped.has(agentId)) {
      const rel = this.#rel(abs);
      // Stay inside the project root and off controller-owned paths; everything else is writable.
      if (!rel.startsWith("..") && !path.isAbsolute(rel) && !isControllerOwnedPath(rel)) return true;
    }
    return false;
  }

  isProtectedWritePath(file) {
    return isControllerOwnedPath(this.#rel(this.#abs(file)));
  }

  snapshot() {
    const agentIds = new Set([...this.#byAgent.keys(), ...this.#projectScoped]);
    return [...agentIds].map((agentId) => ({
      agentId,
      files: [...(this.#byAgent.get(agentId) ?? [])],
      projectScope: this.#projectScoped.has(agentId),
    }));
  }

  restore(entries) {
    for (const { agentId, files, projectScope } of entries ?? []) {
      if (files?.length) this.allocate(agentId, files);
      if (projectScope) this.grantProjectScope(agentId);
    }
  }
}

// Candidate write paths from a tool_call event. Heuristic; confirm field names
// against the real tool schemas during the spike.
export function mutatingPaths(event) {
  if (!PATH_MUTATING_TOOLS.has(toolName(event))) return [];
  const input = event?.input ?? {};
  return PATH_FIELDS.map((field) => input[field]).filter(
    (p) => typeof p === "string" && p.length,
  );
}

export function classifyToolCall(event) {
  const name = toolName(event);
  if (!name) {
    return { decision: "block", reason: "missing tool name on tool_call event" };
  }
  if (READ_ONLY_TOOLS.has(name)) {
    return { decision: "allow" };
  }
  if (OPAQUE_MUTATING_TOOLS.has(name)) {
    return {
      decision: "block",
      reason:
        `opaque mutating tool ${name} is not allowed in single-worktree session workers; ` +
        "return shell/build/format/test work to the orchestrator or use an isolated backend.",
    };
  }
  if (PATH_MUTATING_TOOLS.has(name)) {
    const paths = mutatingPaths(event);
    if (!paths.length) {
      return {
        decision: "block",
        reason: `mutating tool ${name} did not expose a recognized write path`,
      };
    }
    return { decision: "path_check", paths };
  }
  return {
    decision: "block",
    reason: `unrecognized tool ${name}; owned-file guard defaults to deny`,
  };
}

// Per-worker guard. The SDK seam attaches this to each worker session's
// tool_call hook: session.on("tool_call", makeOwnedFileGuard(registry, agentId)).
// Returns a Pi tool_call decision { block, reason } to refuse, or undefined to allow.
export function makeOwnedFileGuard(registry, agentId) {
  return (event) => {
    const classification = classifyToolCall(event);
    if (classification.decision === "allow") return undefined;
    if (classification.decision === "block") {
      return { block: true, reason: `aipi: ${classification.reason}` };
    }

    for (const p of classification.paths) {
      if (registry.isProtectedWritePath?.(p)) {
        return {
          block: true,
          reason: `aipi: ${p} is controller-owned AIPI memory/runtime state; workers must return artifacts to the orchestrator.`,
        };
      }
      if (!registry.owns(agentId, p)) {
        return {
          block: true,
          reason: `aipi: ${agentId} may not write ${p}; outside its owned-file scope. Return the change to the orchestrator.`,
        };
      }
    }
    return undefined;
  };
}

function toolName(event) {
  return event?.name ?? event?.tool_name ?? event?.toolName ?? null;
}

// Wrap a Pi write-style tool definition so it enforces owned-file scope before
// the real write runs. Give each worker ONLY this guarded tool at session
// creation, so it cannot write outside its allocation regardless of host hooks
// (per-worker by closure). Re-verified against Pi 0.79.5 by the real-SDK
// worker-toolset smoke; this is the canonical enforcement mechanism for
// aipi-agent-session workers.
export function wrapWriteToolWithOwnership(toolDef, { registry, agentId, pathField = "path" }) {
  const innerExecute = toolDef.execute;
  return {
    ...toolDef,
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const target = params?.[pathField];
      if (typeof target !== "string" || !target.length) {
        return blockedToolResult(`aipi: write blocked; no ${pathField} on the tool call`);
      }
      if (registry.isProtectedWritePath?.(target)) {
        return blockedToolResult(
          `aipi: ${target} is controller-owned AIPI memory/runtime state; workers must return artifacts to the orchestrator.`,
        );
      }
      if (!registry.owns(agentId, target)) {
        return blockedToolResult(
          `aipi: ${agentId} may not write ${target}; outside its owned-file scope. Return the change to the orchestrator.`,
        );
      }
      return innerExecute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
}

function blockedToolResult(reason) {
  return { content: [{ type: "text", text: reason }], isError: true };
}

export function isControllerOwnedPath(relPath) {
  const normalized = String(relPath ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "");
  // The git directory is never worker-writable, under any scope. Enforced centrally here (not only in the
  // child's private normalizer) so OwnedFileRegistry.owns/isProtectedWritePath, makeOwnedFileGuard, and
  // wrapWriteToolWithOwnership all fail closed for a project-scoped worker. (ADV-62-3)
  if (normalized === ".git" || normalized.startsWith(".git/")) return true;
  if (normalized === MEMORY_PREFIX.slice(0, -1) || normalized.startsWith(MEMORY_PREFIX)) return true;
  if (normalized === RUNTIME_RUNS_PREFIX.slice(0, -1)) return true;
  if (!normalized.startsWith(RUNTIME_RUNS_PREFIX)) return false;
  return !/^\.aipi\/runtime\/runs\/[^/]+\/steps\/[^/]+\/[^/]+$/.test(normalized);
}

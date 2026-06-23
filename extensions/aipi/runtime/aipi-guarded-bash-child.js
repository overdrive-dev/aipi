import path from "node:path";
import { piStreamingUpdate, runGuardedCommand } from "./command-watchdog.js";

// Guarded-shell tool for a forked AIPI worker, the bash analogue of aipi-guarded-write-child.js. A worker
// gets THIS (watchdog-wrapped, project-root-scoped) shell — never a raw `bash`/`user_bash` — so it can run
// the real verification a code task needs (tests, typecheck, build, git) while the watchdog still refuses
// interactive REPL/editor traps and kills stuck/silent commands. This is what lets a worker actually VERIFY
// instead of only documenting — the gap that made hard-gated `verify`/`review` steps escalate.

const PROJECT_ROOT_ENV = "AIPI_SUBAGENTS_PROJECT_ROOT";
const AGENT_ID_ENV = "AIPI_SUBAGENTS_AGENT_ID";

export default function registerAipiGuardedBashChild(pi) {
  pi.registerTool?.({
    name: "aipi_guarded_bash",
    label: "Guarded bash",
    description:
      "Run a non-interactive shell command (tests, typecheck, build, git, etc.) through the AIPI command " +
      "watchdog, from the project root. Refuses interactive REPL/editor traps and kills stuck/silent commands. " +
      "Use this for any shell the task needs — there is no raw bash in this worker.",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        cwd: { type: "string", description: "Relative to the project root; defaults to it." },
        silence_timeout_ms: { type: "number" },
        hard_cap_ms: { type: "number" },
      },
      additionalProperties: false,
    },
    async execute(_id, params = {}, _signal, onUpdate) {
      const projectRoot = path.resolve(process.env[PROJECT_ROOT_ENV] || process.cwd());
      const agentId = process.env[AGENT_ID_ENV] || "aipi-worker";
      const command = String(params.command ?? "").trim();
      if (!command) {
        return { content: [{ type: "text", text: `aipi: ${agentId} guarded_bash requires a command` }], isError: true };
      }
      // Confine cwd to the project root, FAIL-CLOSED on any escape (`..`, absolute) — mirroring the write
      // child's assertInside. (A strip-only regex does NOT neutralize `..`, which would let cwd escape root.)
      let cwd = projectRoot;
      if (params.cwd) {
        const resolved = path.resolve(projectRoot, String(params.cwd));
        const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : `${projectRoot}${path.sep}`;
        if (resolved !== projectRoot && !resolved.startsWith(rootWithSep)) {
          return { content: [{ type: "text", text: `aipi: ${agentId} guarded_bash cwd escapes the project root: ${params.cwd}` }], isError: true };
        }
        cwd = resolved;
      }
      try {
        const result = await runGuardedCommand({
          projectRoot,
          cwd,
          command,
          silenceTimeoutMs: params.silence_timeout_ms,
          hardCapMs: params.hard_cap_ms,
          allowInteractive: false,
          onUpdate: piStreamingUpdate(onUpdate),
        });
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `aipi: guarded_bash failed: ${String(error?.message ?? error)}` }], isError: true };
      }
    },
  });
}

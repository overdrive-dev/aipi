// Reap background subagent runs stuck at `running`/`queued` with NO owning pid.
//
// The vendored stale-run reconciler (loadSubagentRuns -> reconcileAsyncRun) reaps a run only when its recorded
// `pid` is dead (process.kill(pid, 0) -> ESRCH). A status written WITHOUT a pid — older AIPI builds, before the
// pid stamp in writeSubagentRunStatus — is its BLIND SPOT: it lingers as a zombie `running` in /aipi-subagents
// and the widget forever, and the orchestrator can't cancel it (a fresh coordinator has no handle to a run from
// a dead process). AIPI forked background runs execute IN-PROCESS, so at session_start a fresh process owns zero
// live jobs: any pid-less active run is definitionally an orphan from a previous session. Reap it to `abandoned`.
//
// pid'd runs are deliberately left to the reconciler (which the widget's own session_start refresh triggers):
// a run whose pid is the CURRENT live process must not be reaped, and the reconciler already gets that right.

import fs from "node:fs/promises";
import path from "node:path";
import { projectSubagentsRuntimePaths } from "./pi-subagents.js";
import { refreshSubagentWidget } from "./subagent-widget.js";

// Flip every pid-less active run under `asyncDir` to `abandoned`, preserving its other fields. Never throws.
export async function reapPidlessOrphanRuns(asyncDir) {
  let entries;
  try {
    entries = await fs.readdir(asyncDir, { withFileTypes: true });
  } catch {
    return { reaped: 0, ids: [] };
  }
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const statusPath = path.join(asyncDir, entry.name, "status.json");
    let status;
    try {
      status = JSON.parse(await fs.readFile(statusPath, "utf8"));
    } catch {
      continue; // missing / partial / unreadable status — skip
    }
    const active = status?.state === "running" || status?.state === "queued";
    if (!active) continue;
    if (typeof status.pid === "number") continue; // pid'd runs are the reconciler's job (may be the live process)
    status.state = "abandoned";
    status.abandoned_reason =
      "AIPI restarted; a pid-less in-process background run did not survive the previous session.";
    try {
      await fs.writeFile(statusPath, JSON.stringify(status), "utf8");
      ids.push(status.runId ?? entry.name);
    } catch {
      // unwritable status — leave it; a later run may clean it up
    }
  }
  return { reaped: ids.length, ids };
}

export function registerOrphanRunReaper(pi, { projectRootResolver = () => process.cwd() } = {}) {
  pi.on("session_start", async (_event, ctx) => {
    try {
      const root = projectRootResolver(ctx);
      const paths = projectSubagentsRuntimePaths(root);
      const result = await reapPidlessOrphanRuns(paths.asyncDir);
      // Reflect the reap immediately so the widget doesn't show the dead runs on the first frame.
      if (result.reaped > 0) await refreshSubagentWidget(ctx, root);
    } catch {
      /* best-effort — a reap failure must never break session start */
    }
  });
}

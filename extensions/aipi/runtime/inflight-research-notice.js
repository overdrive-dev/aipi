// When the orchestrator ends a turn while async background-research workers are still running, surface a
// concise note so the response does NOT read as final — otherwise the orchestrator answers, looks done, and
// then "revives" out of nowhere when a research job wakes it later with findings.
//
// Foreground workflow/interactive workers are awaited within the turn, so by turn_end the only runs still
// `running`/`queued` are the fire-and-forget background-research jobs (see background-research.js). We read
// the same native run-store the /aipi-subagents widget reads, and emit ONE note per distinct active set
// (deduped by signature): the note re-fires only when the set changes (a job finished, or a new batch was
// dispatched), and resets when nothing is in flight.

import { loadSubagentView, projectSubagentsRuntimePaths } from "./pi-subagents.js";

const INFLIGHT_RESEARCH_CUSTOM_TYPE = "aipi-inflight-research";
const MAX_NAMES = 6;

let cachedLoad = null;
function getLoadSubagentRuns() {
  if (!cachedLoad) cachedLoad = loadSubagentView().loadSubagentRuns;
  return cachedLoad;
}

// Module-level dedupe: the signature (sorted run ids) of the active set we last noted. Reset to null when
// nothing is in flight so the next batch notes again.
let lastNotedSignature = null;

/** Active (running/queued) runs from a run-store snapshot. */
export function inflightResearchRuns(runs) {
  const list = Array.isArray(runs) ? runs : [];
  return list.filter((run) => run.state === "running" || run.state === "queued");
}

/** Human note listing the still-running background workers by role name. */
export function formatInflightNotice(active) {
  const count = active.length;
  const names = active
    .slice(0, MAX_NAMES)
    .map((run) => String(run.id ?? "").split(":")[0])
    .filter(Boolean)
    .join(", ");
  const overflow = count > MAX_NAMES ? `, +${count - MAX_NAMES} more` : "";
  const label = `${count} background research agent${count === 1 ? "" : "s"}`;
  return `⏳ ${label} still running${names ? ` (${names}${overflow})` : ""}. This response isn't final — I'll surface their reviewed findings when they finish.`;
}

// Pure decision: given a run-store snapshot and the last-noted signature, return the new signature to store
// and the note to emit (or null when nothing changed / nothing is active). Kept pure for unit testing.
export function computeInflightNotice(runs, { lastSignature = null } = {}) {
  const active = inflightResearchRuns(runs);
  if (!active.length) return { signature: null, notice: null };
  const signature = active.map((run) => String(run.id ?? "")).sort().join("|");
  if (signature === lastSignature) return { signature, notice: null };
  return { signature, notice: formatInflightNotice(active) };
}

// Read the live run-store and emit the note when the active set changed. Never throws.
export async function refreshInflightResearchNotice(ctx, pi, projectRoot) {
  const sendMessage = typeof pi?.sendMessage === "function" ? pi.sendMessage.bind(pi) : null;
  if (!sendMessage) return;
  try {
    const paths = projectSubagentsRuntimePaths(projectRoot);
    const runs = getLoadSubagentRuns()(paths.asyncDir, paths.resultsDir);
    const { signature, notice } = computeInflightNotice(runs, { lastSignature: lastNotedSignature });
    lastNotedSignature = signature;
    if (!notice) return;
    sendMessage(
      { customType: INFLIGHT_RESEARCH_CUSTOM_TYPE, content: notice, display: true },
      { triggerTurn: false },
    );
  } catch {
    /* best-effort — a run-store read error just skips the note */
  }
}

// Reset the dedupe state (test seam; also lets a fresh session start clean).
export function resetInflightResearchNotice() {
  lastNotedSignature = null;
}

export function registerInflightResearchNotice(pi, { projectRootResolver = () => process.cwd() } = {}) {
  pi.on("session_start", () => resetInflightResearchNotice());
  pi.on("turn_end", async (_event, ctx) => {
    await refreshInflightResearchNotice(ctx, pi, projectRootResolver(ctx));
  });
}

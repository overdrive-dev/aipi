// Probe A' - in-process owned-file enforcement via tool wrapping.
//
// Probe A asked "can the HOST extension observe/attribute child tool_call
// events?" and got FAIL. But host attribution was never the design's mechanism.
// The owned-file guard only needs each worker to hold a WRITE TOOL that checks
// ownership before writing. Pi's SDK exports the primitives for exactly this:
// createWriteToolDefinition / defineTool / wrapRegisteredTool. A worker given a
// wrapped write tool cannot write outside its allocation regardless of hooks,
// per-worker by closure, with no attribution problem.
//
// This probe is fully runnable WITHOUT an LLM: it calls the guarded write tool's
// execute directly. See adversarial-claude.md Round 10 (R10-1).

import fs from "node:fs/promises";
import path from "node:path";
import { OwnedFileRegistry, wrapWriteToolWithOwnership } from "./owned-files.js";
import { loadPiSdk } from "./probe-a.js";

// wrapWriteToolWithOwnership is the canonical enforcement primitive (owned-files.js).
export { wrapWriteToolWithOwnership };

const PROBE_NAME = "tool-ownership";

// Pure: verdict from the demonstration observations.
export function classifyInProcessEnforcement(obs = {}) {
  const { hasWriteToolFactory, blockedOutOfScope, innerSkippedOnBlock, allowedInScope } = obs;
  const viable = Boolean(hasWriteToolFactory && blockedOutOfScope && innerSkippedOnBlock && allowedInScope);
  return {
    verdict: viable ? "IN_PROCESS_VIABLE" : "IN_PROCESS_NOT_VIABLE",
    summary: viable
      ? "A per-worker guarded write tool blocked an out-of-scope write before execution and allowed an in-scope write. In-process aipi-agent-session can enforce owned files via tool wrapping, without host attribution."
      : "Tool-level write enforcement could not be demonstrated in-process.",
    nextAction: viable
      ? "Keep the forked pi_subagents runtime as the single worker backend and preserve AIPI owned-file allocation around spawned workers."
      : "Do not enable write-capable workers until tool-level enforcement or a stronger external boundary is proven.",
    hasWriteToolFactory: Boolean(hasWriteToolFactory),
    blockedOutOfScope: Boolean(blockedOutOfScope),
    innerSkippedOnBlock: Boolean(innerSkippedOnBlock),
    allowedInScope: Boolean(allowedInScope),
  };
}

// Run the real demonstration against the Pi SDK write tool. No LLM call.
export async function runProbeAPrime({ sdk, projectRoot } = {}) {
  const resolvedSdk = sdk ?? (await loadPiSdk());
  const hasWriteToolFactory =
    typeof resolvedSdk.createWriteToolDefinition === "function" ||
    typeof resolvedSdk.createWriteTool === "function";
  if (!hasWriteToolFactory) {
    return classifyInProcessEnforcement({ hasWriteToolFactory: false });
  }

  const root = path.resolve(projectRoot);
  const dir = path.join(root, ".aipi", "runtime", "probes", PROBE_NAME);
  await fs.mkdir(dir, { recursive: true });
  const ownedAbs = path.join(dir, "owned.txt");
  const foreignAbs = path.join(dir, "foreign.txt");
  await fs.rm(ownedAbs, { force: true }).catch(() => {});
  await fs.rm(foreignAbs, { force: true }).catch(() => {});

  const registry = new OwnedFileRegistry(root);
  registry.allocate("worker-a", [path.relative(root, ownedAbs)]);

  const def = resolvedSdk.createWriteToolDefinition
    ? resolvedSdk.createWriteToolDefinition()
    : resolvedSdk.createWriteTool();
  const guarded = wrapWriteToolWithOwnership(def, { registry, agentId: "worker-a" });

  const blocked = await guarded.execute("probe-block", { path: foreignAbs, content: "X" }, undefined, () => {}, { cwd: root });
  const blockedOutOfScope = Boolean(blocked?.isError);
  const innerSkippedOnBlock = !(await pathExists(foreignAbs));

  await guarded.execute("probe-allow", { path: ownedAbs, content: "AIPI_PROBE_A_PRIME_OK" }, undefined, () => {}, { cwd: root });
  const allowedInScope = await pathExists(ownedAbs);

  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  return classifyInProcessEnforcement({
    hasWriteToolFactory,
    blockedOutOfScope,
    innerSkippedOnBlock,
    allowedInScope,
  });
}

export function formatProbeAPrimeResult(result) {
  return [
    `Probe A' ${result.verdict}: ${result.summary}`,
    `write_tool_factory=${result.hasWriteToolFactory} blocked_out_of_scope=${result.blockedOutOfScope} ` +
      `inner_skipped_on_block=${result.innerSkippedOnBlock} allowed_in_scope=${result.allowedInScope}`,
    `next=${result.nextAction}`,
  ].join("\n");
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

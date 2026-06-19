import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SubagentCoordinator } from "../extensions/aipi/runtime/subagents.js";

if (process.env.AIPI_LIVE_SMOKE !== "1") {
  console.log("AIPI_LIVE_SUBAGENT_SMOKE_SKIPPED set AIPI_LIVE_SMOKE=1 to run a credentialed worker");
  process.exit(0);
}

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-live-subagent-"));
const targetRelPath = path.join("src", "live-smoke.txt").replaceAll("\\", "/");
const expectedContent = "AIPI_LIVE_SMOKE_OK";
const outputPath = process.env.AIPI_LIVE_SMOKE_OUTPUT
  ? path.resolve(process.env.AIPI_LIVE_SMOKE_OUTPUT)
  : path.join(process.cwd(), ".aipi", "runtime", "smoke", "live-subagent-result.json");

try {
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  const hostModel = process.env.AIPI_LIVE_SMOKE_MODEL
    ? parseSmokeModel(process.env.AIPI_LIVE_SMOKE_MODEL)
    : null;
  const coordinator = new SubagentCoordinator(null, {
    root: tempRoot,
    maxConcurrent: 1,
    hostModel,
  });

  const { agent_id: agentId } = coordinator.spawn({
    agent_id: "implementer",
    model_class: "code-strong",
    step_id: "live_subagent_smoke",
    owned_files: [targetRelPath],
    context_packet: [
      "Live smoke task:",
      `1. Use the write tool to write exactly ${expectedContent} to ${targetRelPath}.`,
      "2. Return PASS only after the write tool succeeds.",
      "3. Return only the required JSON shape.",
    ].join("\n"),
    artifact_target: ".aipi/runtime/smoke/live-subagent",
  });

  await waitFor(() => ["done", "failed", "cancelled"].includes(coordinator.status(agentId).state), {
    timeoutMs: Number(process.env.AIPI_LIVE_SMOKE_TIMEOUT_MS ?? 180000),
  });

  const status = coordinator.status(agentId);
  assert.equal(status.state, "done", `live worker ended in ${status.state}: ${status.error ?? "no error"}`);

  const collect = coordinator.collect(agentId);
  assert.equal(collect.ready, true);
  assert.equal(collect.step_result?.schema, "aipi.step-result.v1");
  assert.equal(collect.step_result?.verdict, "PASS");
  assert.equal(await fs.readFile(path.join(tempRoot, targetRelPath), "utf8"), expectedContent);

  await writeSmokeReport(outputPath, {
    schema: "aipi.live-subagent-smoke.v1",
    verdict: "PASS",
    generated_at: new Date().toISOString(),
    agent_id: agentId,
    host_model: hostModel,
    file: targetRelPath,
    expected_content: expectedContent,
    step_result: collect.step_result,
  });

  console.log(`AIPI_LIVE_SUBAGENT_SMOKE_OK agent=${agentId} file=${targetRelPath} output=${outputPath}`);
} catch (error) {
  await writeSmokeReport(outputPath, {
    schema: "aipi.live-subagent-smoke.v1",
    verdict: "FAIL",
    generated_at: new Date().toISOString(),
    error: String(error?.message ?? error),
  }).catch(() => {});
  throw error;
} finally {
  if (process.env.AIPI_KEEP_LIVE_SMOKE !== "1") {
    await fs.rm(tempRoot, { recursive: true, force: true });
  } else {
    console.log(`AIPI_LIVE_SUBAGENT_SMOKE_KEPT root=${tempRoot}`);
  }
}

async function waitFor(predicate, { timeoutMs }) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for live subagent`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function writeSmokeReport(filePath, report) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseSmokeModel(value) {
  const trimmed = String(value ?? "").trim();
  const match = trimmed.match(/^([^/]+)\/(.+)$/);
  if (!match) return trimmed || null;
  return { provider: match[1], id: match[2] };
}

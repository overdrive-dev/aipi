// Shared fixture for memory-subsystem tests: a temp project, a deterministic epoch clock, a recording fake git
// (so RC5 commits are observable without a real repo), and a helper to mint an approval artifact. The whole
// durable-memory pipeline is deterministic by design (no model on the write/detect path), so the only fakes a
// lifecycle test needs are the clock and git.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";

export function makeClock(startIso = "2026-06-30T00:00:00.000Z") {
  const base = Date.parse(startIso);
  let tick = 0;
  return () => new Date(base + (tick++) * 1000);
}

// A git runner shaped like spawnSync's return, recording every call so a test can assert what was committed.
export function makeFakeGit() {
  const calls = [];
  const git = (root, args) => {
    calls.push({ root, args });
    if (args[0] === "rev-parse" && args.includes("--is-inside-work-tree")) return { status: 0, stdout: "true\n", stderr: "" };
    if (args[0] === "add") return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "commit") return { status: 0, stdout: "[fake 0000000] aipi(memory)\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  git.calls = calls;
  git.commits = () => calls.filter((c) => c.args[0] === "commit");
  return git;
}

export async function createMemoryFixture({ start } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-memory-life-"));
  const sourceRoot = path.resolve("templates/.aipi");
  await initProject({ sourceRoot, targetRoot: root });
  return {
    root,
    now: makeClock(start),
    git: makeFakeGit(),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export async function mintApproval(root, id, source = "human-test") {
  const rel = path.posix.join(".aipi", "runtime", "approvals", "approved", `${id}.json`);
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(
    path.join(root, rel),
    `${JSON.stringify({ schema: "aipi.memory-promotion-approval.v1", decision: "APPROVED", source })}\n`,
  );
  return rel;
}

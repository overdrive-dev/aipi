import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendRotatedJsonlLine, resolveRuntimeLogCaps } from "../extensions/aipi/runtime/runtime-log.js";

let caseIndex = 0;
async function withTempDir(name, fn) {
  caseIndex += 1;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `aipi-runtime-log-${caseIndex}-`));
  try {
    await fn(dir);
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function listDir(dir) {
  return (await fs.readdir(dir)).sort();
}

await withTempDir("first write creates the file and parent dirs", async (dir) => {
  const logPath = path.join(dir, "nested", "runtime", "events.jsonl");
  await appendRotatedJsonlLine(logPath, { n: 1 }, { env: {} });
  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { n: 1 });
});

await withTempDir("appends below the cap stay in one file", async (dir) => {
  const logPath = path.join(dir, "events.jsonl");
  for (let n = 0; n < 5; n += 1) {
    await appendRotatedJsonlLine(logPath, { n }, { maxBytes: 10_000, env: {} });
  }
  assert.deepEqual(await listDir(dir), ["events.jsonl"]);
  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 5);
});

await withTempDir("crossing the cap rotates to .1 and keeps the newest entry live", async (dir) => {
  const logPath = path.join(dir, "events.jsonl");
  const bigValue = "x".repeat(120);
  await appendRotatedJsonlLine(logPath, { n: 0, pad: bigValue }, { maxBytes: 200, env: {} });
  await appendRotatedJsonlLine(logPath, { n: 1, pad: bigValue }, { maxBytes: 200, env: {} });
  assert.deepEqual(await listDir(dir), ["events.jsonl", "events.jsonl.1"]);
  const live = (await fs.readFile(logPath, "utf8")).trim();
  assert.equal(JSON.parse(live).n, 1);
  const archived = (await fs.readFile(`${logPath}.1`, "utf8")).trim();
  assert.equal(JSON.parse(archived).n, 0);
});

await withTempDir("generation shift drops the oldest at maxGenerations", async (dir) => {
  const logPath = path.join(dir, "events.jsonl");
  const pad = "y".repeat(120);
  for (let n = 0; n < 5; n += 1) {
    await appendRotatedJsonlLine(logPath, { n, pad }, { maxBytes: 200, maxGenerations: 2, env: {} });
  }
  assert.deepEqual(await listDir(dir), ["events.jsonl", "events.jsonl.1", "events.jsonl.2"]);
  const live = JSON.parse((await fs.readFile(logPath, "utf8")).trim());
  const gen1 = JSON.parse((await fs.readFile(`${logPath}.1`, "utf8")).trim());
  const gen2 = JSON.parse((await fs.readFile(`${logPath}.2`, "utf8")).trim());
  assert.equal(live.n, 4);
  assert.equal(gen1.n, 3);
  assert.equal(gen2.n, 2);
});

await withTempDir("maxBytes=0 via env disables rotation entirely", async (dir) => {
  const logPath = path.join(dir, "events.jsonl");
  const pad = "z".repeat(300);
  for (let n = 0; n < 4; n += 1) {
    await appendRotatedJsonlLine(logPath, { n, pad }, { env: { AIPI_RUNTIME_LOG_MAX_BYTES: "0" } });
  }
  assert.deepEqual(await listDir(dir), ["events.jsonl"]);
  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 4);
});

await withTempDir("env caps are read when opts are absent", async (dir) => {
  const logPath = path.join(dir, "events.jsonl");
  const pad = "w".repeat(120);
  const env = { AIPI_RUNTIME_LOG_MAX_BYTES: "200", AIPI_RUNTIME_LOG_MAX_GENERATIONS: "1" };
  for (let n = 0; n < 4; n += 1) {
    await appendRotatedJsonlLine(logPath, { n, pad }, { env });
  }
  assert.deepEqual(await listDir(dir), ["events.jsonl", "events.jsonl.1"]);
});

await withTempDir("rename failure still lands the append", async (dir) => {
  const logPath = path.join(dir, "events.jsonl");
  const pad = "v".repeat(120);
  await appendRotatedJsonlLine(logPath, { n: 0, pad }, { maxBytes: 200, env: {} });
  const failingFs = {
    mkdir: fs.mkdir.bind(fs),
    stat: fs.stat.bind(fs),
    rm: fs.rm.bind(fs),
    appendFile: fs.appendFile.bind(fs),
    rename: async () => {
      throw new Error("EPERM simulated (OneDrive lock)");
    },
  };
  await appendRotatedJsonlLine(logPath, { n: 1, pad }, { maxBytes: 200, env: {}, fsImpl: failingFs });
  const lines = (await fs.readFile(logPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2, "the event must never be dropped by a rotation failure");
});

{
  const caps = resolveRuntimeLogCaps({ env: {} });
  assert.equal(caps.maxBytes, 5 * 1024 * 1024);
  assert.equal(caps.maxGenerations, 2);
  const garbage = resolveRuntimeLogCaps({ env: { AIPI_RUNTIME_LOG_MAX_BYTES: "not-a-number", AIPI_RUNTIME_LOG_MAX_GENERATIONS: "-3" } });
  assert.equal(garbage.maxBytes, 5 * 1024 * 1024);
  assert.equal(garbage.maxGenerations, 2);
  console.log("ok - cap resolution defaults and garbage handling");
}

console.log("test-runtime-log: all assertions passed");

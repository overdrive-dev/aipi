import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  mergePiModels,
  seedPiModels,
  formatPiModelsSeedResult,
  piModelsAgentDir,
} from "../extensions/aipi/runtime/pi-models-seed.js";

// --- mergePiModels: seeds every curated model into an empty registry ---
{
  const { models, changes } = mergePiModels({});
  assert.equal(changes.every((change) => change.action === "added"), true);
  const sol = models.providers["openai-codex"].models.find((model) => model.id === "gpt-5.6-sol");
  assert.equal(sol.contextWindow, 353000);
  assert.equal(sol.maxTokens, 128000);
  const grok = models.providers["xai-auth"].models.find((model) => model.id === "grok-4.5");
  assert.equal(grok.contextWindow, 500000);
  assert.equal(grok.maxTokens, 30000);
  const sonnet = models.providers.anthropic.models.find((model) => model.id === "claude-sonnet-5");
  assert.equal(sonnet.contextWindow, 1000000);
  assert.equal(sonnet.maxTokens, 128000);
}

// --- mergePiModels: fills a missing contextWindow on an existing entry, preserving its other fields ---
{
  const existing = {
    providers: {
      "openai-codex": { models: [{ id: "gpt-5.6-sol", reasoning: true }, { id: "gpt-5.6", reasoning: true }] },
      anthropic: { models: [{ id: "claude-sonnet-5", reasoning: true }] },
    },
  };
  const { models, changes } = mergePiModels(existing);
  const sol = models.providers["openai-codex"].models.find((model) => model.id === "gpt-5.6-sol");
  assert.equal(sol.contextWindow, 353000);
  assert.equal(sol.maxTokens, 128000);
  assert.equal(sol.reasoning, true, "existing reasoning flag preserved");
  assert.equal(changes.find((change) => change.id === "gpt-5.6-sol").action, "filled");
  // xai-auth provider was absent entirely -> added
  assert.equal(changes.find((change) => change.id === "grok-4.5").action, "added");
}

// --- mergePiModels: never overwrites a user's explicit contextWindow, but still fills a missing sibling field ---
{
  const existing = {
    providers: { "openai-codex": { models: [{ id: "gpt-5.6-sol", contextWindow: 999999, reasoning: true }] } },
  };
  const { models, changes } = mergePiModels(existing);
  const sol = models.providers["openai-codex"].models.find((model) => model.id === "gpt-5.6-sol");
  assert.equal(sol.contextWindow, 999999, "user contextWindow untouched");
  assert.equal(sol.maxTokens, 128000, "missing maxTokens still filled");
  assert.equal(changes.find((change) => change.id === "gpt-5.6-sol").fields.includes("contextWindow"), false);
}

// --- seedPiModels: writes on a fresh agent dir and is idempotent on a second run ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-seed-"));
  const first = await seedPiModels({ agentDir: dir });
  assert.equal(first.ok, true);
  assert.equal(first.wrote, true);
  assert.equal(first.created, true);
  const written = JSON.parse(await fs.readFile(path.join(dir, "models.json"), "utf8"));
  assert.equal(written.providers["xai-auth"].models[0].contextWindow, 500000);

  const second = await seedPiModels({ agentDir: dir });
  assert.equal(second.pending, false, "second run has nothing pending");
  assert.equal(second.wrote, false, "idempotent: nothing written on second run");
}

// --- seedPiModels: dryRun reports pending changes but writes nothing ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-seed-dry-"));
  const result = await seedPiModels({ agentDir: dir, dryRun: true });
  assert.equal(result.pending, true);
  assert.equal(result.wrote, false);
  await assert.rejects(fs.readFile(path.join(dir, "models.json"), "utf8"), /ENOENT/);
  assert.match(formatPiModelsSeedResult(result), /aipi setup --fix/);
}

// --- seedPiModels: preserves an unrelated pre-existing model alongside the seeded one ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-seed-keep-"));
  await fs.writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({ providers: { anthropic: { models: [{ id: "claude-opus-4-8", reasoning: true }] } } }),
    "utf8",
  );
  await seedPiModels({ agentDir: dir });
  const written = JSON.parse(await fs.readFile(path.join(dir, "models.json"), "utf8"));
  assert.equal(written.providers.anthropic.models.some((model) => model.id === "claude-opus-4-8"), true);
  assert.equal(written.providers.anthropic.models.some((model) => model.id === "claude-sonnet-5"), true);
}

// --- piModelsAgentDir honors PI_CODING_AGENT_DIR ---
{
  assert.equal(
    piModelsAgentDir({ PI_CODING_AGENT_DIR: path.join("C:", "custom", "agent") }),
    path.resolve(path.join("C:", "custom", "agent")),
  );
}

console.log("pi-models-seed: ok");

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
  const sonnet = models.providers.anthropic.models.find((model) => model.id === "claude-sonnet-5");
  assert.equal(sonnet.contextWindow, 1000000);
  assert.equal(changes.find((change) => change.id === "gpt-5.6-sol").action, "filled");
}

// --- REGRESSION: a seed model whose provider is NOT already declared is SKIPPED, never adding a bare
//     provider bucket. (Adding an xai-auth bucket broke Pi: that OAuth provider requires a baseUrl.) ---
{
  const existing = { providers: { "openai-codex": { models: [{ id: "gpt-5.6-sol", reasoning: true }] } } };
  const { models, changes } = mergePiModels(existing, [
    { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 353000, maxTokens: 128000, reasoning: true },
    { provider: "xai-auth", id: "grok-4.5", contextWindow: 500000, maxTokens: 30000, reasoning: true },
  ]);
  assert.equal(models.providers["xai-auth"], undefined, "must NOT create the absent xai-auth provider bucket");
  assert.equal(changes.find((change) => change.id === "grok-4.5").action, "skipped_absent_provider");
  assert.equal(models.providers["openai-codex"].models[0].contextWindow, 353000, "present provider still filled");
}

// --- the curated grok-4.5 is not even in the default seed (it is served by the xai-oauth extension) ---
{
  const { changes } = mergePiModels({ providers: { anthropic: { models: [{ id: "claude-sonnet-5" }] } } });
  assert.equal(changes.some((change) => change.id === "grok-4.5"), false, "grok-4.5 dropped from the default seed");
}

// --- mergePiModels: adds a missing curated model to an EXISTING provider bucket ---
{
  const existing = { providers: { anthropic: { models: [{ id: "claude-opus-4-8", reasoning: true }] } } };
  const { models, changes } = mergePiModels(existing);
  assert.equal(models.providers.anthropic.models.some((model) => model.id === "claude-opus-4-8"), true, "pre-existing model preserved");
  const sonnet = models.providers.anthropic.models.find((model) => model.id === "claude-sonnet-5");
  assert.ok(sonnet, "claude-sonnet-5 added to the existing anthropic bucket");
  assert.equal(sonnet.contextWindow, 1000000);
  assert.equal(changes.find((change) => change.id === "claude-sonnet-5").action, "added");
}

// --- mergePiModels: never overwrites a user's explicit contextWindow, but still fills a missing sibling ---
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

// --- seedPiModels: writes under existing providers, idempotent, never invents xai-auth ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-seed-"));
  await fs.writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({
      providers: {
        "openai-codex": { models: [{ id: "gpt-5.6-sol", reasoning: true }] },
        anthropic: { models: [{ id: "claude-sonnet-5", reasoning: true }] },
      },
    }),
    "utf8",
  );
  const first = await seedPiModels({ agentDir: dir });
  assert.equal(first.ok, true);
  assert.equal(first.wrote, true);
  const written = JSON.parse(await fs.readFile(path.join(dir, "models.json"), "utf8"));
  assert.equal(written.providers["openai-codex"].models[0].contextWindow, 353000);
  assert.equal(written.providers.anthropic.models[0].contextWindow, 1000000);
  assert.equal(written.providers["xai-auth"], undefined, "seed never adds the xai-auth provider");

  const second = await seedPiModels({ agentDir: dir });
  assert.equal(second.pending, false, "second run has nothing pending");
  assert.equal(second.wrote, false, "idempotent: nothing written on second run");
}

// --- seedPiModels: an absent models.json is left untouched (no declared providers -> nothing to seed) ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-seed-empty-"));
  const result = await seedPiModels({ agentDir: dir });
  assert.equal(result.ok, true);
  assert.equal(result.pending, false, "nothing to seed when no provider is declared");
  assert.equal(result.wrote, false);
  await assert.rejects(fs.readFile(path.join(dir, "models.json"), "utf8"), /ENOENT/, "never creates a models.json from nothing");
}

// --- seedPiModels: dryRun reports pending changes but writes nothing ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-seed-dry-"));
  await fs.writeFile(
    path.join(dir, "models.json"),
    JSON.stringify({ providers: { "openai-codex": { models: [{ id: "gpt-5.6-sol", reasoning: true }] } } }),
    "utf8",
  );
  const result = await seedPiModels({ agentDir: dir, dryRun: true });
  assert.equal(result.pending, true);
  assert.equal(result.wrote, false);
  const onDisk = JSON.parse(await fs.readFile(path.join(dir, "models.json"), "utf8"));
  assert.equal(onDisk.providers["openai-codex"].models[0].contextWindow, undefined, "dry run did not write");
  assert.match(formatPiModelsSeedResult(result), /aipi setup --fix/);
}

// --- piModelsAgentDir honors PI_CODING_AGENT_DIR ---
{
  assert.equal(
    piModelsAgentDir({ PI_CODING_AGENT_DIR: path.join("C:", "custom", "agent") }),
    path.resolve(path.join("C:", "custom", "agent")),
  );
}

console.log("pi-models-seed: ok");

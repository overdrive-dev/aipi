import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Curated context-window / max-output definitions for the custom (non-Pi-builtin) models AIPI's
// cross-family topology commonly references. Pi's model registry defaults ANY custom model that
// lacks a declared contextWindow to 128000 (node_modules/@earendil-works/pi-coding-agent/dist/core/
// model-registry.js) — so gpt-5.6-sol, grok-4.5, and claude-sonnet-5 all silently cap at 128k unless
// ~/.pi/agent/models.json declares the real window. Seeding these lets a fresh AIPI workstation
// resolve the correct context window without hand-editing models.json.
//
// Values (verified 2026-07-12):
//   openai-codex/gpt-5.6-sol, gpt-5.6 — 1.05M full API, but the openai-codex (Codex OAuth) backend is
//     catalog-capped at ~353,400 effective input (openai/codex#31860); use 353000 / 128000 output.
//   xai-auth/grok-4.5 — 500K context / 30K output.
//   anthropic/claude-sonnet-5 — 1M context / 128K output (launched 2026-06-30).
export const AIPI_SEEDED_PI_MODELS = [
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 353000, maxTokens: 128000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.6", contextWindow: 353000, maxTokens: 128000, reasoning: true },
  { provider: "xai-auth", id: "grok-4.5", contextWindow: 500000, maxTokens: 30000, reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-5", contextWindow: 1000000, maxTokens: 128000, reasoning: true },
];

// Only these fields are ever back-filled onto an existing entry — never touch a user's model id,
// reasoning flag, or any other field they set.
const SEEDED_FIELDS = ["contextWindow", "maxTokens"];

// The Pi agent dir that holds models.json. Honors the same env overrides Pi (and models-command) use.
export function piModelsAgentDir(env = process.env, homeDir = os.homedir()) {
  const override = env.PI_CODING_AGENT_DIR?.trim() || env.PI_AGENT_DIR?.trim();
  return override ? path.resolve(override.replace(/^~(?=$|[/\\])/, homeDir)) : path.join(homeDir, ".pi", "agent");
}

// Pure merge: fold the curated defs into an existing Pi models.json object WITHOUT clobbering user choices.
// - Missing provider bucket / model entry -> add the full curated def.
// - Existing model entry -> only FILL a missing contextWindow/maxTokens (never overwrite a user-set value).
// Returns { models, changes: [{ provider, id, action, fields }] } where action is "added" | "filled" | "unchanged".
export function mergePiModels(existing, seed = AIPI_SEEDED_PI_MODELS) {
  const models = existing && typeof existing === "object" ? structuredClone(existing) : {};
  if (!models.providers || typeof models.providers !== "object") models.providers = {};
  const changes = [];
  for (const def of seed) {
    const { provider, id, ...fields } = def;
    if (!provider || !id) continue;
    let bucket = models.providers[provider];
    if (!bucket || typeof bucket !== "object") {
      bucket = { models: [] };
      models.providers[provider] = bucket;
    }
    if (!Array.isArray(bucket.models)) bucket.models = [];
    const entry = bucket.models.find((model) => model && model.id === id);
    if (!entry) {
      bucket.models.push({ id, ...fields });
      changes.push({ provider, id, action: "added", fields: Object.keys(fields) });
      continue;
    }
    const filled = [];
    for (const key of SEEDED_FIELDS) {
      if (entry[key] == null && fields[key] != null) {
        entry[key] = fields[key];
        filled.push(key);
      }
    }
    changes.push({ provider, id, action: filled.length ? "filled" : "unchanged", fields: filled });
  }
  return { models, changes };
}

// Read ~/.pi/agent/models.json, merge the curated defs, and (unless dryRun) write it back only when
// something changed. Best-effort and idempotent: a second run reports every model "unchanged" and
// writes nothing. dryRun computes the same report without touching disk (used by plain `aipi setup`;
// `aipi setup --fix` applies it).
export async function seedPiModels({
  agentDir = null,
  env = process.env,
  homeDir = os.homedir(),
  seed = AIPI_SEEDED_PI_MODELS,
  dryRun = false,
  readFile = (file) => fs.readFile(file, "utf8"),
  writeFile = (file, data) => fs.writeFile(file, data, "utf8"),
  mkdir = (dir) => fs.mkdir(dir, { recursive: true }),
} = {}) {
  const dir = agentDir ?? piModelsAgentDir(env, homeDir);
  const file = path.join(dir, "models.json");
  let existing = {};
  let existed = true;
  try {
    const parsed = JSON.parse(await readFile(file));
    if (parsed && typeof parsed === "object") existing = parsed;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { ok: false, path: file, error: String(error?.message ?? error), dryRun, wrote: false, added: [], filled: [], changes: [] };
    }
    existed = false;
  }
  const { models, changes } = mergePiModels(existing, seed);
  const pending = changes.some((change) => change.action !== "unchanged");
  const wrote = pending && !dryRun;
  if (wrote) {
    await mkdir(dir);
    await writeFile(file, `${JSON.stringify(models, null, 2)}\n`);
  }
  return {
    ok: true,
    path: file,
    dryRun,
    existed,
    created: !existed && wrote,
    pending,
    wrote,
    added: changes.filter((change) => change.action === "added").map((change) => `${change.provider}/${change.id}`),
    filled: changes.filter((change) => change.action === "filled").map((change) => `${change.provider}/${change.id}`),
    changes,
  };
}

// One human-readable line for the setup report.
export function formatPiModelsSeedResult(result) {
  if (!result?.ok) return `model context-windows: skipped (${result?.error ?? "unavailable"})`;
  const targets = [...result.added, ...result.filled];
  if (!result.pending) return `model context-windows: already correct (${result.path})`;
  const verb = result.dryRun ? "would set" : "set";
  const suffix = result.dryRun ? " — run `aipi setup --fix` to apply" : "";
  return `model context-windows: ${verb} for ${targets.join(", ")}${suffix} (${result.path})`;
}

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Curated context-window / max-output definitions for the custom models users add to
// ~/.pi/agent/models.json under a BUILT-IN provider (anthropic, openai-codex). Pi's model registry
// defaults ANY custom model that lacks a declared contextWindow to 128000 (node_modules/
// @earendil-works/pi-coding-agent/dist/core/model-registry.js) — so gpt-5.6-sol and claude-sonnet-5
// silently cap at 128k unless models.json declares the real window. Seeding fills those windows.
//
// NOT included: grok-4.5. It is served by the vendored xai-oauth PROVIDER EXTENSION (provider
// xai-auth), not by a models.json custom-model entry. Defining an xai-auth custom model in models.json
// requires a provider-level "baseUrl" and makes Pi reject the whole file — see mergePiModels, which
// also refuses to create any provider bucket that isn't already present. If grok-4.5 ever needs a
// context-window fix, it belongs in the xai-oauth extension's MODELS registration, not here.
//
// Values (verified 2026-07-12):
//   openai-codex/gpt-5.6-sol, gpt-5.6 — 1.05M full API, but the openai-codex (Codex OAuth) backend is
//     catalog-capped at ~353,400 effective input (openai/codex#31860); use 353000 / 128000 output.
//   anthropic/claude-sonnet-5 — 1M context / 128K output (launched 2026-06-30).
export const AIPI_SEEDED_PI_MODELS = [
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 353000, maxTokens: 128000, reasoning: true },
  { provider: "openai-codex", id: "gpt-5.6", contextWindow: 353000, maxTokens: 128000, reasoning: true },
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
// - Provider bucket ABSENT -> SKIP the model (never create a provider bucket: a provider not already
//   declared may require provider-level config we can't supply, e.g. the xai-auth OAuth provider needs a
//   baseUrl, and a bare bucket makes Pi reject the whole models.json).
// - Provider present, model entry missing -> add the full curated def to that existing bucket.
// - Existing model entry -> only FILL a missing contextWindow/maxTokens (never overwrite a user-set value).
// Returns { models, changes: [{ provider, id, action, fields }] } with action
// "added" | "filled" | "unchanged" | "skipped_absent_provider".
export function mergePiModels(existing, seed = AIPI_SEEDED_PI_MODELS) {
  const models = existing && typeof existing === "object" ? structuredClone(existing) : {};
  if (!models.providers || typeof models.providers !== "object") models.providers = {};
  const changes = [];
  for (const def of seed) {
    const { provider, id, ...fields } = def;
    if (!provider || !id) continue;
    const bucket = models.providers[provider];
    if (!bucket || typeof bucket !== "object") {
      changes.push({ provider, id, action: "skipped_absent_provider", fields: [] });
      continue;
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
  const pending = changes.some((change) => change.action === "added" || change.action === "filled");
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

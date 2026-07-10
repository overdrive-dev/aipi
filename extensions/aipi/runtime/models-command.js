import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  MODEL_CAPABILITIES_REL_PATH,
  describeModel,
  inspectAdversarialFamilyIsolation,
  inspectModelCapabilityFloors,
  parseModelClasses,
  resolveModelClass,
  resolveStepModel,
} from "./model-router.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, "../../..");
const templateModelClassesPath = path.join(packageRoot, "templates", ".aipi", "model-classes.yaml");
const MODEL_CLASSES_REL_PATH = ".aipi/model-classes.yaml";
const PROVIDER_BUDGET_REL_PATH = ".aipi/provider-budget.json";
const VERIFIER_CLASS_ID = "verifier-fast";
const HIGH_FREQUENCY_CLASSES = new Set(["context-fast", "verifier-fast"]);

// The Pi agent dir that holds settings.json (the global default model). Honors the same env overrides Pi uses.
// Inlined so models-command stays self-contained.
function piAgentDir(env = process.env, homeDir = os.homedir()) {
  const override = env.PI_CODING_AGENT_DIR?.trim() || env.PI_AGENT_DIR?.trim();
  return override ? path.resolve(override.replace(/^~(?=$|[/\\])/, homeDir)) : path.join(homeDir, ".pi", "agent");
}

// Tolerant parse of a "provider/model[:level]" spec into a bucket object; null on anything unparseable.
function safeParseSpec(spec) {
  try {
    return spec ? parseProviderModelSpec(spec, "model") : null;
  } catch {
    return null;
  }
}

// Write the ORCHESTRATOR (= Pi's default session model) into ~/.pi/agent/settings.json, MERGING so every other
// setting is preserved. This is Pi's own default-model mechanism, so `aipi effort` setting the orchestrator ==
// setting Pi's defaultProvider / defaultModel / defaultThinkingLevel. Best-effort: never fails the setup.
async function writeOrchestratorDefault(orchestrator, { agentDir = null, env = process.env, homeDir = os.homedir() } = {}) {
  const dir = agentDir ?? piAgentDir(env, homeDir);
  const file = path.join(dir, "settings.json");
  let settings = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {
    settings = {}; // fresh install / unreadable -> create clean
  }
  settings.defaultProvider = orchestrator.provider;
  settings.defaultModel = orchestrator.model;
  if (orchestrator.thinking_level) settings.defaultThinkingLevel = orchestrator.thinking_level;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { path: file, provider: orchestrator.provider, model: orchestrator.model, thinking_level: orchestrator.thinking_level ?? null };
}

// Provider-agnostic 4-bucket model topology. Each bucket binds ONE (model, thinking
// level) pair that fans out across its capability classes. Any provider is allowed per
// bucket; nothing forces Anthropic. The bucket->class map below is the authoritative
// mapping between the user-facing buckets and the internal capability classes.
export const EFFORT_BUCKETS = Object.freeze(["planner", "planner-adversarial", "doer", "doer-adversarial", "mover"]);
export const BUCKET_CLASS_MAP = Object.freeze({
  planner: ["orchestrator-heavy", "planner-heavy", "research-heavy"],
  "planner-adversarial": ["planner-adversarial-heavy"],
  doer: ["code-strong", "test-strong"],
  "doer-adversarial": ["adversarial-heavy", "verifier-fast"],
  mover: ["context-fast"],
});
const BUCKET_LABELS = Object.freeze({
  planner: "Planner (orchestration, planning, research)",
  "planner-adversarial": "Planner-adversarial (contrarian plan review)",
  doer: "Doer (implementation, tests)",
  "doer-adversarial": "Doer-adversarial (contrarian code review, verification)",
  mover: "Mover (retrieval, context packaging)",
});
// One-line explanation of what each bucket DOES, shown in the wizard so the choice is informed. Names the
// capability classes it fills so the user can trace bucket -> classes.
const BUCKET_DESCRIPTIONS = Object.freeze({
  planner: "authors the plan/requirements/BDD and runs research; owns the long-horizon run (fills orchestrator-heavy, planner-heavy, research-heavy)",
  "planner-adversarial": "independently reviews the PLAN — missing goals, contradictions, untested behavior, ambiguities; ideally a different family than the planner (fills planner-adversarial-heavy)",
  doer: "writes the implementation and its tests (fills code-strong, test-strong)",
  "doer-adversarial": "independently reviews the CODE — correctness, security, regression + final acceptance; ideally a different family than the doer (fills adversarial-heavy, verifier-fast)",
  mover: "cheap, high-parallel context work: retrieval, codebase mapping, context packaging, memory summaries — keeps grunt retrieval off the frontier models (fills context-fast)",
});
// Shown once before the orchestrator prompt.
const ORCHESTRATOR_DESCRIPTION = "the DEFAULT session model that drives the interactive run (written to Pi's settings.json)";

export function parseModelsArgs(args = [], { cwd = process.cwd() } = {}) {
  const tokens = Array.isArray(args)
    ? args.map((item) => String(item))
    : String(args).trim().split(/\s+/).filter(Boolean);
  const options = {
    action: "status",
    actionExplicit: false,
    target: cwd,
    json: false,
    interactive: true,
    hostModel: null,
    adversarialModel: null,
    verifierModel: null,
    orchestrator: null,
    models: [],
    buckets: {},
    classBindings: {},
    budgetNotes: {},
  };

  let index = 0;
  if (tokens[0] && !tokens[0].startsWith("-")) {
    const action = tokens[0];
    if (!["setup", "status", "check", "validate", "wizard", "configure"].includes(action)) {
      throw new Error(
        `unknown aipi effort action: ${action} (expected: setup | status | check; run with no arguments to launch the setup wizard)`,
      );
    }
    options.action = action === "validate" ? "check" : action === "wizard" || action === "configure" ? "setup" : action;
    options.actionExplicit = true;
    index = 1;
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-") && ["setup", "status", "check", "validate", "wizard", "configure"].includes(token)) {
      options.action = token === "validate" ? "check" : token === "wizard" || token === "configure" ? "setup" : token;
      options.actionExplicit = true;
      continue;
    }
    if (token === "--json") {
      options.json = true;
      continue;
    }
    if (token === "--target") {
      options.target = resolveOptionPath(nextValue(tokens, ++index, token), cwd);
      continue;
    }
    if (["--planner", "--planner-adversarial", "--doer", "--doer-adversarial", "--mover"].includes(token)) {
      const bucket = token.slice(2);
      options.buckets[bucket] = nextValue(tokens, ++index, token);
      options.action = "setup";
      continue;
    }
    if (token === "--host") {
      // Legacy alias: --host maps the "doer" bucket (implementation/host classes).
      options.hostModel = nextValue(tokens, ++index, token);
      options.action = "setup";
      continue;
    }
    if (token === "--adversarial" || token === "--reviewer") {
      // Legacy alias -> the CODE-review bucket (doer-adversarial). Plan review is the separate
      // --planner-adversarial bucket.
      const value = nextValue(tokens, ++index, token);
      options.adversarialModel = value;
      options.buckets["doer-adversarial"] = value;
      options.action = "setup";
      continue;
    }
    if (token === "--verifier") {
      options.verifierModel = nextValue(tokens, ++index, token);
      options.action = "setup";
      continue;
    }
    if (token === "--orchestrator" || token === "--default") {
      // The orchestrator = the DEFAULT session model (Pi's settings.json defaultModel). Setting it here writes
      // that default and also seeds the doer fallback.
      options.orchestrator = nextValue(tokens, ++index, token);
      options.action = "setup";
      continue;
    }
    if (token === "--model") {
      options.models.push(nextValue(tokens, ++index, token));
      options.action = "setup";
      continue;
    }
    if (token === "--class" || token === "--set-class") {
      const binding = nextValue(tokens, ++index, token);
      const [modelClass, modelSpec] = splitClassBinding(binding);
      options.classBindings[modelClass] = modelSpec;
      options.action = "setup";
      continue;
    }
    if (token === "--budget-note" || token === "--cost-note") {
      const note = nextValue(tokens, ++index, token);
      const [key, value] = splitBudgetNote(note);
      options.budgetNotes[key] = value;
      options.action = "setup";
      continue;
    }
    if (token === "--check" || token === "--validate") {
      options.action = "check";
      continue;
    }
    if (token === "--no-interactive") {
      options.interactive = false;
      continue;
    }
    if (token === "--interactive") {
      options.interactive = true;
      continue;
    }
    throw new Error(`unknown aipi models option: ${token}`);
  }

  options.target = path.resolve(options.target);
  return options;
}

export async function runModelsCommand({
  args = [],
  projectRoot = null,
  cwd = process.cwd(),
  ui = null,
  // The models the host actually has auth for (from ctx.modelRegistry.getAvailable()), as provider/model
  // specs. The wizard offers these for selection so the user picks real, ready-to-use ids instead of typing.
  availableModels = [],
  // { "provider/id": ThinkingLevel[] } from ctx.modelRegistry, so the wizard offers each model only the
  // intelligence levels it actually supports instead of a fixed low|medium|high|xhigh prompt.
  thinkingLevels = {},
  // The current session model (ctx.model — object or "provider/model" string). Used as the doer fallback so a
  // single authed provider configures with zero flags.
  hostModel = null,
  // Where Pi's settings.json lives (default ~/.pi/agent). Injectable for tests.
  agentDir = null,
  env = process.env,
  homeDir = os.homedir(),
  now = () => new Date(),
} = {}) {
  const parsed = parseModelsArgs(args, { cwd: projectRoot ?? cwd });
  const root = path.resolve(projectRoot ?? parsed.target);
  await ensureModelClassesFile(root);

  // `aipi effort` / `/aipi-effort` with NO explicit action launches the interactive setup WIZARD when
  // an interactive UI is available — that is what the command is for (configure the 4 buckets). Status
  // remains available via an explicit `status` action, and non-interactive/JSON callers still default
  // to status (the wizard needs a UI to prompt). Without this, a bare invocation only printed status
  // and never offered the wizard.
  if (parsed.action === "status" && !parsed.actionExplicit && !parsed.json && hasInteractivePromptUi(ui)) {
    parsed.action = "setup";
  }

  let setupWarnings = [];
  let orchestrator = null;
  if (parsed.action === "setup") {
    await fillInteractiveOptions(parsed, { root, ui, availableModels, thinkingLevels });
    // Each bucket maps to ONE (model, thinking level) pair. Legacy --host/--adversarial/
    // --verifier feed the doer/adversarial buckets (and the verifier-fast override below)
    // so old invocations keep working without the new --planner/--mover flags.
    const buckets = resolveBucketSpecs(parsed);

    // Orchestrator = the DEFAULT session model. Explicit when the user passed --orchestrator/--default or picked
    // it in the wizard — that is what gets written to Pi's settings.json. For the DOER fallback we also accept
    // the current authed/host model, so a single-provider machine configures with zero flags.
    const hostSpec = typeof hostModel === "string" ? hostModel : describeModel(hostModel);
    const explicitOrchestrator = safeParseSpec(parsed.orchestrator);
    const doerFallback = explicitOrchestrator ?? safeParseSpec(hostSpec) ?? safeParseSpec(availableModels[0]);

    if (!buckets.doer && doerFallback) buckets.doer = doerFallback;
    if (!buckets.doer) {
      throw new Error("aipi effort setup found no --doer and no authed model to default to; pass --doer <provider/model[:level]> or log in to a provider first");
    }
    if (!buckets.planner) buckets.planner = buckets.doer;
    if (!buckets.mover) buckets.mover = buckets.doer;
    // Each adversarial bucket defaults to a DIFFERENT authed family than the work it reviews (cross-model
    // independence); if no distinct family is authed it reuses the author's model (same family — just warned).
    const distinctFamily = (spec) => availableModels.map(safeParseSpec).find((m) => m && spec && m.provider !== spec.provider);
    if (!buckets["doer-adversarial"]) buckets["doer-adversarial"] = distinctFamily(buckets.doer) ?? buckets.doer;
    if (!buckets["planner-adversarial"]) buckets["planner-adversarial"] = distinctFamily(buckets.planner) ?? buckets.planner;

    // Persist the orchestrator (default session model) ONLY when the user EXPLICITLY chose one — never silently
    // change the session default just because it was borrowed as a doer fallback.
    if (explicitOrchestrator) {
      try {
        orchestrator = await writeOrchestratorDefault(explicitOrchestrator, { agentDir, env, homeDir });
      } catch {
        /* the default-model settings write is best-effort; the class topology still applies */
      }
    }

    // Cross-model independence is a RECOMMENDATION, not a hard requirement. If the adversarial bucket shares a
    // family with the doer/planner, bucketSetupWarnings emits a warning (below) but the user's choice stands —
    // on a machine with a single authed provider you must still be able to configure effort. (Previously this
    // threw and blocked setup entirely; the README always described it as a warning.)
    setupWarnings = bucketSetupWarnings(buckets);

    // Legacy --verifier binds verifier-fast independently of the adversarial bucket.
    const explicitBindings = { ...(parsed.classBindings ?? {}) };
    if (parsed.verifierModel && !explicitBindings[VERIFIER_CLASS_ID]) {
      explicitBindings[VERIFIER_CLASS_ID] = parsed.verifierModel;
    }

    const config = await readModelCapabilities(root);
    const classIds = await readModelClassIds(root);
    applyTopology(config, { buckets, classIds, explicitBindings, now });
    for (const spec of parsed.models) registerModel(config, parseProviderModelSpec(spec, "--model"), { now });
    await writeModelCapabilities(root, config);
    await writeBudgetNotes(root, parsed.budgetNotes, { now });
  }

  return buildModelsReport(root, { action: parsed.action, now, extraWarnings: setupWarnings, orchestrator });
}

export function formatModelsCommandResult(report) {
  const title = report.action === "setup" ? "AIPI models setup" : "AIPI models";
  const classLines = report.classes.map((entry) =>
    `- ${entry.model_class}: ${entry.model ?? "(unresolved)"} (${entry.source ?? "none"})`
  );
  const warningLines = report.warnings.length
    ? ["", "Warnings:", ...report.warnings.map((warning) => `- ${warning.message}`)]
    : [];
  const orchestratorLine = report.orchestrator
    ? [`Orchestrator (default model): ${report.orchestrator.model}${report.orchestrator.thinking_level ? ` · ${report.orchestrator.thinking_level}` : ""}`]
    : [];
  return [
    `${title}: ${report.state}`,
    `Config: ${MODEL_CAPABILITIES_REL_PATH}`,
    ...orchestratorLine,
    `Adversarial isolation: ${report.adversarial_family_isolation.state}`,
    "Class bindings:",
    ...classLines,
    ...warningLines,
  ].join("\n");
}

async function buildModelsReport(root, { action = "status", now = () => new Date(), extraWarnings = [], orchestrator = null } = {}) {
  const [classIds, capabilityFloors, familyIsolation] = await Promise.all([
    readModelClassIds(root),
    inspectModelCapabilityFloors({ root }),
    inspectAdversarialFamilyIsolation({ root }),
  ]);
  const classes = [];
  for (const modelClass of classIds) {
    const route = await resolveModelClass({ root, modelClass });
    classes.push({
      model_class: modelClass,
      model: describeModel(route.model),
      source: route.source,
      thinking_level: route.thinking_level ?? null,
      capability_state: route.capability_report?.state ?? null,
    });
  }
  const hostRoute = await resolveModelClass({ root, modelClass: "code-strong" });
  const reviewerRoute = await resolveStepModel({
    root,
    step: { agents: ["code-reviewer"] },
    ctx: { model: hostRoute.model },
  }).catch(() => null);
  const warnings = [...governanceWarnings({ classes, familyIsolation }), ...(extraWarnings ?? [])];
  return {
    schema: "aipi.models-command.v1",
    action,
    generated_at: now().toISOString(),
    state: capabilityFloors.state === "pass" && familyIsolation.state === "pass" ? "ready" : "needs_attention",
    project_root: root,
    config_path: MODEL_CAPABILITIES_REL_PATH,
    model_classes_path: MODEL_CLASSES_REL_PATH,
    classes,
    host_model: describeModel(hostRoute.model),
    // The orchestrator (default session model) written this run, if the user set one. null when unchanged.
    orchestrator: orchestrator
      ? { provider: orchestrator.provider, model: `${orchestrator.provider}/${orchestrator.model}`, thinking_level: orchestrator.thinking_level ?? null }
      : null,
    adversarial_reviewer_model: describeModel(reviewerRoute?.model),
    adversarial_reviewer_distinct: Boolean(reviewerRoute?.cross_model_adversarial?.distinct_provider),
    capability_floors: capabilityFloors,
    adversarial_family_isolation: familyIsolation,
    warnings,
  };
}

// Resolve the buckets into parsed { provider, model, thinking_level } specs. Legacy flags (--host -> doer,
// --adversarial -> doer-adversarial) are honored so existing invocations and the wizard fallbacks keep working.
function resolveBucketSpecs(parsed) {
  const out = {};
  for (const bucket of EFFORT_BUCKETS) {
    const spec = parsed.buckets?.[bucket];
    if (spec) out[bucket] = parseProviderModelSpec(spec, `--${bucket}`);
  }
  if (!out.doer && parsed.hostModel) out.doer = parseProviderModelSpec(parsed.hostModel, "--host");
  if (!out["doer-adversarial"] && parsed.adversarialModel) {
    out["doer-adversarial"] = parseProviderModelSpec(parsed.adversarialModel, "--adversarial");
  }
  return out;
}

// Soft WARNING (not a hard error): each adversarial bucket that shares a provider/family with the work it
// reviews (planner-adversarial↔planner, doer-adversarial↔doer) loses cross-model independence.
const ADVERSARIAL_BUCKET_PAIRS = Object.freeze([
  ["planner-adversarial", "planner"],
  ["doer-adversarial", "doer"],
]);
function bucketSetupWarnings(buckets) {
  const warnings = [];
  for (const [adv, author] of ADVERSARIAL_BUCKET_PAIRS) {
    const advProvider = buckets[adv]?.provider;
    if (advProvider && buckets[author]?.provider === advProvider) {
      warnings.push({
        code: "AIPI_EFFORT_ADVERSARIAL_SHARES_FAMILY",
        severity: "warning",
        bucket: adv,
        peer_bucket: author,
        provider: advProvider,
        message:
          `adversarial bucket "${adv}" provider/family "${advProvider}" equals the "${author}" bucket; ` +
          `this loses cross-model adversarial independence (correlated blind spots).`,
      });
    }
  }
  return warnings;
}

// Fan each bucket's MODEL across its classes in config.classes, and each bucket's LEVEL
// across config.class_thinking[<class>]. The per-class thinking map is what the router
// reads back at resolve time (see model-router.js capabilities.class_thinking).
function applyTopology(config, { buckets, classIds, explicitBindings, now }) {
  config.classes ??= {};
  config.models ??= {};
  config.class_thinking ??= {};

  for (const [bucket, classes] of Object.entries(BUCKET_CLASS_MAP)) {
    const spec = buckets[bucket];
    if (!spec) continue;
    for (const modelClass of classes) {
      if (!classIds.includes(modelClass)) continue;
      config.classes[modelClass] = toModelSpec(spec);
      if (spec.thinking_level) config.class_thinking[modelClass] = spec.thinking_level;
      else delete config.class_thinking[modelClass];
    }
  }

  for (const [modelClass, spec] of Object.entries(explicitBindings ?? {})) {
    const parsed = parseProviderModelSpec(spec, `--class ${modelClass}`);
    config.classes[modelClass] = toModelSpec(parsed);
    if (parsed.thinking_level) config.class_thinking[modelClass] = parsed.thinking_level;
  }

  if (!Object.keys(config.class_thinking).length) delete config.class_thinking;

  const configuredModels = new Set(Object.values(config.classes).map(classBindingToModelSpec).filter(Boolean));
  for (const spec of Object.values(buckets)) configuredModels.add(toModelSpec(spec));
  for (const modelSpec of configuredModels) registerModel(config, parseProviderModelSpec(modelSpec, "class binding"), { now });
  config.rule ??=
    "Classes must bind to concrete provider/model selections and models must carry capability evidence. Use `aipi effort setup` to update the 4-bucket provider topology.";
}

function registerModel(config, model, { now = () => new Date() } = {}) {
  config.models ??= {};
  const key = modelKey(model);
  const existing = config.models[key] ?? {};
  config.models[key] = {
    ...existing,
    capabilities: {
      ...defaultCapabilities(),
      ...(existing.capabilities ?? {}),
    },
    evidence: [
      ...(Array.isArray(existing.evidence) ? existing.evidence : []),
      `Configured by aipi models at ${now().toISOString()} for ${model.provider}/${model.model}.`,
    ],
  };
}

function governanceWarnings({ classes }) {
  return classes
    .filter((entry) => HIGH_FREQUENCY_CLASSES.has(entry.model_class) && looksExpensiveFrontier(entry.model))
    .map((entry) => ({
      code: "AIPI_MODEL_COST_HIGH_FREQUENCY_FRONTIER",
      severity: "warning",
      model_class: entry.model_class,
      model: entry.model,
      message:
        `${entry.model_class} is bound to frontier model ${entry.model}; review token/cost budget before high-volume runs.`,
    }));
}

function looksExpensiveFrontier(model) {
  return /\b(opus|frontier|gpt-5\.5|claude-opus)\b/i.test(String(model ?? ""));
}

// Interactive wizard: prompt the 4 provider-agnostic BUCKETS (model + thinking level each)
// instead of looping the 8 capability classes. Each bucket's (model, level) fans out to
// its classes in applyTopology. `--class <class>=<spec>` remains a power-user override.
async function fillInteractiveOptions(options, { root, ui, availableModels = [], thinkingLevels = {} }) {
  if (!options.interactive) return options;
  const promptUi = createPromptUi(ui);
  if (!promptUi) return options;
  try {
    // Available (auth'd) models FIRST so the picker leads with real, ready-to-use ids, then whatever was
    // already configured in this project.
    let candidates = mergeModelCandidates(availableModels, await configuredModelCandidates(root));
    options.buckets ??= {};

    // Orchestrator = the DEFAULT session model, prompted FIRST (with conditional intelligence). Dismissing it
    // keeps the current default unchanged; choosing one both sets Pi's defaultModel and seeds the doer.
    if (!options.orchestrator) {
      const orchestratorSpec = await promptModelSpec(promptUi, `Orchestrator — ${ORCHESTRATOR_DESCRIPTION}`, candidates);
      if (orchestratorSpec) {
        const level = await promptThinkingLevel(promptUi, "Orchestrator thinking level", orchestratorSpec, thinkingLevels);
        options.orchestrator = applyThinkingLevel(orchestratorSpec, level);
        candidates = mergeModelCandidates(candidates, [stripThinkingLevel(options.orchestrator)]);
      }
    }

    for (const bucket of EFFORT_BUCKETS) {
      if (options.buckets[bucket]) {
        candidates = mergeModelCandidates(candidates, [options.buckets[bucket]]);
        continue;
      }
      const label = BUCKET_LABELS[bucket] ?? bucket;
      const description = BUCKET_DESCRIPTIONS[bucket];
      const promptLabel = description ? `${label} — ${description}` : label;
      // For an adversarial bucket, lead the picker with families OTHER than the work it reviews (the author is
      // already chosen since it is prompted earlier). Manual entry can still pick the same family.
      const authorBucket = bucket === "planner-adversarial" ? "planner" : bucket === "doer-adversarial" ? "doer" : null;
      const filtered = authorBucket
        ? candidates.filter((candidate) => providerOfSpec(candidate) !== providerOfSpec(options.buckets[authorBucket]))
        : candidates;
      const modelSpec = await promptModelSpec(promptUi, `${promptLabel} model`, filtered);
      if (!modelSpec) continue;
      const level = await promptThinkingLevel(promptUi, `${label} thinking level`, modelSpec, thinkingLevels);
      const combined = applyThinkingLevel(modelSpec, level);
      options.buckets[bucket] = combined;
      candidates = mergeModelCandidates(candidates, [stripThinkingLevel(combined)]);
    }
  } finally {
    await promptUi.close?.();
  }
  return options;
}

// Canonical thinking-level order (mirrors @earendil-works/pi-ai). "xhigh" is supported only when a model
// EXPLICITLY declares it; every other level is available to any reasoning model unless declared null.
const EXTENDED_THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh"]);

// The thinking levels a model supports, derived from its capabilities exactly as Pi does
// (getSupportedThinkingLevels): a non-reasoning model supports only "off"; a reasoning model supports every
// level whose thinkingLevelMap entry is not null, and "xhigh" only when explicitly present. Returns null for
// an unknown model so callers fall back to free-text instead of guessing.
export function supportedThinkingLevels(model) {
  if (!model) return null;
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh") return mapped !== undefined;
    return true;
  });
}

// Map a Pi ModelRegistry -> { "provider/id": ThinkingLevel[] } for the auth'd (getAvailable) models, so the
// wizard can offer each model ONLY the intelligence levels it actually supports. Never throws.
export function registryThinkingLevels(modelRegistry) {
  const out = {};
  try {
    const models = typeof modelRegistry?.getAvailable === "function" ? modelRegistry.getAvailable() : [];
    for (const model of Array.isArray(models) ? models : []) {
      const provider = model?.provider;
      const id = model?.id ?? model?.model;
      if (!provider || !id) continue;
      const levels = supportedThinkingLevels(model);
      if (levels) out[`${provider}/${id}`] = levels;
    }
  } catch {
    /* best-effort: an unavailable registry just means free-text thinking prompts */
  }
  return out;
}

// Clamp a requested level to the nearest one the model supports (Pi's clampThinkingLevel: prefer the next
// higher supported level, else the next lower). Unknown support -> leave the level as-is.
function clampThinkingLevelTo(level, supported) {
  if (!level) return level ?? null;
  if (!Array.isArray(supported) || !supported.length || supported.includes(level)) return level;
  const idx = EXTENDED_THINKING_LEVELS.indexOf(level);
  if (idx === -1) return supported[0];
  for (let i = idx; i < EXTENDED_THINKING_LEVELS.length; i += 1) {
    if (supported.includes(EXTENDED_THINKING_LEVELS[i])) return EXTENDED_THINKING_LEVELS[i];
  }
  for (let i = idx - 1; i >= 0; i -= 1) {
    if (supported.includes(EXTENDED_THINKING_LEVELS[i])) return EXTENDED_THINKING_LEVELS[i];
  }
  return supported[0];
}

// Prompt the thinking level CONDITIONAL on the chosen model's capabilities: offer a native select of only the
// levels that model supports (strongest first, so max intelligence leads) when known. Falls back to a
// free-text prompt (clamped to supported) when the model's levels are unknown or no select UI exists.
async function promptThinkingLevel(ui, label, modelSpec, thinkingLevels = {}) {
  const embedded = parseProviderModelSpec(modelSpec, label).thinking_level;
  const base = stripThinkingLevel(modelSpec);
  const supported = thinkingLevels?.[base] ?? null;

  // A model that supports exactly one level (e.g. a non-reasoning model -> "off") needs no prompt.
  if (Array.isArray(supported) && supported.length === 1) return supported[0];

  if (Array.isArray(supported) && supported.length > 1 && typeof ui?.select === "function") {
    const ordered = [...supported].sort(
      (a, b) => EXTENDED_THINKING_LEVELS.indexOf(b) - EXTENDED_THINKING_LEVELS.indexOf(a),
    );
    const options = ordered.map((lvl, i) => (i === 0 ? `${lvl} (max for ${base})` : lvl));
    try {
      const picked = await ui.select(`${label} — ${base} supports: ${ordered.join(", ")}`, options);
      const value = picked && typeof picked === "object" ? (picked.value ?? picked.label) : picked;
      if (typeof value === "string" && value.trim()) return value.trim().split(/\s+/)[0].toLowerCase();
    } catch {
      /* fall through to free-text */
    }
  }

  const input = ui?.input ?? ui?.prompt;
  if (typeof input !== "function") return clampThinkingLevelTo(embedded, supported) ?? embedded ?? null;
  const hint = Array.isArray(supported) && supported.length ? supported.join("|") : "off|minimal|low|medium|high|xhigh";
  const value = await input(`${label} (${hint})${embedded ? ` [${embedded}]` : ""}`);
  const chosen = typeof value === "string" && value.trim() ? value.trim().toLowerCase() : embedded;
  return clampThinkingLevelTo(chosen, supported) ?? chosen ?? null;
}

function applyThinkingLevel(modelSpec, level) {
  const base = stripThinkingLevel(modelSpec);
  return level ? `${base}:${level}` : base;
}

function stripThinkingLevel(modelSpec) {
  const text = String(modelSpec ?? "").trim();
  const colon = text.lastIndexOf(":");
  return colon > text.indexOf("/") && colon > 0 ? text.slice(0, colon) : text;
}

// True when the host UI can drive the interactive wizard (a select menu or a free-text prompt).
// Used to decide whether a bare `aipi effort` should open the wizard rather than print status.
function hasInteractivePromptUi(ui) {
  return typeof ui?.select === "function" || typeof ui?.input === "function" || typeof ui?.prompt === "function";
}

function createPromptUi(ui) {
  if (ui?.input || ui?.prompt || ui?.select) return ui;
  if (process.stdin?.isTTY !== true) return null;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    async input(question) {
      return rl.question(`${question}: `);
    },
    async prompt(question) {
      return rl.question(`${question}: `);
    },
    close() {
      rl.close();
    },
  };
}

const TYPE_MANUALLY_OPTION = "✎ type a provider/model manually…";

async function promptModelSpec(ui, label, candidates = [], { defaultValue = null } = {}) {
  const uniqueCandidates = mergeModelCandidates(candidates, [defaultValue]);
  const message = `${label} (provider/model)${defaultValue ? ` [${defaultValue}]` : ""}`;
  const input = ui?.input ?? ui?.prompt;

  // Prefer the native Pi selector so the user PICKS a real, system-known id instead of typing one blind.
  // ctx.ui.select(title, options[]) returns the chosen option string. A manual-entry row is appended (only
  // when a text prompt exists to receive it) so a brand-new model not yet in the list can still be entered.
  if (typeof ui?.select === "function" && uniqueCandidates.length) {
    try {
      const options = typeof input === "function" ? [...uniqueCandidates, TYPE_MANUALLY_OPTION] : uniqueCandidates;
      const selected = await ui.select(message, options);
      const value = selected && typeof selected === "object" ? (selected.value ?? selected.label) : selected;
      if (typeof value === "string" && value.trim() && value !== TYPE_MANUALLY_OPTION) return value.trim();
      // Manual entry falls through to the text prompt; a dismissal with a default keeps the default.
      if (value !== TYPE_MANUALLY_OPTION && defaultValue) return defaultValue;
    } catch {
      /* fall through to text input */
    }
  }

  if (typeof input === "function") {
    const value = await input(message);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (defaultValue) return defaultValue;
  }
  return defaultValue ?? null;
}

// Map a Pi ModelRegistry into provider/model specs the wizard can offer. Uses getAvailable() — only models
// with configured auth (login/API key), i.e. the ones the user can actually run. Never throws.
export function registryModelSpecs(modelRegistry) {
  try {
    const models = typeof modelRegistry?.getAvailable === "function" ? modelRegistry.getAvailable() : [];
    return [...new Set((Array.isArray(models) ? models : [])
      .map((model) => {
        const provider = model?.provider;
        const id = model?.id ?? model?.model;
        return provider && id ? `${provider}/${id}` : null;
      })
      .filter(Boolean))].sort();
  } catch {
    return [];
  }
}

function mergeModelCandidates(...groups) {
  return [...new Set(groups.flat()
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.includes("/")))].sort();
}

async function configuredModelCandidates(root) {
  const config = await readModelCapabilities(root);
  return [...new Set([
    ...Object.values(config.classes ?? {}).map(classBindingToModelSpec),
    ...Object.keys(config.models ?? {}).map((key) => key.replace(":", "/")),
  ]
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.includes("/")))].sort();
}

async function ensureModelClassesFile(root) {
  const target = path.join(root, MODEL_CLASSES_REL_PATH);
  if (await pathExists(target)) return { created: false, path: target };
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(templateModelClassesPath, target);
  return { created: true, path: target };
}

async function readModelClassIds(root) {
  const text = await fs.readFile(path.join(root, MODEL_CLASSES_REL_PATH), "utf8");
  return [...parseModelClasses(text).keys()];
}

async function readModelCapabilities(root) {
  const filePath = path.join(root, MODEL_CAPABILITIES_REL_PATH);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (parsed?.schema === "aipi.model-capabilities.v1" && typeof parsed.models === "object") {
      return {
        schema: "aipi.model-capabilities.v1",
        classes: parsed.classes ?? {},
        class_thinking: parsed.class_thinking ?? {},
        models: parsed.models ?? {},
        rule: parsed.rule ?? null,
      };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    schema: "aipi.model-capabilities.v1",
    classes: {},
    class_thinking: {},
    models: {},
    rule: "Generated by aipi effort.",
  };
}

async function writeModelCapabilities(root, config) {
  const filePath = path.join(root, MODEL_CAPABILITIES_REL_PATH);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeBudgetNotes(root, notes, { now = () => new Date() } = {}) {
  if (!Object.keys(notes ?? {}).length) return null;
  const filePath = path.join(root, PROVIDER_BUDGET_REL_PATH);
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = {
    schema: "aipi.provider-budget.v1",
    enabled: existing.enabled ?? false,
    default: existing.default ?? {},
    providers: existing.providers ?? {},
    models: existing.models ?? {},
    class_notes: {
      ...(existing.class_notes ?? {}),
      ...notes,
    },
    updated_by: "aipi models",
    updated_at: now().toISOString(),
  };
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function parseProviderModelSpec(value, label) {
  const text = String(value ?? "").trim();
  const match = text.match(/^([^/]+)\/([^:]+)(?::([a-z]+))?$/i);
  if (!match) throw new Error(`${label} must be provider/model, got ${text || "(empty)"}`);
  return { provider: match[1].toLowerCase(), model: match[2], thinking_level: match[3] ?? null };
}

function providerOfSpec(value) {
  return String(value ?? "").split("/", 1)[0]?.toLowerCase() || null;
}

function toModelSpec(model) {
  return `${model.provider}/${model.model}`;
}

function modelKey(model) {
  return `${model.provider}:${model.model}`;
}

function defaultCapabilities() {
  return {
    reasoning: "frontier",
    coding: "frontier",
    summarization: "high",
    context: "very_high",
    tool_use: "write_capable",
    structured_outputs: "supported",
    web: "supported",
    citations: "supported",
    evidence_audit: "supported",
  };
}

function splitClassBinding(value) {
  const separator = String(value ?? "").indexOf("=");
  if (separator <= 0) throw new Error("--class must be <model-class>=<provider/model>");
  const modelClass = value.slice(0, separator).trim();
  const modelSpec = value.slice(separator + 1).trim();
  if (!modelClass || !modelSpec) throw new Error("--class must be <model-class>=<provider/model>");
  return [modelClass, modelSpec];
}

function classBindingToModelSpec(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value !== "object") return null;
  const provider = value.provider ?? value.family ?? null;
  const id = value.id ?? value.model ?? value.name ?? null;
  return provider && id ? `${provider}/${id}` : null;
}

function splitBudgetNote(value) {
  const separator = String(value ?? "").indexOf("=");
  if (separator <= 0) throw new Error("--budget-note must be <class-or-provider>=<note>");
  const key = value.slice(0, separator).trim();
  const note = value.slice(separator + 1).trim();
  if (!key || !note) throw new Error("--budget-note must be <class-or-provider>=<note>");
  return [key, note];
}

function nextValue(tokens, index, flag) {
  const value = tokens[index];
  if (!value || value.startsWith("--")) throw new Error(`missing value after ${flag}`);
  return value;
}

function resolveOptionPath(value, cwd) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

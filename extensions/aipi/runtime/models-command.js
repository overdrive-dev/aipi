import fs from "node:fs/promises";
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
const HOST_CLASS_IDS = [
  "orchestrator-heavy",
  "planner-heavy",
  "research-heavy",
  "code-strong",
  "test-strong",
  "context-fast",
];
const ADVERSARIAL_CLASS_ID = "adversarial-heavy";
const VERIFIER_CLASS_ID = "verifier-fast";
const HIGH_FREQUENCY_CLASSES = new Set(["context-fast", "verifier-fast"]);

export function parseModelsArgs(args = [], { cwd = process.cwd() } = {}) {
  const tokens = Array.isArray(args)
    ? args.map((item) => String(item))
    : String(args).trim().split(/\s+/).filter(Boolean);
  const options = {
    action: "status",
    target: cwd,
    json: false,
    interactive: true,
    hostModel: null,
    adversarialModel: null,
    verifierModel: null,
    models: [],
    classBindings: {},
    budgetNotes: {},
  };

  let index = 0;
  if (tokens[0] && !tokens[0].startsWith("-")) {
    const action = tokens[0];
    if (!["setup", "status", "check", "validate"].includes(action)) {
      throw new Error(`unknown aipi models action: ${action}`);
    }
    options.action = action === "validate" ? "check" : action;
    index = 1;
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-") && ["setup", "status", "check", "validate"].includes(token)) {
      options.action = token === "validate" ? "check" : token;
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
    if (token === "--host") {
      options.hostModel = nextValue(tokens, ++index, token);
      options.action = "setup";
      continue;
    }
    if (token === "--adversarial" || token === "--reviewer") {
      options.adversarialModel = nextValue(tokens, ++index, token);
      options.action = "setup";
      continue;
    }
    if (token === "--verifier") {
      options.verifierModel = nextValue(tokens, ++index, token);
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
  now = () => new Date(),
} = {}) {
  const parsed = parseModelsArgs(args, { cwd: projectRoot ?? cwd });
  const root = path.resolve(projectRoot ?? parsed.target);
  await ensureModelClassesFile(root);

  if (parsed.action === "setup") {
    await fillInteractiveOptions(parsed, { root, ui });
    if (!parsed.hostModel) throw new Error("aipi models setup requires --host <provider/model>");
    if (!parsed.adversarialModel) throw new Error("aipi models setup requires --adversarial <provider/model>");
    const host = parseProviderModelSpec(parsed.hostModel, "--host");
    const adversarial = parseProviderModelSpec(parsed.adversarialModel, "--adversarial");
    const verifier = parsed.verifierModel ? parseProviderModelSpec(parsed.verifierModel, "--verifier") : adversarial;
    if (host.provider === adversarial.provider) {
      throw new Error("aipi models setup requires adversarial provider/family to differ from the host provider/family");
    }

    const config = await readModelCapabilities(root);
    const classIds = await readModelClassIds(root);
    applyTopology(config, { host, adversarial, verifier, classIds, explicitBindings: parsed.classBindings, now });
    for (const spec of parsed.models) registerModel(config, parseProviderModelSpec(spec, "--model"), { now });
    await writeModelCapabilities(root, config);
    await writeBudgetNotes(root, parsed.budgetNotes, { now });
  }

  return buildModelsReport(root, { action: parsed.action, now });
}

export function formatModelsCommandResult(report) {
  const title = report.action === "setup" ? "AIPI models setup" : "AIPI models";
  const classLines = report.classes.map((entry) =>
    `- ${entry.model_class}: ${entry.model ?? "(unresolved)"} (${entry.source ?? "none"})`
  );
  const warningLines = report.warnings.length
    ? ["", "Warnings:", ...report.warnings.map((warning) => `- ${warning.message}`)]
    : [];
  return [
    `${title}: ${report.state}`,
    `Config: ${MODEL_CAPABILITIES_REL_PATH}`,
    `Adversarial isolation: ${report.adversarial_family_isolation.state}`,
    "Class bindings:",
    ...classLines,
    ...warningLines,
  ].join("\n");
}

async function buildModelsReport(root, { action = "status", now = () => new Date() } = {}) {
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
  const warnings = governanceWarnings({ classes, familyIsolation });
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
    adversarial_reviewer_model: describeModel(reviewerRoute?.model),
    adversarial_reviewer_distinct: Boolean(reviewerRoute?.cross_model_adversarial?.distinct_provider),
    capability_floors: capabilityFloors,
    adversarial_family_isolation: familyIsolation,
    warnings,
  };
}

function applyTopology(config, { host, adversarial, verifier, classIds, explicitBindings, now }) {
  config.classes ??= {};
  config.models ??= {};
  for (const modelClass of classIds) {
    if (HOST_CLASS_IDS.includes(modelClass)) config.classes[modelClass] = toModelSpec(host);
  }
  if (classIds.includes(ADVERSARIAL_CLASS_ID)) config.classes[ADVERSARIAL_CLASS_ID] = toModelSpec(adversarial);
  if (classIds.includes(VERIFIER_CLASS_ID)) config.classes[VERIFIER_CLASS_ID] = toModelSpec(verifier);

  for (const [modelClass, spec] of Object.entries(explicitBindings ?? {})) {
    config.classes[modelClass] = toModelSpec(parseProviderModelSpec(spec, `--class ${modelClass}`));
  }

  const configuredModels = new Set(Object.values(config.classes).map(classBindingToModelSpec).filter(Boolean));
  configuredModels.add(toModelSpec(host));
  configuredModels.add(toModelSpec(adversarial));
  configuredModels.add(toModelSpec(verifier));
  for (const modelSpec of configuredModels) registerModel(config, parseProviderModelSpec(modelSpec, "class binding"), { now });
  config.rule ??=
    "Classes must bind to concrete provider/model selections and models must carry capability evidence. Use `aipi models setup` to update provider topology.";
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

async function fillInteractiveOptions(options, { root, ui }) {
  if (!options.interactive) return options;
  const promptUi = createPromptUi(ui);
  if (!promptUi) return options;
  try {
    const classIds = await readModelClassIds(root);
    let candidates = await configuredModelCandidates(root);
    if (!options.hostModel) {
      options.hostModel = await promptModelSpec(promptUi, "Host model", candidates);
    }
    candidates = mergeModelCandidates(candidates, [
      options.hostModel,
      options.adversarialModel,
      options.verifierModel,
      ...options.models,
      ...Object.values(options.classBindings ?? {}),
    ]);
    if (!options.adversarialModel) {
      options.adversarialModel = await promptModelSpec(
        promptUi,
        "Adversarial model",
        candidates.filter((candidate) => providerOfSpec(candidate) !== providerOfSpec(options.hostModel)),
      );
    }
    if (!options.verifierModel && options.adversarialModel) {
      options.verifierModel = await promptModelSpec(promptUi, "Verifier model", candidates, {
        defaultValue: options.adversarialModel,
      });
    }
    if (!options.verifierModel && options.adversarialModel) options.verifierModel = options.adversarialModel;
    candidates = mergeModelCandidates(candidates, [
      options.hostModel,
      options.adversarialModel,
      options.verifierModel,
      ...options.models,
      ...Object.values(options.classBindings ?? {}),
    ]);
    for (const modelClass of classIds) {
      if (options.classBindings[modelClass]) continue;
      const defaultValue = defaultModelForClass(modelClass, options);
      const selected = await promptModelSpec(promptUi, `Model for ${modelClass}`, candidates, { defaultValue });
      if (selected) {
        options.classBindings[modelClass] = selected;
        candidates = mergeModelCandidates(candidates, [selected]);
      }
    }
  } finally {
    await promptUi.close?.();
  }
  return options;
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

async function promptModelSpec(ui, label, candidates = [], { defaultValue = null } = {}) {
  const uniqueCandidates = mergeModelCandidates(candidates, [defaultValue]);
  if (typeof ui?.select === "function" && uniqueCandidates.length) {
    try {
      const selected = await ui.select({
        title: label,
        message: `${label} (provider/model)${defaultValue ? ` [${defaultValue}]` : ""}`,
        options: uniqueCandidates.map((candidate) => ({ label: candidate, value: candidate })),
        defaultValue,
      });
      const value = selected?.value ?? selected;
      if (typeof value === "string" && value.trim()) return value.trim();
      if (defaultValue) return defaultValue;
    } catch {
      /* fall through to text input */
    }
  }
  const input = ui?.input ?? ui?.prompt;
  if (typeof input === "function") {
    const value = await input(`${label} (provider/model)${defaultValue ? ` [${defaultValue}]` : ""}`);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (defaultValue) return defaultValue;
  }
  return defaultValue ?? null;
}

function defaultModelForClass(modelClass, options) {
  if (modelClass === ADVERSARIAL_CLASS_ID) return options.adversarialModel;
  if (modelClass === VERIFIER_CLASS_ID) return options.verifierModel ?? options.adversarialModel;
  if (HOST_CLASS_IDS.includes(modelClass)) return options.hostModel;
  return options.hostModel ?? options.adversarialModel ?? options.verifierModel;
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
    models: {},
    rule: "Generated by aipi models.",
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

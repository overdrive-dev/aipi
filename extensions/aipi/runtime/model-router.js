import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

export const MODEL_CAPABILITIES_REL_PATH = ".aipi/model-capabilities.json";
const BOOLEAN_CAPABILITY_FLOORS = new Set(["structured_outputs", "web", "citations", "evidence_audit"]);
const CROSS_FAMILY_REVIEW_CLASSES = new Set(["adversarial-heavy", "verifier-fast"]);

export async function resolveStepModel({
  root,
  step,
  ctx = null,
  env = process.env,
} = {}) {
  const agentId = step?.agents?.[0] ?? null;
  const agentClasses = await readAgentClasses(root);
  const modelClass = agentClasses.get(agentId)?.class ?? "code-strong";
  const route = await resolveModelClass({ root, modelClass, ctx, env });
  if (isAdversarialAgentId(agentId) && ctx?.model) {
    const crossModel = await resolveCrossModelAdversarialRoute({
      root,
      role: agentId,
      modelClass,
      implementerModel: ctx.model,
      preferredRoute: route,
      ctx,
      env,
    });
    if (!crossModel.blocked) {
      return {
        ...route,
        model: crossModel.model,
        source: crossModel.source,
        cross_model_adversarial: crossModel,
      };
    }
  }
  return route;
}

export async function resolveModelClass({
  root,
  modelClass = "code-strong",
  ctx = null,
  env = process.env,
} = {}) {
  const modelClasses = await readModelClasses(root);
  const classMeta = modelClasses.get(modelClass) ?? {};
  const registry = ctx?.modelRegistry ?? null;
  const capabilityRegistry = ctx?.modelCapabilities ?? await readModelCapabilities(root);
  const thinkingLevel = envThinkingLevel(modelClass, env)
    ?? capabilityRegistry?.class_thinking?.[modelClass]
    ?? thinkingLevelForEffort(classMeta.effort);
  const preferredFamilies = classMeta.preferred_families ?? [];
  const envModel = resolveEnvModel({ modelClass, env, registry });
  if (envModel) {
    const crossFamilyModel = resolveCrossFamilyConfiguredModel({
      registry: capabilityRegistry,
      modelClasses,
      modelClass,
      preferredFamilies,
      configuredModel: { model: envModel.model, source: "env" },
      env,
    });
    const selectedEnvModel = crossFamilyModel ?? { model: envModel.model, source: "env" };
    return {
      model_class: modelClass,
      model: selectedEnvModel.model,
      thinking_level: envModel.thinkingLevel ?? thinkingLevel,
      source: selectedEnvModel.source,
      preferred_families: preferredFamilies,
      family_warning: preferredFamilyWarning({
        modelClass,
        model: selectedEnvModel.model,
        preferredFamilies,
        source: selectedEnvModel.source,
      }),
      cross_family_selection: crossFamilyModel?.cross_family_selection ?? null,
      capability_floor: classMeta.capability_floor ?? {},
      capability_report: evaluateModelCapabilityFloor({
        modelClass,
        model: selectedEnvModel.model,
        classMeta,
        registry: capabilityRegistry,
      }),
    };
  }

  const configuredModel = configuredClassModel({ registry: capabilityRegistry, modelClass, env: {} });
  const crossFamilyModel = resolveCrossFamilyConfiguredModel({
    registry: capabilityRegistry,
    modelClasses,
    modelClass,
    preferredFamilies,
    configuredModel,
    env,
  });
  const selectedConfiguredModel = crossFamilyModel ?? configuredModel;
  if (selectedConfiguredModel) {
    return {
      model_class: modelClass,
      model: selectedConfiguredModel.model,
      thinking_level: thinkingLevel,
      source: selectedConfiguredModel.source,
      preferred_families: preferredFamilies,
      family_warning: preferredFamilyWarning({
        modelClass,
        model: selectedConfiguredModel.model,
        preferredFamilies,
        source: selectedConfiguredModel.source,
      }),
      cross_family_selection: crossFamilyModel?.cross_family_selection ?? null,
      capability_floor: classMeta.capability_floor ?? {},
      capability_report: evaluateModelCapabilityFloor({
        modelClass,
        model: selectedConfiguredModel.model,
        classMeta,
        registry: capabilityRegistry,
        source: selectedConfiguredModel.source,
      }),
    };
  }

  if (ctx?.model) {
    return {
      model_class: modelClass,
      model: ctx.model,
      thinking_level: thinkingLevel,
      source: "current-session",
      preferred_families: preferredFamilies,
      family_warning: preferredFamilyWarning({ modelClass, model: ctx.model, preferredFamilies, source: "current-session" }),
      capability_floor: classMeta.capability_floor ?? {},
      capability_report: evaluateModelCapabilityFloor({
        modelClass,
        model: ctx.model,
        classMeta,
        registry: capabilityRegistry,
      }),
    };
  }

  return {
    model_class: modelClass,
    model: null,
    thinking_level: thinkingLevel,
    source: "class-only",
    preferred_families: preferredFamilies,
    family_warning: null,
    capability_floor: classMeta.capability_floor ?? {},
    capability_report: evaluateModelCapabilityFloor({
      modelClass,
      model: null,
      classMeta,
      registry: capabilityRegistry,
    }),
  };
}

const DEFAULT_ADVERSARIAL_IN_SCOPE_PROVIDERS = new Set(["anthropic", "openai", "codex", "openai-codex"]);
const DEFAULT_ADVERSARIAL_OUT_OF_SCOPE_PROVIDERS = new Set(["bedrock", "deepseek", "glm", "zai"]);

export async function resolveCrossModelAdversarialRoute({
  root,
  role = "reviewer",
  modelClass = null,
  implementerModel = null,
  preferredRoute = null,
  ctx = null,
  env = process.env,
} = {}) {
  const targetClass = modelClass ?? adversarialModelClassForRole(role);
  const route = preferredRoute ?? await resolveModelClass({ root, modelClass: targetClass, ctx, env });
  const implementer = normalizeConfiguredModelRef(implementerModel) ?? parseDescribedModel(describeModel(implementerModel));
  const implementerProvider = providerOfModel(implementer);
  const registry = ctx?.modelCapabilities ?? await readModelCapabilities(root);
  const modelClasses = await readModelClasses(root).catch(() => new Map());
  const providerScope = adversarialProviderScope({ registry, modelClasses, env });
  const candidates = collectAdversarialModelCandidates({ route, registry, modelClasses, env });
  const rejected = [];

  for (const candidate of candidates) {
    const provider = providerOfModel(candidate.model);
    if (!provider) {
      rejected.push({ model: describeModel(candidate.model), reason: "missing_provider" });
      continue;
    }
    const providerRejection = adversarialProviderRejection(provider, providerScope);
    if (providerRejection) {
      rejected.push({ model: describeModel(candidate.model), reason: providerRejection });
      continue;
    }
    if (implementerProvider && provider === implementerProvider) {
      rejected.push({ model: describeModel(candidate.model), reason: "same_provider_as_implementer" });
      continue;
    }
    return {
      schema: "aipi.cross-model-adversarial-route.v1",
      role,
      model_class: targetClass,
      implementer_model: describeModel(implementer),
      implementer_provider: implementerProvider,
      model: candidate.model,
      model_id: describeModel(candidate.model),
      provider,
      provider_scope: compactAdversarialProviderScope(providerScope),
      source: candidate.source,
      distinct_provider: Boolean(implementerProvider && provider !== implementerProvider),
      blocked: false,
      rejected,
    };
  }

  return {
    schema: "aipi.cross-model-adversarial-route.v1",
    role,
    model_class: targetClass,
    implementer_model: describeModel(implementer),
    implementer_provider: implementerProvider,
    model: null,
    model_id: null,
    provider: null,
    provider_scope: compactAdversarialProviderScope(providerScope),
    source: "unresolved",
    distinct_provider: false,
    blocked: true,
    status: "no_distinct_in_scope_model",
    rejected,
  };
}

function collectAdversarialModelCandidates({ route, registry, modelClasses, env = {} }) {
  const out = [];
  const seen = new Set();
  const push = (model, source) => {
    const normalized = normalizeConfiguredModelRef(model) ?? parseDescribedModel(describeModel(model));
    const id = describeModel(normalized);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ model: normalized, source });
  };
  push(route?.model, route?.source ?? "route");

  for (const modelClass of modelClasses.keys()) {
    const configured = configuredClassModel({ registry, modelClass, env });
    if (configured) push(configured.model, configured.source);
  }
  for (const [key, value] of Object.entries(registry?.models ?? {})) {
    push(modelRefFromCapabilityKey(key, value), "model-capabilities");
  }
  return out;
}

function resolveCrossFamilyConfiguredModel({
  registry,
  modelClasses,
  modelClass,
  preferredFamilies = [],
  configuredModel = null,
  env = {},
} = {}) {
  if (!CROSS_FAMILY_REVIEW_CLASSES.has(modelClass)) return null;
  const implementer = configuredClassModel({ registry, modelClass: "code-strong", env });
  const implementerProvider = providerOfModel(implementer?.model);
  if (!implementerProvider) return null;
  const currentProvider = providerOfModel(configuredModel?.model);
  if (currentProvider && currentProvider !== implementerProvider) return null;
  const providerScope = adversarialProviderScope({ registry, modelClasses, env });

  const candidates = collectAdversarialModelCandidates({
    route: configuredModel ? { model: configuredModel.model, source: configuredModel.source } : null,
    registry,
    modelClasses,
    env,
  })
    .filter((candidate) => {
      const provider = providerOfModel(candidate.model);
      if (!provider || provider === implementerProvider) return false;
      return providerInAdversarialScope(provider, providerScope);
    })
    .sort((left, right) =>
      preferredFamilyIndex(providerOfModel(left.model), preferredFamilies) -
        preferredFamilyIndex(providerOfModel(right.model), preferredFamilies) ||
      String(left.source ?? "").localeCompare(String(right.source ?? "")) ||
      describeModel(left.model).localeCompare(describeModel(right.model))
    );

  const selected = candidates[0];
  if (!selected) return null;
  return {
    source: `${selected.source}:cross-family`,
    model: selected.model,
    cross_family_selection: {
      schema: "aipi.cross-family-review-selection.v1",
      model_class: modelClass,
      implementation_class: "code-strong",
      implementation_provider: implementerProvider,
      provider: providerOfModel(selected.model),
      model: describeModel(selected.model),
      reason: `${modelClass} must use a different configured model family than code-strong when available.`,
    },
  };
}

function preferredFamilyIndex(provider, preferredFamilies = []) {
  const index = preferredFamilies.indexOf(provider);
  return index >= 0 ? index : preferredFamilies.length + 1;
}

export async function inspectAdversarialFamilyIsolation({
  root,
  env = process.env,
} = {}) {
  const [modelClasses, registry] = await Promise.all([
    readModelClasses(root),
    readModelCapabilities(root),
  ]);
  return evaluateAdversarialFamilyIsolation({ modelClasses, registry, env });
}

export function evaluateAdversarialFamilyIsolation({
  modelClasses = new Map(),
  registry = null,
  env = process.env,
} = {}) {
  const implementer = configuredClassModel({ registry, modelClass: "code-strong", env });
  const implementerProvider = providerOfModel(implementer?.model);
  const reviewClasses = [...CROSS_FAMILY_REVIEW_CLASSES].filter((modelClass) => modelClasses.has(modelClass));
  const reviewRoutes = reviewClasses.map((modelClass) => {
    const classMeta = modelClasses.get(modelClass) ?? {};
    const configured = configuredClassModel({ registry, modelClass, env });
    const selected = resolveCrossFamilyConfiguredModel({
      registry,
      modelClasses,
      modelClass,
      preferredFamilies: classMeta.preferred_families ?? [],
      configuredModel: configured,
      env,
    }) ?? configured;
    return {
      model_class: modelClass,
      model: describeModel(selected?.model),
      provider: providerOfModel(selected?.model),
      source: selected?.source ?? "none",
      distinct_from_code_strong: Boolean(implementerProvider && providerOfModel(selected?.model) && providerOfModel(selected?.model) !== implementerProvider),
    };
  });
  const configuredFamilies = configuredModelFamilies(registry, modelClasses, env);
  const providerScope = adversarialProviderScope({ registry, modelClasses, env });
  const sameFamily = reviewRoutes.filter((route) => route.provider && route.provider === implementerProvider);
  const distinctConfigured = implementerProvider && [...configuredFamilies].some((provider) =>
    provider !== implementerProvider && providerInAdversarialScope(provider, providerScope)
  );
  const state = !implementerProvider || !reviewRoutes.length
    ? "not_applicable"
    : sameFamily.length && !distinctConfigured
      ? "warn"
      : "pass";
  return {
    schema: "aipi.adversarial-family-isolation.v1",
    state,
    implementation_class: "code-strong",
    implementation_model: describeModel(implementer?.model),
    implementation_provider: implementerProvider ?? null,
    configured_families: [...configuredFamilies].sort(),
    provider_scope: compactAdversarialProviderScope(providerScope),
    review_routes: reviewRoutes,
    evidence:
      state === "warn"
        ? `Only one configured model family (${implementerProvider}) is available; adversarial-heavy/verifier-fast run same-family-as-implementation, creating correlated blind spots.`
        : state === "pass"
          ? "Adversarial review classes resolve to a distinct configured model family when one is available."
          : "Adversarial family isolation is not applicable because code-strong or review classes are unconfigured.",
  };
}

function adversarialProviderScope({ registry = null, modelClasses = new Map(), env = process.env } = {}) {
  const envInScope = csvSet(env?.AIPI_ADVERSARIAL_IN_SCOPE_PROVIDERS ?? env?.AIPI_ADVERSARIAL_PROVIDERS);
  const envOutOfScope = csvSet(env?.AIPI_ADVERSARIAL_OUT_OF_SCOPE_PROVIDERS);
  const configured = configuredModelFamilies(registry, modelClasses, env);
  const inScope = envInScope.size
    ? envInScope
    : configured.size
      ? configured
      : new Set(DEFAULT_ADVERSARIAL_IN_SCOPE_PROVIDERS);
  const outOfScope = envOutOfScope.size
    ? envOutOfScope
    : new Set(DEFAULT_ADVERSARIAL_OUT_OF_SCOPE_PROVIDERS);
  return {
    inScope,
    outOfScope,
    source: envInScope.size ? "env" : configured.size ? "configured-providers" : "default",
  };
}

function providerInAdversarialScope(provider, scope) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (scope?.outOfScope?.has(normalized)) return false;
  return !scope?.inScope?.size || scope.inScope.has(normalized);
}

function adversarialProviderRejection(provider, scope) {
  const normalized = String(provider ?? "").trim().toLowerCase();
  if (!normalized) return "missing_provider";
  if (scope?.outOfScope?.has(normalized)) return "provider_out_of_scope";
  if (scope?.inScope?.size && !scope.inScope.has(normalized)) return "provider_not_configured";
  return null;
}

function compactAdversarialProviderScope(scope) {
  return {
    source: scope?.source ?? "unknown",
    in_scope: [...(scope?.inScope ?? [])].sort(),
    out_of_scope: [...(scope?.outOfScope ?? [])].sort(),
  };
}

function csvSet(value) {
  if (Array.isArray(value)) {
    return new Set(value.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean));
  }
  return new Set(
    String(value ?? "")
      .split(/[,\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

function configuredModelFamilies(registry = null, modelClasses = new Map(), env = {}) {
  const families = new Set();
  for (const modelClass of modelClasses.keys()) {
    const provider = providerOfModel(configuredClassModel({ registry: null, modelClass, env })?.model);
    if (provider) families.add(provider);
  }
  for (const value of Object.values(registry?.classes ?? {})) {
    const provider = providerOfModel(normalizeConfiguredModelRef(value));
    if (provider) families.add(provider);
  }
  for (const [key, value] of Object.entries(registry?.models ?? {})) {
    const provider = providerOfModel(modelRefFromCapabilityKey(key, value));
    if (provider) families.add(provider);
  }
  return families;
}

function modelRefFromCapabilityKey(key, value = {}) {
  if (value?.provider && (value.id || value.model)) return { provider: value.provider, id: value.id ?? value.model };
  const colon = String(key).match(/^([^:]+):(.+)$/);
  if (colon) return { provider: colon[1], id: colon[2] };
  const slash = String(key).match(/^([^/]+)\/(.+)$/);
  if (slash) return { provider: slash[1], id: slash[2] };
  return null;
}

function parseDescribedModel(value) {
  const parsed = parseProviderModelSpec(value);
  return parsed ? { provider: parsed.provider, id: parsed.model } : null;
}

function adversarialModelClassForRole(role) {
  const normalized = String(role ?? "").toLowerCase();
  if (normalized.includes("verifier") || normalized.includes("test-gate")) return "verifier-fast";
  return "adversarial-heavy";
}

function isAdversarialAgentId(agentId) {
  const normalized = String(agentId ?? "").toLowerCase();
  return /\b(review|reviewer|auditor|adversarial|verifier|contrarian|blast-radius|security)\b/.test(normalized);
}

function providerOfModel(model) {
  return String(model?.provider ?? model?.family ?? "").trim().toLowerCase() || null;
}

function preferredFamilyWarning({ modelClass, model, preferredFamilies = [], source = null }) {
  const provider = model?.provider ?? model?.family ?? null;
  if (!provider || !preferredFamilies.length || preferredFamilies.includes(provider)) return null;
  return {
    code: "AIPI_MODEL_PREFERRED_FAMILY_MISMATCH",
    severity: "warn",
    message: `AIPI model class "${modelClass}" resolved through ${source ?? "unknown"} to provider "${provider}", outside preferred_families: ${preferredFamilies.join(", ")}.`,
    model_class: modelClass,
    provider,
    preferred_families: preferredFamilies,
    source,
  };
}

export function parseAgentClasses(text) {
  const agents = new Map();
  let current = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const id = line.match(/^  - id: ([a-z0-9-]+)$/);
    if (id) {
      current = { id: id[1] };
      agents.set(current.id, current);
      continue;
    }
    if (!current) continue;
    const modelClass = line.match(/^    class: ([a-z0-9_-]+)$/);
    if (modelClass) current.class = modelClass[1];
  }
  return agents;
}

export function parseModelClasses(text) {
  const classes = new Map();
  let inClasses = false;
  let current = null;
  let section = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line === "classes:") {
      inClasses = true;
      continue;
    }
    if (!inClasses) continue;

    const className = line.match(/^  ([a-z0-9_-]+):$/);
    if (className) {
      current = { id: className[1] };
      classes.set(current.id, current);
      section = null;
      continue;
    }
    if (!current) continue;
    const effort = line.match(/^    effort: ([a-z0-9_-]+)$/);
    if (effort) {
      current.effort = effort[1];
      section = null;
    }
    const contextNeed = line.match(/^    context_need: ([a-z0-9_-]+)$/);
    if (contextNeed) {
      current.context_need = contextNeed[1];
      section = null;
    }
    const families = line.match(/^    preferred_families: \[(.*)\]$/);
    if (families) {
      current.preferred_families = families[1]
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      section = null;
    }
    if (line.match(/^    capability_floor:\s*$/)) {
      current.capability_floor = {};
      section = "capability_floor";
      continue;
    }
    const floor = line.match(/^      ([a-z0-9_]+): ([a-z0-9_-]+)$/);
    if (section === "capability_floor" && floor) {
      current.capability_floor[floor[1]] = floor[2];
    }
  }
  return classes;
}

export async function inspectModelCapabilityFloors({
  root,
  env = process.env,
} = {}) {
  const modelClasses = await readModelClasses(root);
  const registry = await readModelCapabilities(root);
  const checks = [];
  for (const [modelClass, classMeta] of modelClasses.entries()) {
    const classModel = configuredClassModel({ registry, modelClass, env });
    if (!classModel) {
      checks.push({
        model_class: modelClass,
        state: "missing_class_model",
        model: null,
        source: "none",
        floor: classMeta.capability_floor ?? {},
        evidence: `No model configured for ${modelClass} in ${MODEL_CAPABILITIES_REL_PATH} or AIPI_MODEL_CLASS_${modelClassEnvKey(modelClass)}.`,
      });
      continue;
    }
    checks.push(evaluateModelCapabilityFloor({
      modelClass,
      model: classModel.model,
      classMeta,
      registry,
      source: classModel.source,
    }));
  }
  const failing = checks.filter((check) => check.state !== "pass");
  return {
    schema: "aipi.model-capability-floor-report.v1",
    state: failing.length ? "block" : "pass",
    config_path: MODEL_CAPABILITIES_REL_PATH,
    total_classes: checks.length,
    passed: checks.length - failing.length,
    failing: failing.length,
    checks,
  };
}

export function evaluateModelCapabilityFloor({
  modelClass,
  model,
  classMeta = {},
  registry = null,
  source = null,
} = {}) {
  const floor = classMeta.capability_floor ?? {};
  const modelId = describeModel(model);
  if (!modelId) {
    return {
      schema: "aipi.model-capability-floor.v1",
      model_class: modelClass,
      state: "not_applicable",
      model: null,
      source,
      floor,
      missing: [],
      unmet: [],
      evidence: "No concrete model was resolved for this class.",
    };
  }
  if (!Object.keys(floor).length) {
    return {
      schema: "aipi.model-capability-floor.v1",
      model_class: modelClass,
      state: "pass",
      model: modelId,
      source,
      floor,
      missing: [],
      unmet: [],
      evidence: "Model class declares no capability_floor.",
    };
  }
  if (!registry?.valid) {
    return {
      schema: "aipi.model-capability-floor.v1",
      model_class: modelClass,
      state: "missing_registry",
      model: modelId,
      source,
      floor,
      missing: Object.keys(floor),
      unmet: [],
      evidence: `${MODEL_CAPABILITIES_REL_PATH} is missing or invalid; capability floor cannot be proven.`,
    };
  }

  const modelCapabilities = modelCapabilityFor(registry, model);
  if (!modelCapabilities) {
    return {
      schema: "aipi.model-capability-floor.v1",
      model_class: modelClass,
      state: "missing_model_capabilities",
      model: modelId,
      source,
      floor,
      missing: Object.keys(floor),
      unmet: [],
      evidence: `${MODEL_CAPABILITIES_REL_PATH} has no capabilities for ${modelId}.`,
    };
  }

  const capabilities = modelCapabilities.capabilities ?? {};
  const missing = [];
  const unmet = [];
  for (const [capability, expected] of Object.entries(floor)) {
    const actual = capabilities[capability];
    if (actual == null) {
      missing.push(capability);
      continue;
    }
    if (!capabilitySatisfies(capability, actual, expected)) {
      unmet.push({ capability, expected, actual });
    }
  }
  return {
    schema: "aipi.model-capability-floor.v1",
    model_class: modelClass,
    state: missing.length || unmet.length ? "fail" : "pass",
    model: modelId,
    source,
    floor,
    missing,
    unmet,
    evidence: missing.length || unmet.length
      ? `${modelId} does not prove ${modelClass} capability_floor.`
      : `${modelId} satisfies ${modelClass} capability_floor via ${MODEL_CAPABILITIES_REL_PATH}.`,
    evidence_ref: modelCapabilities.evidence ?? null,
  };
}

async function readModelCapabilities(root) {
  try {
    const raw = await fs.readFile(path.join(root, MODEL_CAPABILITIES_REL_PATH), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== "aipi.model-capabilities.v1" || typeof parsed.models !== "object") {
      return { valid: false, exists: true, classes: {}, models: {}, error: "invalid schema or models object" };
    }
    return {
      valid: true,
      exists: true,
      classes: parsed.classes ?? {},
      class_thinking: parsed.class_thinking ?? {},
      models: parsed.models ?? {},
      rule: parsed.rule ?? null,
    };
  } catch (error) {
    if (error.code === "ENOENT") return { valid: false, exists: false, classes: {}, models: {}, error: "missing" };
    return { valid: false, exists: true, classes: {}, models: {}, error: String(error?.message ?? error) };
  }
}

function configuredClassModel({ registry, modelClass, env }) {
  const envSpec = env?.[`AIPI_MODEL_CLASS_${modelClassEnvKey(modelClass)}`] ?? env?.[`AIPI_MODEL_${modelClassEnvKey(modelClass)}`];
  if (envSpec) {
    const parsed = parseProviderModelSpec(envSpec);
    if (parsed) return { source: "env", model: { provider: parsed.provider, id: parsed.model } };
  }
  const configured = registry?.classes?.[modelClass];
  const normalized = normalizeConfiguredModelRef(configured);
  return normalized ? { source: "model-capabilities", model: normalized } : null;
}

function normalizeConfiguredModelRef(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const parsed = parseProviderModelSpec(value);
    return parsed ? { provider: parsed.provider, id: parsed.model } : null;
  }
  if (typeof value !== "object") return null;
  const provider = value.provider ?? value.family ?? null;
  const id = value.id ?? value.model ?? value.name ?? null;
  return provider && id ? { provider, id } : null;
}

function modelCapabilityFor(registry, model) {
  const modelId = describeModel(model);
  if (!modelId) return null;
  const [provider, id] = modelId.includes("/") ? modelId.split("/", 2) : [model?.provider ?? model?.family, modelId];
  const keys = [
    `${provider}:${id}`,
    `${provider}/${id}`,
    modelId,
    id,
  ].filter(Boolean);
  for (const key of keys) {
    if (registry?.models?.[key]) return registry.models[key];
  }
  if (model && typeof model === "object" && model.capabilities) {
    return { capabilities: model.capabilities, evidence: model.evidence ?? ["model object"] };
  }
  return null;
}

function capabilitySatisfies(capability, actual, expected) {
  if (capability === "tool_use") {
    return orderedAtLeast(actual, expected, ["none", "read_only", "required", "write_capable"]);
  }
  if (capability === "reasoning") {
    return orderedAtLeast(actual, expected, ["none", "low", "medium", "medium_high", "high", "frontier"]);
  }
  if (capability === "context") {
    return orderedAtLeast(actual, expected, ["none", "low", "medium", "medium_high", "high", "very_high"]);
  }
  if (["coding", "summarization"].includes(capability)) {
    return orderedAtLeast(actual, expected, ["none", "low", "medium", "medium_high", "high", "frontier"]);
  }
  if (BOOLEAN_CAPABILITY_FLOORS.has(capability)) {
    return booleanCapabilitySatisfies(actual, expected);
  }
  if (expected === "required" || expected === "required_when_current_facts_matter") {
    return actual === true || ["required", "supported", "available", "enabled", expected].includes(String(actual));
  }
  return String(actual) === String(expected);
}

function booleanCapabilitySatisfies(actual, expected) {
  if (!["required", "required_when_current_facts_matter", "true", true].includes(expected)) {
    return String(actual) === String(expected);
  }
  if (actual === true) return true;
  const normalized = String(actual).trim().toLowerCase();
  if (!normalized) return false;
  if (["false", "no", "none", "unavailable", "disabled", "unsupported", "not_supported"].includes(normalized)) {
    return false;
  }
  return [
    "true",
    "yes",
    "required",
    "required_when_current_facts_matter",
    "supported",
    "available",
    "enabled",
    "low",
    "medium",
    "medium_high",
    "high",
    "frontier",
  ].includes(normalized);
}

function orderedAtLeast(actual, expected, order) {
  const actualIndex = order.indexOf(String(actual));
  const expectedIndex = order.indexOf(String(expected));
  if (actualIndex < 0 || expectedIndex < 0) return String(actual) === String(expected);
  return actualIndex >= expectedIndex;
}

function resolveEnvModel({ modelClass, env, registry }) {
  const key = modelClassEnvKey(modelClass);
  const spec = env[`AIPI_MODEL_CLASS_${key}`] ?? env[`AIPI_MODEL_${key}`];
  if (!spec) return null;
  const parsed = parseProviderModelSpec(spec);
  if (!parsed) return null;
  const model = registry?.find?.(parsed.provider, parsed.model) ?? { provider: parsed.provider, id: parsed.model };
  return { model, thinkingLevel: parsed.thinkingLevel };
}

function parseProviderModelSpec(spec) {
  const match = String(spec).trim().match(/^([^/]+)\/([^:]+)(?::([a-z]+))?$/i);
  if (!match) return null;
  return {
    provider: match[1],
    model: match[2],
    thinkingLevel: match[3] ?? null,
  };
}

function envThinkingLevel(modelClass, env) {
  return env[`AIPI_THINKING_${modelClassEnvKey(modelClass)}`] ?? null;
}

function modelClassEnvKey(modelClass) {
  return String(modelClass ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
}

function thinkingLevelForEffort(effort) {
  if (effort === "xhigh") return "xhigh";
  if (effort === "high") return "high";
  if (effort === "medium") return "medium";
  if (effort === "low") return "low";
  return undefined;
}

async function readAgentClasses(root) {
  const text = await fs.readFile(path.join(root, ".aipi", "agents", "catalog.yaml"), "utf8");
  return parseAgentClasses(text);
}

async function readModelClasses(root) {
  const text = await fs.readFile(path.join(root, ".aipi", "model-classes.yaml"), "utf8");
  return parseModelClasses(text);
}

// ===================================================================
// Hybrid model-class policy + spawn-time observability.
//
// resolveStepModel (above) resolves a concrete model for the WORKFLOW path. A direct
// aipi_spawn_agent tool call bypasses it, so the coordinator enforces this policy at the
// single spawn chokepoint: validate the requested model_class against the catalog, use
// the host session model by default when the class is unbound, and record
// model_requested/model_resolved so a silent swap is impossible.
// ===================================================================

// Capability classes shipped in templates/.aipi/model-classes.yaml. Used to validate
// spawns when a project has no installed catalog. Keep in sync with that file.
export const BUILTIN_MODEL_CLASSES = Object.freeze([
  "orchestrator-heavy",
  "planner-heavy",
  "adversarial-heavy",
  "research-heavy",
  "code-strong",
  "test-strong",
  "context-fast",
  "verifier-fast",
]);

// Sentinel for "no concrete provider/model was resolved and no host model was available".
// Local interactive use should pass ctx.model into spawn descriptors so worker sessions
// receive a real model instead of relying on this sentinel.
export const HOST_DEFAULT_MODEL = "host-default";

// Synchronously load the valid model-class ids from .aipi/model-classes.yaml. The
// coordinator's spawn() is synchronous, so validation can't await the async readers
// above. Returns a Set, or null when no catalog is installed (caller falls back to
// BUILTIN_MODEL_CLASSES).
export function loadKnownModelClassesSync(root) {
  try {
    const text = fsSync.readFileSync(path.join(root, ".aipi", "model-classes.yaml"), "utf8");
    const classes = parseModelClasses(text);
    return classes.size ? new Set(classes.keys()) : null;
  } catch {
    return null;
  }
}

// Render a resolved model (registry/ctx shape `{ provider, id }`, or a string) to a
// stable id string for provenance. Returns null when nothing concrete was resolved.
export function describeModel(model) {
  if (model == null) return null;
  if (typeof model === "string") return model;
  const provider = model.provider ?? model.family ?? null;
  const id = model.id ?? model.model ?? model.name ?? null;
  if (provider && id) return `${provider}/${id}`;
  return id ?? provider ?? null;
}

// Hybrid policy decision for a spawn descriptor. A concrete model resolved upstream
// (workflow path sets descriptor.model + model_resolution_source) is reported as
// model_resolved. If the class is unbound and fallback is allowed, the worker runs on
// descriptor.host_model/hostModel. Set allow_fallback:false to fail loud instead.
export function resolveSpawnModelDecision({ knownClasses, descriptor = {} }) {
  const known = knownClasses instanceof Set ? knownClasses : new Set(knownClasses ?? []);
  const requested = descriptor.model_class ?? null;
  const concrete = descriptor.model ?? null;
  const hostModel = descriptor.host_model ?? descriptor.hostModel ?? null;
  const resolvedModelId = describeModel(concrete);
  const hostModelId = describeModel(hostModel);
  const upstreamSource = descriptor.model_resolution_source ?? null;
  const strict = descriptor.allow_fallback === false;
  const fallbackModel = concrete ?? hostModel ?? null;
  const fallbackModelId = resolvedModelId ?? hostModelId ?? HOST_DEFAULT_MODEL;
  const hostFallback = !resolvedModelId && Boolean(hostModelId);
  const fallbackSource = upstreamSource ?? (
    concrete ? "explicit" : hostModel ? "host-default" : "host-default-unavailable"
  );

  if (requested == null) {
    return {
      requested: null,
      resolved: fallbackModelId,
      model: fallbackModel,
      source: fallbackSource,
      known: true,
      fallback: false,
      host_fallback: hostFallback,
      host_model: hostModelId,
      mismatch: !resolvedModelId && Boolean(hostModelId),
      warning: null,
    };
  }

  const isKnown = known.has(requested);
  if (!isKnown && strict) {
    const err = new Error(
      `unknown model_class "${requested}". Known classes: ${[...known].join(", ") || "(none configured)"}. ` +
        `Omit allow_fallback or set it to true to run on the host model instead.`,
    );
    err.code = "AIPI_UNKNOWN_MODEL_CLASS";
    throw err;
  }
  if (isKnown && strict && !resolvedModelId) {
    const err = new Error(
      `model_class "${requested}" is recognized but unbound; allow_fallback:false refuses to use ` +
        `${hostModelId ? `host model "${hostModelId}"` : "the host default model"}.`,
    );
    err.code = "AIPI_MODEL_CLASS_UNRESOLVED";
    throw err;
  }

  const resolved = fallbackModelId;
  const mismatch = !isKnown || !resolvedModelId;
  let warning = null;
  if (!isKnown) {
    warning = {
      code: "AIPI_MODEL_CLASS_FALLBACK",
      severity: "warn",
      message: hostModelId
        ? `model_class "${requested}" is not in the catalog; running on host model "${hostModelId}" by fallback.`
        : `model_class "${requested}" is not in the catalog; no host model was available, so the worker may rely on the host default.`,
      model_requested: requested,
      model_resolved: resolved,
    };
  } else if (mismatch) {
    warning = {
      code: "AIPI_MODEL_CLASS_UNRESOLVED",
      severity: "info",
      message: hostModelId
        ? `running on host model "${hostModelId}" (class "${requested}" unbound).`
        : `model_class "${requested}" is recognized but did not resolve to a concrete model; no host model was available.`,
      model_requested: requested,
      model_resolved: resolved,
    };
  }

  return {
    requested,
    resolved,
    model: fallbackModel,
    source: resolvedModelId ? (upstreamSource ?? "resolved") : fallbackSource,
    known: isKnown,
    fallback: mismatch,
    host_fallback: hostFallback,
    host_model: hostModelId,
    mismatch,
    warning,
  };
}

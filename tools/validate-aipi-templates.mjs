import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function list(dir, suffix) {
  return fs
    .readdirSync(path.join(root, dir))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => `${dir}/${name}`);
}

function parseInlineList(value) {
  const match = value.match(/\[(.*)\]/);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFrontmatter(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const metadata = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---") return metadata;
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) metadata[field[1].replaceAll("-", "_")] = field[2].trim();
  }
  return null;
}

function uniqueArray(name, values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) errors.push(`runtime-contract ${name} duplicates ${value}`);
    seen.add(value);
  }
}

function uniqueValues(name, values) {
  const seen = new Set();
  for (const value of values ?? []) {
    if (seen.has(value)) errors.push(`${name} duplicates ${value}`);
    seen.add(value);
  }
  return seen;
}

function parseModelClassIds(text) {
  const ids = [];
  let inClasses = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line === "classes:") {
      inClasses = true;
      continue;
    }
    if (!inClasses) continue;
    const match = line.match(/^  ([a-z0-9_-]+):$/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

const contract = JSON.parse(read("templates/.aipi/runtime-contract.json"));
const providerPricingConfig = JSON.parse(read("templates/.aipi/provider-pricing.json"));
const providerBudgetConfig = JSON.parse(read("templates/.aipi/provider-budget.json"));
const modelCapabilitiesConfig = JSON.parse(read("templates/.aipi/model-capabilities.json"));
const templateModelClassIds = parseModelClassIds(read("templates/.aipi/model-classes.yaml"));
const mcpConfig = JSON.parse(read("templates/.aipi/mcp.json"));
const validStages = new Set([
  ...contract.canonicalStages,
  ...(contract.stageSelectors ?? []),
]);
const validVerdicts = new Set(contract.stepVerdicts);
const validPolicyDecisions = new Set(contract.policyDecisions);
const validEvidenceRungs = new Set(contract.evidenceRungs);
const validAgentRuntimes = new Set(contract.agentRuntimes ?? []);
const terminalActions = new Set(contract.terminalActions ?? []);
const skipConditions = new Set(Object.keys(contract.skipConditions ?? {}));
const sharedArtifacts = new Set(contract.artifactPolicy?.sharedArtifacts ?? []);
const badSubagentPackageName = "pi-" + "subagentura";
const providerAuthEntries = Object.entries(contract.providerAuth ?? {});
const lifecycleHooks = contract.lifecycleHooks ?? {};
const removedParentModule = ["parent", "policy"].join("-");
const removedProfileModule = ["profile", "policy"].join("-");
const removedProfileTemplate = ["profiles", "json"].join(".");
const removedGateRegistration = ["registerParent", "ToolGate"].join("");
const removedProfileCommand = ["aipi", "profile"].join(" ");
const removedPolicyDecision = ["APPROVAL", "REQUIRED"].join("_");

for (const [name, values] of [
  ["canonicalStages", contract.canonicalStages],
  ["stepVerdicts", contract.stepVerdicts],
  ["policyDecisions", contract.policyDecisions],
  ["evidenceRungs", contract.evidenceRungs],
  ["terminalActions", contract.terminalActions ?? []],
]) {
  uniqueArray(name, values);
}

if (!contract.runLimits) {
  errors.push("runtime-contract missing runLimits");
} else if (!terminalActions.has(contract.runLimits.onExhaustion)) {
  errors.push(`runtime-contract runLimits.onExhaustion is not a terminal action: ${contract.runLimits.onExhaustion}`);
}
if (!contract.runState?.userInputPathRule?.includes("USER-INPUT.jsonl")) {
  errors.push("runtime-contract runState.userInputPathRule must document USER-INPUT.jsonl");
}
if (!contract.runState?.userInputPathRule?.includes("not silently consumed")) {
  errors.push("runtime-contract runState.userInputPathRule must document headless input is not silently consumed");
}
if (contract.runState?.awaitingUserInputSchema?.allow_free_text !== true) {
  errors.push("runtime-contract runState.awaitingUserInputSchema must require allow_free_text true");
}
if (!contract.runState?.awaitingUserInputSchema?.options?.includes("1-3")) {
  errors.push("runtime-contract runState.awaitingUserInputSchema must document 1-3 blocker options");
}
if (!contract.stepResultSchema?.optional?.includes("blocker_question")) {
  errors.push("runtime-contract stepResultSchema.optional must include blocker_question");
}
if (!contract.stepResultSchema?.blockerQuestionRule?.includes("1-3") ||
  !contract.stepResultSchema?.blockerQuestionRule?.includes("allow_free_text: true")) {
  errors.push("runtime-contract stepResultSchema.blockerQuestionRule must define 1-3 options and allow_free_text: true");
}
if (!contract.contextMaterialization?.userInputRule?.includes("USER-INPUT.jsonl")) {
  errors.push("runtime-contract contextMaterialization.userInputRule must document USER-INPUT.jsonl");
}
if (providerPricingConfig.schema !== "aipi.provider-pricing.v1") {
  errors.push("templates/.aipi/provider-pricing.json must use schema aipi.provider-pricing.v1");
}
if (!providerPricingConfig.rates || typeof providerPricingConfig.rates !== "object") {
  errors.push("templates/.aipi/provider-pricing.json must define rates object");
}
if (!Object.hasOwn(providerPricingConfig, "checked_at") || !Object.hasOwn(providerPricingConfig, "source_url")) {
  errors.push("templates/.aipi/provider-pricing.json must expose checked_at and source_url metadata");
}
if (!Number.isFinite(providerPricingConfig.max_age_days)) {
  errors.push("templates/.aipi/provider-pricing.json must define numeric max_age_days");
}
if (!providerPricingConfig.rule?.includes("source_url") || !providerPricingConfig.rule?.includes("checked_at")) {
  errors.push("templates/.aipi/provider-pricing.json rule must require source_url and checked_at");
}
if (providerBudgetConfig.schema !== "aipi.provider-budget.v1") {
  errors.push("templates/.aipi/provider-budget.json must use schema aipi.provider-budget.v1");
}
if (providerBudgetConfig.enabled !== false) {
  errors.push("templates/.aipi/provider-budget.json must be disabled by default");
}
if (!providerBudgetConfig.default || typeof providerBudgetConfig.default !== "object") {
  errors.push("templates/.aipi/provider-budget.json must define default budget object");
}
if (modelCapabilitiesConfig.schema !== "aipi.model-capabilities.v1") {
  errors.push("templates/.aipi/model-capabilities.json must use schema aipi.model-capabilities.v1");
}
if (!modelCapabilitiesConfig.classes || typeof modelCapabilitiesConfig.classes !== "object") {
  errors.push("templates/.aipi/model-capabilities.json must define classes object");
}
if (!modelCapabilitiesConfig.models || typeof modelCapabilitiesConfig.models !== "object") {
  errors.push("templates/.aipi/model-capabilities.json must define models object");
}
for (const modelClass of templateModelClassIds) {
  const binding = modelCapabilitiesConfig.classes?.[modelClass];
  if (!binding) {
    errors.push(`templates/.aipi/model-capabilities.json must bind ${modelClass} to a concrete provider/model`);
    continue;
  }
  const modelKey = typeof binding === "string"
    ? binding.replace("/", ":")
    : `${binding.provider ?? binding.family}:${binding.id ?? binding.model ?? binding.name}`;
  if (!modelCapabilitiesConfig.models?.[modelKey]) {
    errors.push(`templates/.aipi/model-capabilities.json binding ${modelClass} must have model capabilities for ${modelKey}`);
  }
}
if (mcpConfig.schema !== "aipi.mcp.v1") {
  errors.push("templates/.aipi/mcp.json must use schema aipi.mcp.v1");
}
if (!mcpConfig.mcpServers?.linear || mcpConfig.mcpServers.linear.command !== "npx") {
  errors.push("templates/.aipi/mcp.json must include disabled Linear mcp-remote example");
}
if (mcpConfig.mcpServers?.linear?.disabled !== true) {
  errors.push("templates/.aipi/mcp.json Linear example must be disabled by default");
}
if (!mcpConfig.mcpServers?.linear?.args?.includes("https://mcp.linear.app/mcp")) {
  errors.push("templates/.aipi/mcp.json Linear example must point at https://mcp.linear.app/mcp");
}
if (contract.modelRouting?.modelClassesPath !== ".aipi/model-classes.yaml") {
  errors.push("runtime-contract modelRouting.modelClassesPath must be .aipi/model-classes.yaml");
}
if (contract.modelRouting?.modelCapabilitiesPath !== ".aipi/model-capabilities.json") {
  errors.push("runtime-contract modelRouting.modelCapabilitiesPath must be .aipi/model-capabilities.json");
}
if (contract.modelRouting?.readinessCheck !== "model.capability_floors") {
  errors.push("runtime-contract modelRouting.readinessCheck must be model.capability_floors");
}
if (!contract.modelRouting?.capabilityFloorRule?.includes("Missing mappings")) {
  errors.push("runtime-contract modelRouting.capabilityFloorRule must document missing mappings as blockers");
}
if (!contract.modelRouting?.hostFallbackRule?.includes("ctx.model") ||
  !contract.modelRouting?.hostFallbackRule?.includes("model_select") ||
  !contract.modelRouting?.hostFallbackRule?.includes("ctx.getModel") ||
  !contract.modelRouting?.hostFallbackRule?.includes("allow_fallback:false") ||
  !contract.modelRouting?.hostFallbackRule?.includes("not the host-default sentinel")) {
  errors.push("runtime-contract modelRouting.hostFallbackRule must document ctx.model fallback, strict mode, and real model_resolved provenance");
}
if (contract.codeGraph?.manifestPath !== ".aipi/state/aipi-graph.json") {
  errors.push("runtime-contract codeGraph.manifestPath must be .aipi/state/aipi-graph.json");
}
if (contract.codeGraph?.sqlitePath !== ".aipi/state/aipi-graph.sqlite") {
  errors.push("runtime-contract codeGraph.sqlitePath must be .aipi/state/aipi-graph.sqlite");
}
if (contract.codeGraph?.source !== "sqlite+sqlite-vec+lexical") {
  errors.push("runtime-contract codeGraph.source must be sqlite+sqlite-vec+lexical");
}
if (contract.codeGraph?.vectorStatus !== "implemented_optional_sqlite_vec_extension_with_ollama_embeddings") {
  errors.push("runtime-contract codeGraph.vectorStatus must mark sqlite-vec plus Ollama embeddings implemented as optional");
}
if (contract.codeGraph?.vectorDimensions !== 1024) {
  errors.push("runtime-contract codeGraph.vectorDimensions must be 1024");
}
if (contract.codeGraph?.semanticConfigPath !== ".aipi/semantic-memory.json") {
  errors.push("runtime-contract codeGraph.semanticConfigPath must be .aipi/semantic-memory.json");
}
if (contract.codeGraph?.embeddingBackend !== "ollama" || contract.codeGraph?.embeddingModel !== "bge-m3") {
  errors.push("runtime-contract codeGraph must document Ollama bge-m3 embeddings");
}
if (contract.codeGraph?.relationshipStatus !== "implemented_rebuildable_edges") {
  errors.push("runtime-contract codeGraph.relationshipStatus must mark rebuildable edges implemented");
}
for (const relation of [
  "defines",
  "test_covers",
  "mentions_file",
  "mentions_symbol",
  "business_rule_impacts_code",
  "business_rule_conflicts",
  "bdd_contract_impacts_code",
  "deployment_impacts_code",
  "run_references_rule",
  "run_verifies_rule",
  "run_fails_rule",
  "run_blocks_rule",
  "run_skips_rule",
  "run_outcome_impacts_code",
]) {
  if (!contract.codeGraph?.relationshipKinds?.includes(relation)) {
    errors.push(`runtime-contract codeGraph.relationshipKinds must include ${relation}`);
  }
}
if (!contract.codeGraph?.rule?.includes("run outcome summaries")) {
  errors.push("runtime-contract codeGraph.rule must document run outcome summaries");
}
if (!contract.codeGraph?.rule?.includes("bge-m3") ||
  !contract.codeGraph?.rule?.includes("semantic memory is OFF") ||
  !contract.codeGraph?.rule?.includes("Semantic-only search fails loudly") ||
  !contract.codeGraph?.rule?.includes("lexical fallback")) {
  errors.push("runtime-contract codeGraph.rule must document Ollama/bge-m3 semantic failure, loud readiness, and lexical fallback");
}

const backendOptions = contract.subagentBackendOptions;
if (!backendOptions) {
  errors.push("runtime-contract missing subagentBackendOptions");
} else {
  const spawnBackends = new Set(backendOptions.spawnBackends ?? []);
  const coordinationTransports = new Set(backendOptions.coordinationTransports ?? []);
  const removedWorkerBackends = [
    ["rpc", "worker", "process"].join("_"),
    ["per", "worker", "worktree"].join("_"),
    "external",
    "container",
    "aipi-agent-session",
    ["single", "worktree", "owned", "files"].join("_"),
  ];
  if (!spawnBackends.size) {
    errors.push("runtime-contract subagentBackendOptions.spawnBackends is empty");
  }
  if (!spawnBackends.has(backendOptions.preferredSpike)) {
    errors.push(`runtime-contract preferredSpike ${backendOptions.preferredSpike} is not in spawnBackends`);
  }
  if (backendOptions.preferredSpike !== "pi_subagents") {
    errors.push(`runtime-contract preferredSpike must be pi_subagents: ${backendOptions.preferredSpike}`);
  }
  if (spawnBackends.size !== 1 || !spawnBackends.has("pi_subagents")) {
    errors.push("runtime-contract subagentBackendOptions.spawnBackends must contain only pi_subagents");
  }
  for (const backend of backendOptions.spawnBackends ?? []) {
    if (backend.includes(badSubagentPackageName)) {
      errors.push(`runtime-contract references obsolete fabricated backend name: ${backend}`);
    }
    if (removedWorkerBackends.includes(backend)) {
      errors.push(`runtime-contract must not list removed worker backend: ${backend}`);
    }
  }
  for (const transport of coordinationTransports) {
    if (spawnBackends.has(transport)) {
      errors.push(`runtime-contract lists coordination transport as spawn backend: ${transport}`);
    }
  }
  if ([...spawnBackends].some((backend) => backend.includes("messenger") || backend.includes("teams"))) {
    errors.push("runtime-contract spawnBackends must not include team or messenger transports");
  }
  if (!backendOptions.criterionZero?.includes("Probe A")) {
    errors.push("runtime-contract subagentBackendOptions.criterionZero must record Probe A result");
  }
  if (!backendOptions.criterionZero?.includes("forked pi-subagents runtime") ||
    !backendOptions.criterionZero?.includes("Anthropic OAuth") ||
    !backendOptions.criterionZero?.includes("no-shell worker policy")) {
    errors.push("runtime-contract subagentBackendOptions.criterionZero must document forked pi-subagents, Anthropic OAuth, and no-shell policy");
  }
  if (backendOptions.eventEntry !== "aipi.subagents.event") {
    errors.push("runtime-contract subagentBackendOptions.eventEntry must be aipi.subagents.event");
  }
  if (!backendOptions.budgetRule?.includes("budget_timeout")) {
    errors.push("runtime-contract subagentBackendOptions.budgetRule must document budget_timeout");
  }
  if (!backendOptions.budgetRule?.includes("max_tool_calls") || !backendOptions.budgetRule?.includes("budget_max_tool_calls")) {
    errors.push("runtime-contract subagentBackendOptions.budgetRule must document max_tool_calls enforcement");
  }
  if (!backendOptions.toolTraceRule?.includes("tool_call_count")) {
    errors.push("runtime-contract subagentBackendOptions.toolTraceRule must document tool_call_count traces");
  }
  if (!backendOptions.lifecycleTraceRule?.includes("aipi_forked_subagent_start") ||
    !backendOptions.lifecycleTraceRule?.includes("aipi_forked_subagent_end") ||
    !backendOptions.lifecycleTraceRule?.includes("worker_prompt_start") ||
    !backendOptions.lifecycleTraceRule?.includes("worker_cleanup")) {
    errors.push("runtime-contract subagentBackendOptions.lifecycleTraceRule must document forked subagent start/end, prompt, and cleanup traces");
  }
  if (!backendOptions.workerProviderRule?.includes("host Pi runtime") ||
    !backendOptions.workerProviderRule?.includes("fallbackModels") ||
    !backendOptions.workerProviderRule?.includes("bedrock") ||
    !backendOptions.workerProviderRule?.includes("owned-file allocation") ||
    !backendOptions.workerProviderRule?.includes("guarded write extension") ||
    !backendOptions.workerProviderRule?.includes("not the unguarded builtin write")) {
    errors.push("runtime-contract subagentBackendOptions.workerProviderRule must document host Pi runtime, fallback stripping, bedrock rejection, pre-allocation rejection, and guarded child write");
  }
  if (!backendOptions.hostModelFallbackRule?.includes("ctx.model") ||
    !backendOptions.hostModelFallbackRule?.includes("model_select") ||
    !backendOptions.hostModelFallbackRule?.includes("getHostModel") ||
    !backendOptions.hostModelFallbackRule?.includes("allow_fallback:false") ||
    !backendOptions.hostModelFallbackRule?.includes("model_resolved") ||
    !backendOptions.hostModelFallbackRule?.includes("real host model id")) {
    errors.push("runtime-contract subagentBackendOptions.hostModelFallbackRule must document ctx.model fallback and strict provenance");
  }
  if (!backendOptions.piSubagentsPhaseOneRule?.includes("extensions/aipi/runtime/vendor/pi-subagents") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("runtime/pi-subagents.js") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("not a dependency or optionalDependency") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("no separately-loaded pi-subagents extension") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("no backend-selection environment flag") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes(".aipi/runtime/subagents") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("AIPI_SUBAGENTS_OWNED_FILES") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("aipi-guarded-write-child.js") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("jiti@2.7.0") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("typebox@1.2.16") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("@earendil-works/pi-tui is not a direct AIPI dependency") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("/aipi-pi-subagents-spike") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("provider_event_observed=true") ||
    !backendOptions.piSubagentsPhaseOneRule?.includes("no bedrock/non-host provider")) {
    errors.push("runtime-contract subagentBackendOptions.piSubagentsPhaseOneRule must document the forked runtime, no npm package, no separate extension/flag, project runtime root, minimized deps, live command, and GO/NO-GO criteria");
  }
  if (!backendOptions.stableToolSurface?.includes("aipi_cleanup_agents")) {
    errors.push("runtime-contract subagentBackendOptions.stableToolSurface must include aipi_cleanup_agents");
  }
  if (!backendOptions.cleanupRule?.includes("aipi.subagents.cleanup.v1") || !backendOptions.cleanupRule?.includes("never deletes durable")) {
    errors.push("runtime-contract subagentBackendOptions.cleanupRule must document cleanup schema and durable-memory safety");
  }
  if (!backendOptions.steeringRule?.includes("accepted=false")) {
    errors.push("runtime-contract subagentBackendOptions.steeringRule must document accepted=false");
  }
  if (!backendOptions.redispatchRule?.includes("coordinator.dispatch")) {
    errors.push("runtime-contract subagentBackendOptions.redispatchRule must document coordinator.dispatch");
  }
}
if (read("templates/.aipi/runtime-contract.json").includes(badSubagentPackageName)) {
  errors.push("runtime-contract references obsolete fabricated package name");
}
if (contract.isolationModel?.v1 !== "pi_subagents") {
  errors.push("runtime-contract isolationModel.v1 must be pi_subagents");
}
if (contract.isolationModel?.singleWorkerRuntime !== "pi_subagents") {
  errors.push("runtime-contract isolationModel.singleWorkerRuntime must be pi_subagents");
}
if (contract.isolationModel?.projectRuntimeRoot !== ".aipi/runtime/subagents") {
  errors.push("runtime-contract isolationModel.projectRuntimeRoot must be .aipi/runtime/subagents");
}
if (
  !contract.isolationModel?.failClosedRule?.includes("reject") ||
  !contract.isolationModel?.failClosedRule?.includes("pi_subagents") ||
  !contract.isolationModel?.failClosedRule?.includes("project root")
) {
  errors.push("runtime-contract isolationModel.failClosedRule must require rejecting unsupported isolation and project-root cwd");
}
const deniedSingleWorktreeTools = new Set(
  contract.workerToolPolicy?.singleWorktreeSessionAgents?.denyTools ?? [],
);
if (!deniedSingleWorktreeTools.has("bash")) {
  errors.push("runtime-contract workerToolPolicy.singleWorktreeSessionAgents.denyTools must include bash");
}
if (contract.workerToolPolicy?.singleWorktreeSessionAgents?.unknownToolDefault !== "BLOCK") {
  errors.push("runtime-contract workerToolPolicy.singleWorktreeSessionAgents.unknownToolDefault must be BLOCK");
}
if (contract.profilePolicy) {
  errors.push("runtime-contract must not define the removed permission-profile block");
}
if (fs.existsSync(path.join(root, "templates", ".aipi", removedProfileTemplate))) {
  errors.push("removed permission-profile template must not be shipped");
}
if (validPolicyDecisions.has(removedPolicyDecision)) {
  errors.push("runtime-contract must not include the removed approval decision");
}
for (const hook of [
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_before_tree",
  "session_compact",
  "session_tree",
  "input",
  "context",
  "agent_end",
  "turn_end",
  "message_end",
  "model_select",
  "thinking_level_select",
  "user_bash",
  "tool_result",
  "before_provider_request",
  "after_provider_response",
]) {
  if (!lifecycleHooks.verifiedHooks?.includes(hook)) {
    errors.push(`runtime-contract lifecycleHooks.verifiedHooks missing ${hook}`);
  }
}
if (lifecycleHooks.implementationPath !== "extensions/aipi/runtime/lifecycle-hooks.js") {
  errors.push("runtime-contract lifecycleHooks.implementationPath must point at runtime/lifecycle-hooks.js");
}
for (const field of ["lifecycleLog", "contextEventLog", "disciplineAuditLog", "subagentRestoreEntry", "inputRouteEntry", "toolResultLog", "modelRoutingLog", "providerEventLog", "providerUsageLog", "providerBudgetLog", "providerPricingConfig", "providerBudgetConfig", "handoffArtifact", "providerPayloadPolicy", "compactionSummarySchema"]) {
  if (!lifecycleHooks[field]) {
    errors.push(`runtime-contract lifecycleHooks.${field} is required`);
  }
}
const promptOnlyHooks = new Map((lifecycleHooks.declaredPromptOnlyHooks ?? []).map((item) => [item?.hook, item]));
const runtimeHooksProtocol = read("templates/.aipi/protocols/runtime-hooks.md");
for (const hook of ["agent_end", "turn_end", "message_end"]) {
  if (promptOnlyHooks.has(hook)) {
    errors.push(`runtime-contract lifecycleHooks.declaredPromptOnlyHooks must not include implemented hook ${hook}`);
  }
  if (!lifecycleHooks.verifiedHooks?.includes(hook)) {
    errors.push(`runtime-contract lifecycleHooks.verifiedHooks missing implemented end hook ${hook}`);
  }
  if (!runtimeHooksProtocol.includes(`| \`${hook}\` | registered |`)) {
    errors.push(`runtime-hooks.md must document ${hook} as registered`);
  }
}
if (!lifecycleHooks.rule?.includes("message_end blocking unsupported")) {
  errors.push("runtime-contract lifecycleHooks.rule must document message_end claim-evidence audit");
}

for (const rel of [
  "docs/adversarial-remediation.md",
  "docs/pi-runtime-gates-hooks-map.md",
  "docs/pi-subagent-build-plan.md",
  "docs/pi-swarm-package-evaluation.md",
  "templates/.aipi/protocols/parallelism.md",
]) {
  if (read(rel).includes(badSubagentPackageName)) {
    errors.push(`${rel} references obsolete fabricated package name`);
  }
}

for (const [rel, requiredText] of [
  ["docs/adversarial-remediation.md", "aipi-agent-session"],
  ["docs/pi-runtime-gates-hooks-map.md", "Probe A' returned `IN_PROCESS_VIABLE`"],
  ["docs/pi-swarm-package-evaluation.md", "Build the default write-capable backend as AIPI-owned `aipi-agent-session`"],
  ["docs/pi-subagent-build-plan.md", "Probe A' closed criterion zero"],
  ["docs/probe-a-prime-in-process-enforcement.md", "v1 write-worker backend: **`aipi-agent-session`**"],
]) {
  if (!read(rel).includes(requiredText)) {
    errors.push(`${rel} must document the Probe A' aipi-agent-session backend decision`);
  }
}

for (const [rel, staleText] of [
  ["docs/adversarial-remediation.md", "Preferred backend moved to `aipi-rpc-worker`"],
  ["docs/pi-runtime-gates-hooks-map.md", "`aipi-rpc-worker` is the first write-capable backend"],
  ["docs/pi-runtime-gates-hooks-map.md", "write-capable backend is now `aipi-rpc-worker`"],
  ["docs/pi-swarm-package-evaluation.md", "Build the first write-capable backend as AIPI-owned `aipi-rpc-worker`"],
  ["docs/pi-swarm-package-evaluation.md", "`aipi-agent-session` unsafe for parallel write workers"],
  ["docs/pi-swarm-package-evaluation.md", "the spike starts at the RPC worker boundary"],
]) {
  if (read(rel).includes(staleText)) {
    errors.push(`${rel} still contains stale RPC-first backend wording: ${staleText}`);
  }
}
const staleGraphDbName = "aipi-graph" + ".db";
for (const rel of [
  "templates/.aipi/protocols/markdown-brain.md",
  "templates/.aipi/protocols/memory-promotion.md",
  "docs/aipi-agent-workflow-port.md",
  "docs/aihaus-flow-pkg-port-plan.md",
]) {
  if (read(rel).includes(staleGraphDbName)) {
    errors.push(`${rel} must reference aipi-graph.json and aipi-graph.sqlite, not stale ${staleGraphDbName}`);
  }
}

function parseAgentCatalog(text) {
  const agents = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^  - id: ([a-z0-9-]+)$/);
    if (id) {
      current = { id: id[1], stages: [] };
      agents.set(current.id, current);
      continue;
    }
    if (!current) continue;
    const stages = line.match(/^    stages: (\[.*\])$/);
    if (stages) current.stages = parseInlineList(stages[1]);
    const tools = line.match(/^    tools: (\[.*\])$/);
    if (tools) current.tools = parseInlineList(tools[1]);
    const roleType = line.match(/^    role_type: ([a-z0-9_-]+)$/);
    if (roleType) current.role_type = roleType[1];
    const role = line.match(/^    role: ([a-z0-9-]+)$/);
    if (role) current.role = role[1];
    const runtime = line.match(/^    runtime: ([a-z0-9_-]+)$/);
    if (runtime) current.runtime = runtime[1];
  }
  return agents;
}

function parseAgentRoleDisciplines(text) {
  const roleDisciplines = new Map();
  let inRoleDisciplines = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^  role_disciplines:\s*$/.test(line)) {
      inRoleDisciplines = true;
      continue;
    }
    if (inRoleDisciplines && line.trim() && !/^    /.test(line)) {
      inRoleDisciplines = false;
    }
    if (!inRoleDisciplines) continue;
    const role = line.match(/^    ([a-z0-9-]+): (\[.*\])$/);
    if (role) roleDisciplines.set(role[1], parseInlineList(role[2]));
  }
  return roleDisciplines;
}

function parseDisciplineCatalog(text) {
  const activations = [];
  const disciplines = new Map();
  let section = null;
  let currentActivation = null;
  let currentDiscipline = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === "activation:") {
      section = "activation";
      currentActivation = null;
      currentDiscipline = null;
      continue;
    }
    if (line === "disciplines:") {
      section = "disciplines";
      currentActivation = null;
      currentDiscipline = null;
      continue;
    }
    if (section === "activation") {
      const moment = line.match(/^  ([a-z0-9_-]+):$/);
      if (moment) {
        currentActivation = { moment: moment[1], disciplines: [], pi_hooks: [] };
        activations.push(currentActivation);
        continue;
      }
      const listValue = line.match(/^    ([a-z_]+): (\[.*\])$/);
      if (currentActivation && listValue) currentActivation[listValue[1]] = parseInlineList(listValue[2]);
      continue;
    }
    if (section === "disciplines") {
      const id = line.match(/^  - id: ([a-z0-9-]+)$/);
      if (id) {
        currentDiscipline = { id: id[1], status: null, file: null, applies_to: [] };
        disciplines.set(currentDiscipline.id, currentDiscipline);
        continue;
      }
      const scalar = line.match(/^    ([a-z_]+): (.+)$/);
      if (currentDiscipline && scalar) {
        if (scalar[1] === "applies_to") currentDiscipline.applies_to = parseInlineList(scalar[2]);
        else currentDiscipline[scalar[1]] = scalar[2];
      }
    }
  }
  return { activations, disciplines };
}

function parseWorkflow(rel, text) {
  const workflow = {
    rel,
    mode: null,
    steps: [],
  };
  let current = null;
  let section = null;
  let gateSubsection = null;

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const lineNo = index + 1;
    if (/^\t/.test(line)) {
      errors.push(`${rel}:${lineNo} uses tabs; templates require spaces`);
    }

    const mode = line.match(/^mode: ([a-z0-9-]+)$/);
    if (mode) workflow.mode = mode[1];

    const step = line.match(/^  - id: ([a-z0-9_-]+)$/);
    if (step) {
      current = {
        id: step[1],
        lineNo,
        agents: [],
        produces: [],
        controller_updates: [],
        requires: [],
        context_from: [],
        gate: {
          on_verdict: {},
          on_policy_decision: {},
        },
      };
      workflow.steps.push(current);
      section = null;
      gateSubsection = null;
      continue;
    }

    if (!current) continue;

    const keyValue = line.match(/^    ([a-z_]+): (.+)$/);
    if (keyValue) {
      const [, key, value] = keyValue;
      section = null;
      gateSubsection = null;
      if (key === "stage") current.stage = value;
      if (key === "agents") current.agents = parseInlineList(value);
      if (key === "requires") current.requires = parseInlineList(value);
      if (key === "context_from") current.context_from = parseInlineList(value);
      continue;
    }

    const sectionStart = line.match(/^    ([a-z_]+):\s*$/);
    if (sectionStart) {
      section = sectionStart[1];
      gateSubsection = null;
      continue;
    }

    const listItem = line.match(/^      - (.+)$/);
    if (listItem && section) {
      if (section === "produces") current.produces.push(listItem[1]);
      if (section === "controller_updates") current.controller_updates.push(listItem[1]);
      continue;
    }

    if (section === "gate") {
      const gateList = line.match(/^      ([a-z_]+): (\[.*\])$/);
      if (gateList) {
        current.gate[gateList[1]] = parseInlineList(gateList[2]);
        gateSubsection = null;
        continue;
      }

      const gateScalar = line.match(/^      ([a-z_]+): ([^\s].*)$/);
      if (gateScalar) {
        const [, key, value] = gateScalar;
        if (value === "true") current.gate[key] = true;
        else if (value === "false") current.gate[key] = false;
        else if (/^\d+$/.test(value)) current.gate[key] = Number(value);
        else current.gate[key] = value;
        gateSubsection = null;
        continue;
      }

      const gateSection = line.match(/^      ([a-z_]+):\s*$/);
      if (gateSection) {
        gateSubsection = gateSection[1];
        if (!current.gate[gateSubsection]) current.gate[gateSubsection] = {};
        continue;
      }

      const nested = line.match(/^        ([A-Z_]+|[a-z_]+): ([a-zA-Z0-9_-]+)$/);
      if (nested && gateSubsection) {
        current.gate[gateSubsection][nested[1]] = nested[2];
      }
    }
  }

  return workflow;
}

const agentCatalogText = read("templates/.aipi/agents/catalog.yaml");
const agents = parseAgentCatalog(agentCatalogText);
const agentRoleDisciplines = parseAgentRoleDisciplines(agentCatalogText);
const validDisciplineRoles = new Set([
  "orchestrator",
  "planner",
  "researcher",
  "context",
  "reviewer",
  "implementer",
  "tester",
  "fixer",
  "frontend",
  "verifier",
  "ops",
  "human-review",
  "business-rule-keeper",
]);
const referencedAipiTools = new Set();
for (const agent of agents.values()) {
  if (!agent.runtime) {
    errors.push(`agents/catalog.yaml agent ${agent.id} is missing runtime`);
  } else if (!validAgentRuntimes.has(agent.runtime)) {
    errors.push(`agents/catalog.yaml agent ${agent.id} uses unknown runtime: ${agent.runtime}`);
  }
  if (!agent.role) {
    errors.push(`agents/catalog.yaml agent ${agent.id} is missing role`);
  } else if (!validDisciplineRoles.has(agent.role)) {
    errors.push(`agents/catalog.yaml agent ${agent.id} uses unknown role: ${agent.role}`);
  }

  for (const stage of agent.stages) {
    if (!validStages.has(stage)) {
      errors.push(`agents/catalog.yaml agent ${agent.id} uses unknown stage: ${stage}`);
    }
  }

  if (contract.isolationModel?.v1 === "pi_subagents" && agent.runtime === "session") {
    for (const tool of agent.tools ?? []) {
      if (deniedSingleWorktreeTools.has(tool)) {
        errors.push(`agents/catalog.yaml session agent ${agent.id} cannot use ${tool} under pi_subagents`);
      }
    }
  }

  for (const tool of agent.tools ?? []) {
    if (/^aipi_[a-z0-9_]+$/.test(tool)) referencedAipiTools.add(tool);
  }
}

const toolSurface = contract.aipiToolSurface ?? {};
const implementedAipiTools = uniqueValues(
  "runtime-contract aipiToolSurface.implemented",
  toolSurface.implemented ?? [],
);
const specificationOnlyAipiTools = uniqueValues(
  "runtime-contract aipiToolSurface.specificationOnly",
  toolSurface.specificationOnly ?? [],
);
const registeredToolSources = [
  "extensions/aipi/runtime/subagents.js",
  "extensions/aipi/runtime/aipi-tools.js",
]
  .filter((rel) => fs.existsSync(path.join(root, rel)))
  .map((rel) => read(rel))
  .join("\n");
const registeredAipiTools = new Set(
  [...registeredToolSources.matchAll(/name:\s*"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((name) => /^aipi_[a-z0-9_]+$/.test(name)),
);
for (const tool of implementedAipiTools) {
  if (specificationOnlyAipiTools.has(tool)) {
    errors.push(`runtime-contract marks ${tool} as both implemented and specification-only`);
  }
  if (!registeredAipiTools.has(tool)) {
    errors.push(`runtime-contract marks ${tool} implemented, but no runtime registerTool name was found`);
  }
}
for (const tool of registeredAipiTools) {
  if (!implementedAipiTools.has(tool)) {
    errors.push(`runtime registered ${tool}, but runtime-contract aipiToolSurface.implemented does not list it`);
  }
}
for (const tool of referencedAipiTools) {
  if (!implementedAipiTools.has(tool) && !specificationOnlyAipiTools.has(tool)) {
    errors.push(`agents/catalog.yaml references ${tool}, but it is neither implemented nor marked specification-only`);
  }
}
for (const tool of contract.subagentBackendOptions?.stableToolSurface ?? []) {
  if (!implementedAipiTools.has(tool)) {
    errors.push(`runtime-contract stableToolSurface includes ${tool}, but aipiToolSurface.implemented does not`);
  }
}

for (const workflowPath of list("templates/.aipi/workflows", ".yaml")) {
  const text = read(workflowPath);
  const workflow = parseWorkflow(workflowPath, text);

  if (text.includes("content-heuristic")) {
    errors.push(`${workflowPath} still uses content-heuristic`);
  }
  if (workflow.mode !== "workflow-contract-v1") {
    errors.push(`${workflowPath} must use mode: workflow-contract-v1`);
  }
  if (/run_id:\s*active/.test(text)) {
    errors.push(`${workflowPath} defaults run_id to active`);
  }
  if (text.includes("/runs/active/")) {
    errors.push(`${workflowPath} contains a runs/active write path`);
  }
  if ([
    "templates/.aipi/workflows/feature.yaml",
    "templates/.aipi/workflows/planning.yaml",
    "templates/.aipi/workflows/bugfix.yaml",
    "templates/.aipi/workflows/ops.yaml",
  ].includes(workflowPath)) {
    for (const requiredText of ["blocker_question", "1-3", "allow_free_text: true", "free-text"]) {
      if (!text.includes(requiredText)) {
        errors.push(`${workflowPath} must instruct user-decision blockers to emit ${requiredText}`);
      }
    }
  }

  const stepIds = new Set(workflow.steps.map((step) => step.id));
  const produced = [];

  for (const step of workflow.steps) {
    if (!step.stage) errors.push(`${workflowPath} step ${step.id} has no stage`);
    if (step.stage && !validStages.has(step.stage)) {
      errors.push(`${workflowPath} step ${step.id} uses unknown stage ${step.stage}`);
    }

    if (!step.agents.length) errors.push(`${workflowPath} step ${step.id} has no agents`);
    for (const id of step.agents) {
      const agent = agents.get(id);
      if (!agent) {
        errors.push(`${workflowPath} step ${step.id} references unknown agent ${id}`);
        continue;
      }
      if (step.stage && !agent.stages.includes("any") && !agent.stages.includes(step.stage)) {
        errors.push(`${workflowPath} step ${step.id} assigns agent ${id} to unsupported stage ${step.stage}`);
      }
    }

    for (const ref of [...step.requires, ...step.context_from]) {
      if (!stepIds.has(ref)) {
        errors.push(`${workflowPath} step ${step.id} references unknown prior step ${ref}`);
      }
      if (ref === step.id) {
        errors.push(`${workflowPath} step ${step.id} references itself`);
      }
    }

    if (!step.gate?.schema) {
      errors.push(`${workflowPath} step ${step.id} has no structured gate schema`);
    } else if (step.gate.schema !== contract.stepResultSchema.id) {
      errors.push(`${workflowPath} step ${step.id} uses unknown gate schema ${step.gate.schema}`);
    }

    for (const verdict of step.gate.pass_verdicts ?? []) {
      if (!validVerdicts.has(verdict)) errors.push(`${workflowPath} step ${step.id} uses unknown pass_verdict ${verdict}`);
      if (!["PASS", "SKIPPED"].includes(verdict)) {
        errors.push(`${workflowPath} step ${step.id} pass_verdicts may only include PASS or SKIPPED`);
      }
    }
    if (step.gate.allow_skip === true && !(step.gate.pass_verdicts ?? []).includes("SKIPPED")) {
      errors.push(`${workflowPath} step ${step.id} allows skip but pass_verdicts does not include SKIPPED`);
    }
    if (step.gate.allow_skip !== true && (step.gate.pass_verdicts ?? []).includes("SKIPPED")) {
      errors.push(`${workflowPath} step ${step.id} declares SKIPPED pass_verdict without allow_skip`);
    }

    for (const key of ["pass_decisions", "approval_decisions", "block_decisions"]) {
      for (const decision of step.gate[key] ?? []) {
        if (!validPolicyDecisions.has(decision)) {
          errors.push(`${workflowPath} step ${step.id} uses unknown ${key} ${decision}`);
        }
      }
    }

    if (step.gate.require_evidence_rung && !validEvidenceRungs.has(step.gate.require_evidence_rung)) {
      errors.push(`${workflowPath} step ${step.id} uses unknown evidence rung ${step.gate.require_evidence_rung}`);
    }

    if (step.gate.skip_requires && !skipConditions.has(step.gate.skip_requires)) {
      errors.push(`${workflowPath} step ${step.id} uses unknown skip_requires ${step.gate.skip_requires}`);
    }
    if (step.gate.skip_requires && step.gate.allow_skip !== true) {
      errors.push(`${workflowPath} step ${step.id} declares skip_requires but allow_skip is not true`);
    }
    if (step.gate.allow_skip === true && !step.gate.skip_requires) {
      errors.push(`${workflowPath} step ${step.id} allows skip without skip_requires`);
    }

    for (const [verdict, target] of Object.entries(step.gate.on_verdict ?? {})) {
      if (!validVerdicts.has(verdict)) {
        errors.push(`${workflowPath} step ${step.id} branches on unknown verdict ${verdict}`);
      }
      if (!stepIds.has(target) && !terminalActions.has(target)) {
        errors.push(`${workflowPath} step ${step.id} has unresolved on_verdict target ${target}`);
      }
    }

    for (const [decision, target] of Object.entries(step.gate.on_policy_decision ?? {})) {
      if (!validPolicyDecisions.has(decision)) {
        errors.push(`${workflowPath} step ${step.id} branches on unknown policy decision ${decision}`);
      }
      if (!stepIds.has(target) && !terminalActions.has(target)) {
        errors.push(`${workflowPath} step ${step.id} has unresolved on_policy_decision target ${target}`);
      }
    }

    for (const artifact of step.produces) {
      produced.push(artifact);
      const basename = path.basename(artifact);
      if (sharedArtifacts.has(basename)) {
        errors.push(`${workflowPath} step ${step.id} lists shared artifact ${basename} under produces; use controller_updates`);
      }
    }
  }

  const duplicates = produced.filter((item, index) => produced.indexOf(item) !== index);
  for (const duplicate of new Set(duplicates)) {
    errors.push(`${workflowPath} duplicates artifact path ${duplicate}`);
  }
}

const disciplineCatalog = read("templates/.aipi/disciplines/catalog.yaml");
const parsedDisciplineCatalog = parseDisciplineCatalog(disciplineCatalog);
const runtimeHooksDoc = read("templates/.aipi/protocols/runtime-hooks.md");
for (const requiredText of [
  "Runtime status",
  "registered | Runtime audit of user-facing claims",
  "registered for discipline audit only",
  "permission policy and profiles were intentionally removed",
]) {
  if (!runtimeHooksDoc.includes(requiredText)) {
    errors.push(`runtime-hooks.md must document hook runtime status: ${requiredText}`);
  }
}
const validPiHooks = new Set([...runtimeHooksDoc.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]));
const agentRoles = new Set([...agents.values()].map((agent) => agent.role).filter(Boolean));
for (const role of agentRoles) {
  if (!agentRoleDisciplines.has(role) || !agentRoleDisciplines.get(role).length) {
    errors.push(`agents/catalog.yaml role_disciplines must declare at least one discipline for role ${role}`);
  }
}
for (const [role, disciplineIds] of agentRoleDisciplines.entries()) {
  if (!validDisciplineRoles.has(role)) {
    errors.push(`agents/catalog.yaml role_disciplines declares unknown role ${role}`);
  }
  for (const disciplineId of disciplineIds) {
    const discipline = parsedDisciplineCatalog.disciplines.get(disciplineId);
    if (!discipline) {
      errors.push(`agents/catalog.yaml role_disciplines ${role} references unknown discipline ${disciplineId}`);
    } else if (!discipline.applies_to.includes(role)) {
      errors.push(`agents/catalog.yaml role_disciplines ${role} references discipline ${disciplineId} that does not apply to that role`);
    }
  }
}
for (const activation of parsedDisciplineCatalog.activations) {
  for (const hook of activation.pi_hooks) {
    if (!validPiHooks.has(hook)) {
      errors.push(`disciplines/catalog.yaml references unknown Pi hook ${hook}`);
    }
  }
  for (const disciplineId of activation.disciplines) {
    if (!parsedDisciplineCatalog.disciplines.has(disciplineId)) {
      errors.push(`disciplines/catalog.yaml activation ${activation.moment} references unknown discipline ${disciplineId}`);
    }
  }
}
for (const [id, discipline] of parsedDisciplineCatalog.disciplines.entries()) {
  if (!["predicted", "observed", "retired"].includes(discipline.status)) {
    errors.push(`discipline ${id} is missing status`);
  }
  if (!discipline.file) {
    errors.push(`discipline ${id} is missing file`);
  } else {
    const disciplinePath = discipline.file.replaceAll("\\", "/");
    const expectedFile = `.aipi/disciplines/${id}.md`;
    if (disciplinePath !== expectedFile) {
      errors.push(`discipline ${id} file must be ${expectedFile}, got ${discipline.file}`);
    }
    if (!fs.existsSync(path.join(root, "templates", disciplinePath))) {
      errors.push(`discipline ${id} file does not exist: ${discipline.file}`);
    }
  }
  if (!discipline.applies_to.length) {
    errors.push(`discipline ${id} must declare applies_to`);
  }
  for (const role of discipline.applies_to) {
    if (!validDisciplineRoles.has(role)) {
      errors.push(`discipline ${id} applies_to unknown role ${role}`);
    } else if (!agentRoles.has(role)) {
      errors.push(`discipline ${id} applies_to role has no matching agent role: ${role}`);
    }
  }
}
const pressureScenarios = read("templates/.aipi/evals/pressure-scenarios.md");
if (!pressureScenarios.includes("## S9 - finish-turn: reversible work left")) {
  errors.push("pressure-scenarios.md must include S9 for finish-turn");
}
if (!read("templates/.aipi/disciplines/finish-turn.md").includes("S9 - finish-turn")) {
  errors.push("finish-turn.md must reference its seed pressure scenario S9");
}
if (!read("extensions/aipi/runtime/model-pressure-scorer.js").includes('discipline: "finish-turn"')) {
  errors.push("model-pressure scorer must include a finish-turn pressure scenario");
}

const proveIt = read("templates/.aipi/disciplines/prove-it.md");
const proveItRungs = new Set([...proveIt.matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]));
for (const rung of validEvidenceRungs) {
  if (!proveItRungs.has(rung)) errors.push(`prove-it.md missing evidence rung ${rung}`);
}
for (const rung of proveItRungs) {
  if (!validEvidenceRungs.has(rung)) errors.push(`prove-it.md defines unknown evidence rung ${rung}`);
}

const defaultProfile = read("templates/.aipi/protocols/default.md");
const defaultStages = new Set(
  [...defaultProfile.matchAll(/^\| ([a-z0-9-]+) \|/gm)]
    .map((m) => m[1])
    .filter((stage) => stage !== "Stage"),
);
for (const stage of contract.canonicalStages) {
  if (!defaultStages.has(stage)) errors.push(`default.md stage table missing canonical stage ${stage}`);
}
for (const requiredText of ["allow_skip: true", "skip_requires", "pass_verdicts", ".aipi/runtime-contract.json"]) {
  if (!defaultProfile.includes(requiredText)) {
    errors.push(`default.md SKIPPED semantics must reference ${requiredText}`);
  }
}
const markdownBrain = read("templates/.aipi/protocols/markdown-brain.md");
const pageTypeLine = markdownBrain.match(/^type: (.+)$/m);
const memoryPageTypes = new Set((pageTypeLine?.[1] ?? "").split("|").map((item) => item.trim()).filter(Boolean));
for (const requiredType of ["business-rule", "decision", "knowledge", "environment", "procedure", "deployment", "glossary", "project"]) {
  if (!memoryPageTypes.has(requiredType)) {
    errors.push(`markdown-brain.md Page Shape type enum missing ${requiredType}`);
  }
}
for (const memoryPath of list("templates/.aipi/memory/project", ".md")) {
  if (path.basename(memoryPath) === "README.md") continue;
  const metadata = parseFrontmatter(read(memoryPath));
  if (!metadata) {
    errors.push(`${memoryPath} must start with Page Shape frontmatter`);
    continue;
  }
  if (!memoryPageTypes.has(metadata.type)) {
    errors.push(`${memoryPath} uses Page Shape type outside markdown-brain.md enum: ${metadata.type}`);
  }
  for (const field of ["owner", "status", "last_reviewed"]) {
    if (!Object.hasOwn(metadata, field) || !String(metadata[field]).trim()) {
      errors.push(`${memoryPath} frontmatter missing ${field}`);
    }
  }
  if (!["draft", "active", "deprecated"].includes(metadata.status)) {
    errors.push(`${memoryPath} frontmatter status must be draft, active, or deprecated`);
  }
  if (metadata.last_reviewed !== "-" && !/^\d{4}-\d{2}-\d{2}$/.test(metadata.last_reviewed)) {
    errors.push(`${memoryPath} frontmatter last_reviewed must be YYYY-MM-DD or -`);
  }
}

const extensionIndex = read("extensions/aipi/index.js");
if (!extensionIndex.includes('pi.registerCommand("aipi-init"')) {
  errors.push("extensions/aipi/index.js must register /aipi-init");
}
if (!extensionIndex.includes("./runtime/project-init.js")) {
  errors.push("extensions/aipi/index.js must load runtime/project-init.js");
}
if (!extensionIndex.includes("./runtime/provider-auth.js")) {
  errors.push("extensions/aipi/index.js must load runtime/provider-auth.js");
}
if (!extensionIndex.includes("buildAipiStatusReport")) {
  errors.push("extensions/aipi/index.js must build a real /aipi-status report");
}
if (!extensionIndex.includes("./runtime/run-state.js")) {
  errors.push("extensions/aipi/index.js must load runtime/run-state.js");
}
if (!extensionIndex.includes('pi.registerCommand("aipi-workflow"')) {
  errors.push("extensions/aipi/index.js must register /aipi-workflow");
}
if (!extensionIndex.includes('pi.registerCommand("aipi-memory"')) {
  errors.push("extensions/aipi/index.js must register /aipi-memory");
}
if (!extensionIndex.includes("./runtime/memory-command.js")) {
  errors.push("extensions/aipi/index.js must load runtime/memory-command.js");
}
if (!extensionIndex.includes('pi.registerCommand("aipi-onboard"')) {
  errors.push("extensions/aipi/index.js must register /aipi-onboard");
}
if (!extensionIndex.includes("./runtime/onboarding.js")) {
  errors.push("extensions/aipi/index.js must load runtime/onboarding.js");
}
if (!extensionIndex.includes('pi.registerCommand("aipi-diagnose"')) {
  errors.push("extensions/aipi/index.js must register /aipi-diagnose");
}
if (!extensionIndex.includes("./runtime/diagnose.js")) {
  errors.push("extensions/aipi/index.js must load runtime/diagnose.js");
}
const binWrapper = read("bin/aipi.js");
if (!binWrapper.includes("mcp-bridge.js") || !binWrapper.includes("mcp.json")) {
  errors.push("bin/aipi.js must conditionally load the MCP bridge when .aipi/mcp.json exists");
}
if (!binWrapper.includes("runAipiOnboard") || !binWrapper.includes("aipi onboard")) {
  errors.push("bin/aipi.js must expose aipi onboard outside a Pi session");
}
if (!fs.existsSync(path.join(root, "extensions/aipi/mcp-bridge.js"))) {
  errors.push("extensions/aipi/mcp-bridge.js is required for MCP bridge loading");
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/mcp-bridge.js"))) {
  errors.push("extensions/aipi/runtime/mcp-bridge.js is required for MCP bridge runtime");
} else {
  const mcpBridge = read("extensions/aipi/runtime/mcp-bridge.js");
  for (const requiredText of [
    "@modelcontextprotocol/sdk/client/index.js",
    "StdioClientTransport",
    "pi.registerCommand?.(\"aipi-mcp\"",
    "mcp__${status.sanitized_name}__${sanitizeMcpName(tool.name)}",
    "session_shutdown",
    "direct HTTP/SSE OAuth and MCP resources/prompts are deferred",
  ]) {
    if (!mcpBridge.includes(requiredText)) {
      errors.push(`runtime/mcp-bridge.js must include ${requiredText}`);
    }
  }
}
if (!extensionIndex.includes("./runtime/lifecycle-hooks.js")) {
  errors.push("extensions/aipi/index.js must load runtime/lifecycle-hooks.js");
}
if (!extensionIndex.includes("registerAipiLifecycleHooks")) {
  errors.push("extensions/aipi/index.js must register AIPI lifecycle hooks");
}
for (const removedText of [
  `./runtime/${removedProfileModule}.js`,
  `./runtime/${removedParentModule}.js`,
  removedGateRegistration,
  removedProfileCommand.replace(" ", "-"),
]) {
  if (extensionIndex.includes(removedText)) {
    errors.push(`extensions/aipi/index.js must not wire removed permission layer text: ${removedText}`);
  }
}
if (!extensionIndex.includes("registerAipiRuntimeTools")) {
  errors.push("extensions/aipi/index.js must register P3 AIPI runtime tools");
}
if (!extensionIndex.includes("createSubagentWorkflowAdapter")) {
  errors.push("extensions/aipi/index.js must pass the S0 subagent workflow adapter into /aipi-workflow");
}
if (!extensionIndex.includes("./runtime/probe-a.js")) {
  errors.push("extensions/aipi/index.js must load runtime/probe-a.js");
}
if (!extensionIndex.includes('pi.registerCommand("aipi-probe-a"')) {
  errors.push("extensions/aipi/index.js must register /aipi-probe-a");
}
if (!extensionIndex.includes("./runtime/probe-a-prime.js")) {
  errors.push("extensions/aipi/index.js must load runtime/probe-a-prime.js");
}
if (!extensionIndex.includes('pi.registerCommand("aipi-probe-a-prime"')) {
  errors.push("extensions/aipi/index.js must register /aipi-probe-a-prime");
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/step-result.js"))) {
  errors.push("extensions/aipi/runtime/step-result.js is required");
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/subagents.js"))) {
  errors.push("extensions/aipi/runtime/subagents.js is required");
} else {
  const subagentsRuntime = read("extensions/aipi/runtime/subagents.js");
  if (subagentsRuntime.includes("backend not wired")) {
    errors.push("runtime/subagents.js must not regress to an unwired spawn backend");
  }
  for (const requiredText of [
    "buildWorkerTools",
    "parseWorkerStepResult",
    "wrapWriteToolWithOwnership",
    "SUBAGENT_STATE_ENTRY",
    "SUBAGENT_EVENT_ENTRY",
    "latestSubagentStateFromEntries",
    "dispatch(descriptor)",
    "wrapToolWithTrace",
    "assertSupportedIsolation",
    "PI_SUBAGENTS_ISOLATION",
    "normalizePiSubagentsRunner",
    "assertAipiHostScopedModel",
    "aipi_forked_subagent_start",
    "aipi_forked_subagent_end",
    "runtime_root",
    "budget_max_tool_calls",
    "budget_limit_exceeded",
    "worker_prompt_start",
    "worker_prompt_end",
    "worker_cleanup",
    "currentHostModelFromContext",
    "descriptorWithResolvedModel",
    "setHostModel",
    "getHostModel",
    "host_model",
  ]) {
    if (!subagentsRuntime.includes(requiredText)) {
      errors.push(`runtime/subagents.js must wire ${requiredText} into the forked pi_subagents backend`);
    }
  }
  for (const forbiddenText of [
    ["run", "Rpc", "Worker", "Process"].join(""),
    ["run", "External", "Worker", "Command"].join(""),
    ["rpc", "worker", "process"].join("_"),
    ["per", "worker", "worktree"].join("_"),
    ["AIPI", "EXTERNAL", "WORKER", "COMMAND", "JSON"].join("_"),
    ["AIPI", "CONTAINER", "WORKER", "COMMAND", "JSON"].join("_"),
  ]) {
    if (subagentsRuntime.includes(forbiddenText)) {
      errors.push(`runtime/subagents.js must not include removed backend text ${forbiddenText}`);
    }
  }
  const removedRpcWorkerFile = ["rpc", "worker", "process"].join("-") + ".js";
  if (fs.existsSync(path.join(root, "extensions/aipi/runtime", removedRpcWorkerFile))) {
    errors.push(`extensions/aipi/runtime/${removedRpcWorkerFile} must not exist after the Round 29 single-runtime cutover`);
  }
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/aipi-tools.js"))) {
  errors.push("extensions/aipi/runtime/aipi-tools.js is required for P3 tool surface");
} else {
  const toolsRuntime = read("extensions/aipi/runtime/aipi-tools.js");
  for (const requiredText of [
    "addDomainRelationships",
    "DOMAIN_TOKEN_ALIASES",
    "domainMatchEvidence",
    "implicitBusinessRuleConflict",
    "businessRulePolarity",
    "implicit preserve-vs-replace conflict",
    "implicit required-vs-optional conflict",
    "implicit automatic-vs-manual conflict",
    "implicit numeric mismatch conflict",
    "implicit monetary mismatch conflict",
    "implicit threshold direction conflict",
    "thresholdFactsCompatible",
    "implicit date mismatch conflict",
    "implicit time mismatch conflict",
    "implicit enum value mismatch conflict",
    "implicit boolean state mismatch conflict",
    "implicit cardinality mismatch conflict",
    "extractRuleDateFacts",
    "dateRoleForContext",
    "extractRuleTimeFacts",
    "timeRoleForContext",
    "extractRuleEnumFacts",
    "visibility|access|classification|mode|type|scope",
    "provider|channel|source|owner|region|locale|language|environment|method|currency",
    "extractRuleBooleanStateFacts",
    "extractRuleCardinalityFacts",
    "shared canonical domain terms",
    "extractBusinessRules",
    "business_rule_impacts_code",
    "bdd_contract_impacts_code",
    "deployment_impacts_code",
    "run_verifies_rule",
    "run_fails_rule",
    "run_blocks_rule",
    "run_skips_rule",
    "run_outcome_impacts_code",
    "run_outcomes",
    "extractRunOutcome",
  ]) {
    if (!toolsRuntime.includes(requiredText)) {
      errors.push(`runtime/aipi-tools.js must include domain graph support: ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/context-builder.js"))) {
  errors.push("extensions/aipi/runtime/context-builder.js is required for P2 context materialization");
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/capabilities.js"))) {
  errors.push("extensions/aipi/runtime/capabilities.js is required for truthful runtime posture");
}
if (!read("extensions/aipi/runtime/provider-auth.js").includes("formatCapabilityReport")) {
  errors.push("provider-auth status must include the runtime capability report");
}
if (!read("extensions/aipi/runtime/provider-auth.js").includes("aipi.readiness-report.v1")) {
  errors.push("provider-auth status must include the AIPI readiness report");
}
for (const requiredText of [
  "inspectModelCapabilityFloors",
  "model.capability_floors",
  "MODEL_CAPABILITIES_REL_PATH",
  "formatModelCapabilityFloorEvidence",
]) {
  if (!read("extensions/aipi/runtime/provider-auth.js").includes(requiredText)) {
    errors.push(`provider-auth status must inspect model capability floors: ${requiredText}`);
  }
}
const externalEvidenceRuntime = [
  read("extensions/aipi/runtime/provider-auth.js"),
  read("extensions/aipi/runtime/model-pressure-scorer.js"),
].join("\n");
for (const requiredText of [
  "inspectAipiExternalEvidence",
  "aipi.model-pressure-results.v1",
  "aipi.live-subagent-smoke.v1",
  "model-pressure-baseline-results.json",
  "model-pressure-verify-results.json",
  "live-subagent-result.json",
]) {
  if (!externalEvidenceRuntime.includes(requiredText)) {
    errors.push(`provider-auth status must inspect external evidence: ${requiredText}`);
  }
}
for (const removedFile of [
  path.join("extensions", "aipi", "runtime", `${removedProfileModule}.js`),
  path.join("extensions", "aipi", "runtime", `${removedParentModule}.js`),
]) {
  if (fs.existsSync(path.join(root, removedFile))) {
    errors.push(`removed permission runtime must not exist: ${removedFile}`);
  }
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/memory-command.js"))) {
  errors.push("extensions/aipi/runtime/memory-command.js is required for read-only memory inspection");
} else {
  const memoryCommandRuntime = read("extensions/aipi/runtime/memory-command.js");
  for (const requiredText of [
    "parseMemoryArgs",
    "runMemoryCommand",
    "formatMemoryCommandResult",
    "aipiMemoryQuery",
    "readCodeGraphStatus",
  ]) {
    if (!memoryCommandRuntime.includes(requiredText)) {
      errors.push(`runtime/memory-command.js must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/lifecycle-hooks.js"))) {
  errors.push("extensions/aipi/runtime/lifecycle-hooks.js is required for P6 lifecycle hooks");
} else {
  const lifecycleRuntime = read("extensions/aipi/runtime/lifecycle-hooks.js");
  for (const requiredText of [
    "registerAipiLifecycleHooks",
    "createAipiLifecycleHandlers",
    "handleInput",
    "classifyAipiInputRoute",
    "handleBlockedRunPicker",
    "BLOCKER_FREE_TEXT_OPTION",
    "ctx.ui.select",
    "ctx.ui.input",
    "hasUI",
    "blocker_picker",
    "blocked_text_prompt",
    "recordWorkflowUserInput",
    "handleContext",
    "pruneAipiContextMessages",
    "restoreSubagentCoordinatorFromSession",
    "handleModelSelect",
    "captureCoordinatorHostModel",
    "resolveHostModelCandidate",
    "coordinator.setHostModel",
    "ctx?.getModel",
    "handleThinkingLevelSelect",
    "resolveLifecycleModelRoute",
    "aipi.model-routing.v1",
    "AIPI_MODEL_MANUAL_DRIFT",
    "AIPI_MODEL_CLASS_UNRESOLVED",
    "AIPI_MODEL_CAPABILITY_UNKNOWN",
    "AIPI_MODEL_CAPABILITY_FLOOR_UNMET",
    "capability_report",
    "model-routing.jsonl",
    "applyProviderPayloadPolicy",
    "buildAipiCompactionResult",
    "handleUserBash",
    "handleToolResult",
    "handleBeforeProviderRequest",
    "handleAfterProviderResponse",
    "normalizeProviderUsage",
    "estimateProviderUsageCost",
    "validateProviderPricingConfig",
    "buildProviderBudgetReport",
    "aipi_provider_pricing",
    "pricing_checked_at",
    "pricing_source_url",
    "providerPricingRateFresh",
    "providerPricingRateValidationErrors",
    "cost_unknown",
    "unknown_no_rate",
    "aipi.provider-budget.v1",
    "aipi.provider-usage.v1",
    "provider-budget.jsonl",
    "provider-usage.jsonl",
    "provider-budget.json",
    "provider-pricing.json",
    "writeRunHandoffSnapshot",
  ]) {
    if (!lifecycleRuntime.includes(requiredText)) {
      errors.push(`runtime/lifecycle-hooks.js must include ${requiredText}`);
    }
  }
  if (lifecycleRuntime.includes("answer_blocker")) {
    errors.push("runtime/lifecycle-hooks.js must not use the old answer_blocker route");
  }
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/blocker-input.js"))) {
  errors.push("extensions/aipi/runtime/blocker-input.js is required for blocker picker metadata");
} else {
  const blockerInputRuntime = read("extensions/aipi/runtime/blocker-input.js");
  for (const requiredText of [
    "BLOCKER_FREE_TEXT_OPTION",
    "normalizeBlockerOptions",
    "awaitingUserInputFromStepResult",
    "formatAwaitingUserInputPrompt",
    "MAX_BLOCKER_OPTIONS",
  ]) {
    if (!blockerInputRuntime.includes(requiredText)) {
      errors.push(`runtime/blocker-input.js must include ${requiredText}`);
    }
  }
}
const modelRouterRuntime = read("extensions/aipi/runtime/model-router.js");
for (const requiredText of [
  "MODEL_CAPABILITIES_REL_PATH",
  "inspectModelCapabilityFloors",
  "evaluateModelCapabilityFloor",
  "aipi.model-capability-floor-report.v1",
  "aipi.model-capability-floor.v1",
  "missing_class_model",
  "missing_model_capabilities",
  "preferredFamilyWarning",
  "AIPI_MODEL_PREFERRED_FAMILY_MISMATCH",
  "BOOLEAN_CAPABILITY_FLOORS",
  "booleanCapabilitySatisfies",
  "host_model",
  "allow_fallback === false",
  "running on host model",
  "host-default-unavailable",
]) {
  if (!modelRouterRuntime.includes(requiredText)) {
    errors.push(`runtime/model-router.js must include ${requiredText}`);
  }
}
for (const capability of ["structured_outputs", "web", "citations", "evidence_audit"]) {
  if (!modelRouterRuntime.includes(capability)) {
    errors.push(`runtime/model-router.js must explicitly handle boolean capability floor ${capability}`);
  }
}
const runStateRuntime = read("extensions/aipi/runtime/run-state.js");
for (const requiredText of ["recordWorkflowUserInput", "USER-INPUT.jsonl", "aipi.user-input.v1"]) {
  if (!runStateRuntime.includes(requiredText)) {
    errors.push(`runtime/run-state.js must include ${requiredText}`);
  }
}
if (runStateRuntime.includes("parentToolCallGate") || runStateRuntime.includes("registered_soft_gate")) {
  errors.push("runtime/run-state.js must use parentInteractiveToolCallHook, not the old parentToolCallGate label");
}
const workflowExecutorPolicyRuntime = read("extensions/aipi/runtime/workflow-executor.js");
for (const requiredText of [
  "controller_write_scope",
  "parent_interactive_tool_call_hook",
  "registered_parent_interactive_tool_call_hook",
  "awaitingUserInputFromStepResult",
]) {
  if (!workflowExecutorPolicyRuntime.includes(requiredText)) {
    errors.push(`runtime/workflow-executor.js must record scoped workflow policy provenance: ${requiredText}`);
  }
}
if (workflowExecutorPolicyRuntime.includes("parent_session_tool_call:")) {
  errors.push("runtime/workflow-executor.js must not record parent_session_tool_call as a workflow-run policy label");
}
const contextBuilderRuntime = read("extensions/aipi/runtime/context-builder.js");
for (const requiredText of ["materializeRunUserInputs", "user_inputs", "USER-INPUT.jsonl"]) {
  if (!contextBuilderRuntime.includes(requiredText)) {
    errors.push(`runtime/context-builder.js must include ${requiredText}`);
  }
}
const aipiToolsRuntime = read("extensions/aipi/runtime/aipi-tools.js");
for (const requiredText of [
  "GRAPH_SQLITE_REL_PATH",
  "node:sqlite",
  "sqlite-vec",
  "GRAPH_VECTOR_DIMENSIONS",
  "writeSqliteGraph",
  "prepareSqliteVec",
  "sqliteVectorRefs",
  "BEGIN IMMEDIATE",
  "COMMIT",
  "ROLLBACK",
  "buildRelationships",
  "graphRelationships",
  "relationships",
  "test_covers",
  "sqlite+sqlite-vec+lexical",
  "parseMemoryFrontmatter",
  "memory_metadata",
  "memory_type",
  "memory_last_reviewed",
  "stale_before",
]) {
  if (!aipiToolsRuntime.includes(requiredText)) {
    errors.push(`runtime/aipi-tools.js must include ${requiredText}`);
  }
}
if (!fs.existsSync(path.join(root, "docs/probe-a-tool-call-attribution.md"))) {
  errors.push("docs/probe-a-tool-call-attribution.md is required");
}
const projectInitRuntime = read("extensions/aipi/runtime/project-init.js");
const projectInitTest = read("tools/test-project-init.mjs");
if (!projectInitRuntime.includes("--reset-memory")) {
  errors.push("project-init must expose explicit --reset-memory for memory resets");
}
if (!projectInitRuntime.includes("--no-onboard")) {
  errors.push("project-init must expose --no-onboard for copy-only initialization");
}
if (!projectInitRuntime.includes("isProjectMemoryPath")) {
  errors.push("project-init must protect .aipi/memory/project/** during --force");
}
if (!projectInitTest.includes("project memory protected")) {
  errors.push("test-project-init must verify --force protects project memory");
}
if (!projectInitTest.includes("--no-onboard")) {
  errors.push("test-project-init must verify --no-onboard parse support");
}

const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
if (!Array.isArray(packageJson.keywords) || !packageJson.keywords.includes("pi-package")) {
  errors.push("package.json keywords must include pi-package");
}
if (packageJson.version === "0.0.0") {
  errors.push("package.json version must be a real AIPI version, not 0.0.0");
}
if (!packageJson.dependencies?.["sqlite-vec"]) {
  errors.push("package.json must include sqlite-vec as a runtime dependency for code graph vectors");
}
if (packageJson.scripts?.["test:init"] !== "node tools/test-project-init.mjs") {
  errors.push("package.json must include test:init for /aipi-init");
}
if (packageJson.scripts?.["test:onboarding"] !== "node tools/test-project-onboarding.mjs") {
  errors.push("package.json must include test:onboarding for /aipi-onboard");
}
if (!packageJson.scripts?.test?.includes("npm run test:init")) {
  errors.push("package.json test script must run test:init");
}
if (!packageJson.scripts?.test?.includes("npm run test:onboarding")) {
  errors.push("package.json test script must run test:onboarding");
}
if (packageJson.bin?.aipi !== "./bin/aipi.js") {
  errors.push("package.json must expose the aipi CLI via bin.aipi");
}
if (!packageJson.files?.includes("bin/**")) {
  errors.push("package.json files must include bin/** for the aipi CLI");
}
if (packageJson.scripts?.["test:bin"] !== "node tools/test-aipi-bin.mjs") {
  errors.push("package.json must include test:bin for the aipi CLI wrapper");
}
if (!packageJson.scripts?.test?.includes("npm run test:bin")) {
  errors.push("package.json test script must run test:bin");
}
if (packageJson.scripts?.["test:update"] !== "node tools/test-aipi-update.mjs") {
  errors.push("package.json must include test:update for the aipi update wrapper");
}
if (!packageJson.scripts?.test?.includes("npm run test:update")) {
  errors.push("package.json test script must run test:update");
}
if (packageJson.scripts?.["test:diagnose"] !== "node tools/test-diagnose.mjs") {
  errors.push("package.json must include test:diagnose for the aipi diagnose wrapper");
}
if (!packageJson.scripts?.test?.includes("npm run test:diagnose")) {
  errors.push("package.json test script must run test:diagnose");
}
const binTest = read("tools/test-aipi-bin.mjs");
if (!binTest.includes("formatAipiVersion") || !binTest.includes("--pi-help")) {
  errors.push("test-aipi-bin must cover AIPI-owned version/help behavior");
}
if (!binTest.includes("runAipiStatus") || !binTest.includes("--strict")) {
  errors.push("test-aipi-bin must cover AIPI-owned status/doctor behavior");
}
if (!binTest.includes("runAipiWorkflow") || !binTest.includes("parseAipiWorkflowArgs")) {
  errors.push("test-aipi-bin must cover AIPI-owned workflow wrapper behavior");
}
if (!binTest.includes("runAipiMemory") || !binTest.includes("parseAipiMemoryArgs")) {
  errors.push("test-aipi-bin must cover AIPI-owned memory wrapper behavior");
}
if (!binTest.includes("runAipiDiagnose") || !binTest.includes("parseAipiDiagnoseArgs")) {
  errors.push("test-aipi-bin must cover AIPI-owned diagnose wrapper behavior");
}
const diagnoseTest = read("tools/test-diagnose.mjs");
if (!diagnoseTest.includes("worker_no_provider_events") || !diagnoseTest.includes("awaiting_user_decision")) {
  errors.push("test-diagnose must cover worker no-provider and awaiting-user diagnostic rules");
}
const toolsTest = read("tools/test-aipi-tools.mjs");
if (!toolsTest.includes("runMemoryCommand") || !toolsTest.includes("parseMemoryArgs")) {
  errors.push("test-aipi-tools must cover read-only memory command behavior");
}
if (!fs.existsSync(path.join(root, "bin/aipi.js"))) {
  errors.push("bin/aipi.js is required for the aipi CLI wrapper");
} else {
  const binAipi = read("bin/aipi.js");
  if (!binAipi.startsWith("#!/usr/bin/env node")) {
    errors.push("bin/aipi.js must start with a node shebang");
  }
  if (!binAipi.includes("classifyAipiInvocation") || !binAipi.includes("formatAipiVersion")) {
    errors.push("bin/aipi.js must own --version/--help before spawning Pi");
  }
  if (!binAipi.includes("--pi-help") || !binAipi.includes("--pi-version")) {
    errors.push("bin/aipi.js must expose raw Pi help/version escape hatches");
  }
  if (!binAipi.includes("runAipiStatus") || !binAipi.includes("aipi-status") || !binAipi.includes("doctor")) {
    errors.push("bin/aipi.js must expose aipi status/doctor without starting Pi");
  }
  if (!binAipi.includes("runAipiWorkflow") || !binAipi.includes("aipi workflow")) {
    errors.push("bin/aipi.js must expose aipi workflow without starting Pi");
  }
  for (const removedText of [`runAipi${"Profile"}`, removedProfileCommand]) {
    if (binAipi.includes(removedText)) {
      errors.push(`bin/aipi.js must not expose removed permission wrapper text: ${removedText}`);
    }
  }
  if (!binAipi.includes("runAipiMemory") || !binAipi.includes("aipi memory")) {
    errors.push("bin/aipi.js must expose aipi memory without starting Pi");
  }
  if (!binAipi.includes("runAipiDiagnose") || !binAipi.includes("aipi diagnose")) {
    errors.push("bin/aipi.js must expose aipi diagnose without starting Pi");
  }
  if (!binAipi.includes("aipiProviderExtensionPaths") || !binAipi.includes("providerAuth")) {
    errors.push("bin/aipi.js must derive provider extension paths from runtime-contract providerAuth");
  }
  if (!binAipi.includes("anthropic-oauth-only.ts")) {
    errors.push("bin/aipi.js default provider extension must use the AIPI OAuth-only Anthropic wrapper");
  }
  if (!binAipi.includes("extensions") || !binAipi.includes("aipi")) {
    errors.push("bin/aipi.js must inject the local AIPI Pi extension");
  }
}
if (packageJson.scripts?.["test:provider-auth"] !== "node tools/test-provider-auth.mjs") {
  errors.push("package.json must include test:provider-auth for /aipi-status");
}
if (!packageJson.scripts?.test?.includes("npm run test:provider-auth")) {
  errors.push("package.json test script must run test:provider-auth");
}
if (packageJson.scripts?.["test:permission-removal"] !== "node tools/test-permission-removal.mjs") {
  errors.push("package.json must include test:permission-removal for removed permission layer coverage");
}
if (!packageJson.scripts?.test?.includes("npm run test:permission-removal")) {
  errors.push("package.json test script must run test:permission-removal");
}
if (packageJson.scripts?.["test:lifecycle-hooks"] !== "node tools/test-lifecycle-hooks.mjs") {
  errors.push("package.json must include test:lifecycle-hooks for P6 lifecycle hooks");
}
if (!packageJson.scripts?.test?.includes("npm run test:lifecycle-hooks")) {
  errors.push("package.json test script must run test:lifecycle-hooks");
}
if (packageJson.scripts?.["test:blocker-picker"] !== "node tools/test-blocker-picker.mjs") {
  errors.push("package.json must include test:blocker-picker for interactive blocker picker coverage");
}
if (!packageJson.scripts?.test?.includes("npm run test:blocker-picker")) {
  errors.push("package.json test script must run test:blocker-picker");
}
if (packageJson.scripts?.["test:aipi-tools"] !== "node tools/test-aipi-tools.mjs") {
  errors.push("package.json must include test:aipi-tools for P3 tool surface");
}
if (!packageJson.scripts?.test?.includes("npm run test:aipi-tools")) {
  errors.push("package.json test script must run test:aipi-tools");
}
if (packageJson.scripts?.["test:context-builder"] !== "node tools/test-context-builder.mjs") {
  errors.push("package.json must include test:context-builder for P2 context materialization");
}
if (!packageJson.scripts?.test?.includes("npm run test:context-builder")) {
  errors.push("package.json test script must run test:context-builder");
}
if (packageJson.scripts?.["test:model-router"] !== "node tools/test-model-router.mjs") {
  errors.push("package.json must include test:model-router for model-class resolution");
}
if (!packageJson.scripts?.test?.includes("npm run test:model-router")) {
  errors.push("package.json test script must run test:model-router");
}
if (packageJson.scripts?.["test:model-class"] !== "node tools/test-model-class-fallback.mjs") {
  errors.push("package.json must include test:model-class for host-model fallback coverage");
}
if (!packageJson.scripts?.test?.includes("npm run test:model-class")) {
  errors.push("package.json test script must run test:model-class");
}
if (packageJson.scripts?.["test:mcp"] !== "node tools/test-mcp-bridge.mjs") {
  errors.push("package.json must include test:mcp for the MCP bridge");
}
if (!packageJson.scripts?.test?.includes("npm run test:mcp")) {
  errors.push("package.json test script must run test:mcp");
}
if (packageJson.dependencies?.["@modelcontextprotocol/sdk"] == null) {
  errors.push("package.json must depend on @modelcontextprotocol/sdk for MCP bridge");
}
if (packageJson.dependencies?.["@sinclair/typebox"] == null) {
  errors.push("package.json must depend on @sinclair/typebox because MCP bridge imports TypeBox directly");
}
if (!fs.existsSync(path.join(root, "tools/test-mcp-bridge.mjs"))) {
  errors.push("tools/test-mcp-bridge.mjs is required for MCP bridge fixture coverage");
} else {
  const mcpTest = read("tools/test-mcp-bridge.mjs");
  for (const requiredText of [
    "tools/fixtures/fake-mcp-server.mjs",
    "mcp__good__echo_tool",
    "bad server",
    "bridge inactive",
    "AIPI_MCP_BRIDGE_TEST_OK",
  ]) {
    if (!mcpTest.includes(requiredText)) {
      errors.push(`tools/test-mcp-bridge.mjs must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "docs/mcp.md"))) {
  errors.push("docs/mcp.md is required for MCP bridge documentation");
} else {
  const mcpDocs = read("docs/mcp.md");
  for (const requiredText of [
    "mcp-remote",
    "https://mcp.linear.app/mcp",
    "browser login",
    "Direct Streamable HTTP/SSE OAuth",
    "resources and prompts are also deferred",
  ]) {
    if (!mcpDocs.includes(requiredText)) {
      errors.push(`docs/mcp.md must include ${requiredText}`);
    }
  }
}
if (!read("README.md").includes("docs/mcp.md")) {
  errors.push("README.md must link docs/mcp.md");
}
if (!read("README.md").includes("AIPI_LIVE_SMOKE_MODEL")) {
  errors.push("README.md must document AIPI_LIVE_SMOKE_MODEL for live subagent smoke outside interactive sessions");
}
if (!read("docs/README.md").includes("mcp.md")) {
  errors.push("docs/README.md must link mcp.md");
}
if (!read("docs/pi-subagent-build-plan.md").includes("Host-model fallback") ||
  !read("docs/pi-subagent-build-plan.md").includes("allow_fallback:false")) {
  errors.push("docs/pi-subagent-build-plan.md must document host-model fallback and strict mode");
}
if (!fs.existsSync(path.join(root, "tools/test-model-router.mjs"))) {
  errors.push("tools/test-model-router.mjs is required for model-class resolution");
} else {
  const modelRouterTest = read("tools/test-model-router.mjs");
  for (const requiredText of ["claude-research", "claude-no-citations", "structured_outputs", "evidence_audit"]) {
    if (!modelRouterTest.includes(requiredText)) {
      errors.push(`tools/test-model-router.mjs must cover boolean capability floors: ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "tools/test-model-class-fallback.mjs"))) {
  errors.push("tools/test-model-class-fallback.mjs is required for host-model fallback coverage");
} else {
  const modelClassTest = read("tools/test-model-class-fallback.mjs");
  for (const requiredText of [
    "aipi_spawn_agent",
    "ctx-host",
    "forked runner received the real host model",
    "piSubagentsRunner",
    "AIPI_MODEL_CLASS_UNRESOLVED",
    "allow_fallback:false",
    "anthropic/claude-host",
    "model-select-capture",
    "defensive-capture",
    "event.model.id",
    "ctx.getModel",
    "getHostModel",
  ]) {
    if (!modelClassTest.includes(requiredText)) {
      errors.push(`tools/test-model-class-fallback.mjs must cover Round 23 host-model fallback: ${requiredText}`);
    }
  }
}
if (packageJson.scripts?.["test:probe-a"] !== "node tools/test-probe-a.mjs") {
  errors.push("package.json must include test:probe-a for Probe A");
}
if (!packageJson.scripts?.test?.includes("npm run test:probe-a")) {
  errors.push("package.json test script must run test:probe-a");
}
if (packageJson.scripts?.["test:probe-a-prime"] !== "node tools/test-probe-a-prime.mjs") {
  errors.push("package.json must include test:probe-a-prime for Probe A'");
}
if (!packageJson.scripts?.test?.includes("npm run test:probe-a-prime")) {
  errors.push("package.json test script must run test:probe-a-prime");
}
if (packageJson.scripts?.["test:subagents"] !== "node tools/test-subagents.mjs") {
  errors.push("package.json must include test:subagents for the forked pi_subagents backend");
}
if (!packageJson.scripts?.test?.includes("npm run test:subagents")) {
  errors.push("package.json test script must run test:subagents");
}
if (packageJson.scripts?.["test:subagents-real-sdk"] !== "node tools/test-subagents-real-sdk.mjs") {
  errors.push("package.json must include test:subagents-real-sdk for the Pi SDK worker toolset smoke");
}
if (!packageJson.scripts?.test?.includes("npm run test:subagents-real-sdk")) {
  errors.push("package.json test script must run test:subagents-real-sdk");
}
if (packageJson.dependencies?.["@earendil-works/pi-coding-agent"] || packageJson.devDependencies?.["@earendil-works/pi-coding-agent"]) {
  errors.push("package.json must not package @earendil-works/pi-coding-agent; real-SDK smoke loads the ambient Pi SDK");
}
if (packageJson.optionalDependencies?.["pi-subagents"] || packageJson.dependencies?.["pi-subagents"]) {
  errors.push("package.json must not depend on npm pi-subagents; AIPI vendors the source under extensions/aipi/runtime/vendor/pi-subagents");
}
if (packageLock.packages?.[""]?.optionalDependencies?.["pi-subagents"] ||
  packageLock.packages?.[""]?.dependencies?.["pi-subagents"] ||
  packageLock.packages?.["node_modules/pi-subagents"]) {
  errors.push("package-lock must not include npm pi-subagents; AIPI uses the vendored source");
}
for (const [dep, version] of [
  ["jiti", "2.7.0"],
  ["typebox", "1.2.16"],
]) {
  if (packageJson.dependencies?.[dep] !== version) {
    errors.push(`package.json must pin ${dep}@${version} for the forked pi-subagents runtime`);
  }
}
if (packageJson.dependencies?.["@earendil-works/pi-tui"] ||
  packageJson.optionalDependencies?.["@earendil-works/pi-tui"] ||
  packageJson.devDependencies?.["@earendil-works/pi-tui"]) {
  errors.push("package.json must not keep @earendil-works/pi-tui as a direct AIPI dependency; the separate pi-subagents extension is not loaded");
}
for (const peer of [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
]) {
  if (packageJson.dependencies?.[peer] || packageJson.optionalDependencies?.[peer] || packageJson.devDependencies?.[peer]) {
    errors.push(`package.json must not bundle pi-subagents peer ${peer}; it belongs to the host Pi runtime`);
  }
}
const piSubagentsVendorRoot = "extensions/aipi/runtime/vendor/pi-subagents";
for (const requiredPath of [
  `${piSubagentsVendorRoot}/LICENSE`,
  `${piSubagentsVendorRoot}/VENDOR.md`,
  `${piSubagentsVendorRoot}/package.json`,
  `${piSubagentsVendorRoot}/src/extension/index.ts`,
  `${piSubagentsVendorRoot}/src/runs/background/subagent-runner.ts`,
  `${piSubagentsVendorRoot}/src/runs/foreground/subagent-executor.ts`,
  `${piSubagentsVendorRoot}/agents/worker.md`,
]) {
  if (!fs.existsSync(path.join(root, requiredPath))) {
    errors.push(`embedded pi-subagents vendor path is missing ${requiredPath}`);
  }
}
const piSubagentsVendorManifest = JSON.parse(read(`${piSubagentsVendorRoot}/package.json`));
if (piSubagentsVendorManifest.name !== "pi-subagents" || piSubagentsVendorManifest.version !== "0.28.0") {
  errors.push("embedded pi-subagents vendor package.json must identify pi-subagents@0.28.0");
}
const piSubagentsVendorDoc = read(`${piSubagentsVendorRoot}/VENDOR.md`);
for (const requiredText of [
  "nicobailon/pi-subagents",
  "pi-subagents@0.28.0",
  "sha512-EWgQphVqH7BWJFNiWdyOCa8uqwr/aWkm9OyhItFiIJfpmdY4mGUlZ2VK1z3UP6XfVAmidtGd0MsnyhuFTxAm0A==",
  "End users do not run `pi install npm:pi-subagents`",
  "Pi peer packages",
  "Re-sync procedure",
]) {
  if (!piSubagentsVendorDoc.includes(requiredText)) {
    errors.push(`embedded pi-subagents VENDOR.md must include ${requiredText}`);
  }
}
const noticeText = read("NOTICE.md");
for (const requiredText of ["pi-subagents", "nicobailon/pi-subagents", "MIT"]) {
  if (!noticeText.includes(requiredText)) {
    errors.push(`NOTICE.md must include pi-subagents attribution text: ${requiredText}`);
  }
}
const ciWorkflow = read(".github/workflows/aipi-templates.yml");
if (!ciWorkflow.includes("npm install -g @earendil-works/pi-coding-agent@0.79.5")) {
  errors.push("CI must install ambient @earendil-works/pi-coding-agent@0.79.5 for test:subagents-real-sdk");
}
if (packageJson.scripts?.["smoke:subagent-live"] !== "node tools/smoke-live-subagent.mjs") {
  errors.push("package.json must include smoke:subagent-live for explicit credentialed worker smoke");
}
if (!read("tools/smoke-live-subagent.mjs").includes("AIPI_LIVE_SMOKE_MODEL")) {
  errors.push("tools/smoke-live-subagent.mjs must accept AIPI_LIVE_SMOKE_MODEL for non-interactive host-model fallback smoke");
}
if (packageJson.scripts?.["smoke:pi-subagents"] !== "node tools/smoke-pi-subagents.mjs") {
  errors.push("package.json must include smoke:pi-subagents for the forked pi-subagents live spike instructions");
}
if (!read("tools/smoke-pi-subagents.mjs").includes("formatPiSubagentsSmokeInstructions")) {
  errors.push("tools/smoke-pi-subagents.mjs must render the pi-subagents live spike instructions");
}
const piSubagentsRuntime = read("extensions/aipi/runtime/pi-subagents.js");
for (const requiredText of [
  "PI_SUBAGENTS_PACKAGE = \"pi-subagents@0.28.0\"",
  "PI_SUBAGENTS_VENDOR_ROOT",
  "AIPI_SUBAGENTS_RUNTIME_ROOT",
  "AIPI_SUBAGENTS_AGENT_NAME",
  "AIPI_SUBAGENTS_ALLOWED_TOOLS",
  "AIPI_SUBAGENTS_READ_ONLY_TOOLS",
  "AIPI_SUBAGENTS_GUARDED_WRITE_EXTENSION",
  "AIPI_SUBAGENTS_DISALLOWED_PROVIDERS",
  "guardedWriteExtensionPath",
  "AIPI_SUBAGENTS_PROJECT_ROOT",
  "AIPI_SUBAGENTS_AGENT_ID",
  "AIPI_SUBAGENTS_OWNED_FILES",
  "projectSubagentsRuntimePaths",
  "assertAipiHostScopedModel",
  "createAipiSubagentsRunner",
  "runAipiForkedSubagent",
  "createJiti",
  "moduleCache: false",
  "fallbackModels: []",
  "runPiSubagentsLiveSpike",
  "provider_event_observed",
]) {
  if (!piSubagentsRuntime.includes(requiredText)) {
    errors.push(`runtime/pi-subagents.js must include ${requiredText}`);
  }
}
if (piSubagentsRuntime.includes("tools: [...AIPI_SUBAGENTS_ALLOWED_TOOLS]")) {
  errors.push("runtime/pi-subagents.js must not pass the unguarded builtin write to forked workers");
}
if (!piSubagentsRuntime.includes("tools: [...AIPI_SUBAGENTS_READ_ONLY_TOOLS, guardedWriteExtensionPath]")) {
  errors.push("runtime/pi-subagents.js must expose read-only builtins plus the guarded write extension to forked workers");
}
if (!piSubagentsRuntime.includes("extensions: []")) {
  errors.push("runtime/pi-subagents.js must disable ambient child extensions and explicitly load only runtime/tool extensions");
}
const guardedWriteChild = read("extensions/aipi/runtime/aipi-guarded-write-child.js");
for (const requiredText of [
  "name: \"write\"",
  "AIPI_SUBAGENTS_PROJECT_ROOT",
  "AIPI_SUBAGENTS_OWNED_FILES",
  "AIPI_SUBAGENTS_AGENT_ID",
  "outside its owned-file scope",
  ".aipi/memory",
  "write path escapes project root",
]) {
  if (!guardedWriteChild.includes(requiredText)) {
    errors.push(`runtime/aipi-guarded-write-child.js must include ${requiredText}`);
  }
}
for (const forbiddenText of [
  "PI_SUBAGENTS_EMBEDDED_EXTENSION",
  ["AIPI", "SUBAGENT", "BACKEND"].join("_"),
  "findRegisteredTool",
  "subagent tool is registered",
]) {
  if (piSubagentsRuntime.includes(forbiddenText)) {
    errors.push(`runtime/pi-subagents.js must not include removed embedded-adapter text ${forbiddenText}`);
  }
}
if (!read("extensions/aipi/index.js").includes('pi.registerCommand("aipi-pi-subagents-spike"')) {
  errors.push("extensions/aipi/index.js must register /aipi-pi-subagents-spike");
}
const smokePiSubagents = read("tools/smoke-pi-subagents.mjs");
if (smokePiSubagents.includes("pi install npm:pi-subagents")) {
  errors.push("tools/smoke-pi-subagents.mjs must not instruct users to run pi install npm:pi-subagents");
}
const removedPiSubagentsExtension = ["pi", "subagents", "embedded"].join("-") + ".js";
const removedPiSubagentsExtensionRel = `./extensions/aipi/${removedPiSubagentsExtension}`;
if (fs.existsSync(path.join(root, "extensions/aipi", removedPiSubagentsExtension))) {
  errors.push(`extensions/aipi/${removedPiSubagentsExtension} must not exist; pi-subagents is forked into AIPI runtime code`);
}
if (packageJson.pi?.extensions?.includes(removedPiSubagentsExtensionRel)) {
  errors.push("package.json pi.extensions must not load a separate pi-subagents extension");
}
const removedPiSubagentsExtensionExport = ["embedded", "Pi", "Subagents", "Extension", "Path"].join("");
if (binWrapper.includes(removedPiSubagentsExtensionExport) ||
  binWrapper.includes(removedPiSubagentsExtensionRel)) {
  errors.push("bin/aipi.js must not inject a separate pi-subagents extension path");
}
if (packageJson.scripts?.["test:run-state"] !== "node tools/test-run-state.mjs") {
  errors.push("package.json must include test:run-state for /aipi-workflow");
}
if (!packageJson.scripts?.test?.includes("npm run test:run-state")) {
  errors.push("package.json test script must run test:run-state");
}
if (packageJson.scripts?.["test:workflow-executor"] !== "node tools/test-workflow-executor.mjs") {
  errors.push("package.json must include test:workflow-executor for workflow execution");
}
if (!packageJson.scripts?.test?.includes("npm run test:workflow-executor")) {
  errors.push("package.json test script must run test:workflow-executor");
}
if (!fs.existsSync(path.join(root, "tools/test-workflow-executor.mjs"))) {
  errors.push("tools/test-workflow-executor.mjs is required for workflow execution");
} else {
  const workflowExecutorTest = read("tools/test-workflow-executor.mjs");
  for (const requiredText of [
    "resumedAfterRestart",
    "args: \"continue\"",
    "RUN-MANIFEST.md",
    "parent_interactive_tool_call_hook",
    "controller_write_scope",
  ]) {
    if (!workflowExecutorTest.includes(requiredText)) {
      errors.push(`tools/test-workflow-executor.mjs must include restart/resume coverage: ${requiredText}`);
    }
  }
}
if (packageJson.scripts?.["test:pressure-evals"] !== "node tools/test-pressure-evals.mjs") {
  errors.push("package.json must include test:pressure-evals for runtime pressure fixtures");
}
if (!packageJson.scripts?.test?.includes("npm run test:pressure-evals")) {
  errors.push("package.json test script must run test:pressure-evals");
}
if (!fs.existsSync(path.join(root, "tools/test-pressure-evals.mjs"))) {
  errors.push("tools/test-pressure-evals.mjs is required for P9 pressure fixtures");
} else {
  const runtimePressure = read("tools/test-pressure-evals.mjs");
  if (!runtimePressure.includes("runtime_gates=5")) {
    errors.push("tools/test-pressure-evals.mjs must report runtime_gates=5 to avoid conflating runtime gates with behavioral scenarios");
  }
  if (runtimePressure.includes("scenarios=5")) {
    errors.push("tools/test-pressure-evals.mjs must not report scenarios=5 for runtime gate fixtures");
  }
}
const evalReadme = read("templates/.aipi/evals/README.md");
for (const requiredText of ["runtime-gate fixtures", "does not execute the behavioral scenarios", "model-backed behavioral harness"]) {
  if (!evalReadme.includes(requiredText)) {
    errors.push(`evals/README.md must disambiguate runtime pressure gates from behavioral scenarios: ${requiredText}`);
  }
}
if (packageJson.scripts?.["test:model-pressure-evals"] !== "node tools/test-model-pressure-evals.mjs") {
  errors.push("package.json must include test:model-pressure-evals for opt-in model-backed pressure evals");
}
if (!packageJson.scripts?.test?.includes("npm run test:model-pressure-evals")) {
  errors.push("package.json test script must run test:model-pressure-evals");
}
if (!fs.existsSync(path.join(root, "tools/test-model-pressure-evals.mjs"))) {
  errors.push("tools/test-model-pressure-evals.mjs is required for P9 model-backed pressure harness");
} else {
  const modelPressure = read("tools/test-model-pressure-evals.mjs");
  for (const requiredText of [
    "AIPI_MODEL_PRESSURE",
    "AIPI_MODEL_PRESSURE_COMMAND",
    "AIPI_MODEL_PRESSURE_PHASE",
    "baseline",
    "verify",
    "aipi.model-pressure-results.v1",
    "AIPI_MODEL_PRESSURE_BASELINE_NO_FAILURE",
    "I avoided adding wrappers",
  ]) {
    if (!modelPressure.includes(requiredText)) {
      errors.push(`tools/test-model-pressure-evals.mjs must include ${requiredText}`);
    }
  }
}
if (!read("extensions/aipi/runtime/model-pressure-scorer.js").includes("stripCompliantDisciplineRestatements")) {
  errors.push("model-pressure scorer must strip compliant discipline restatements before checking forbidden patterns");
}
if (packageJson.scripts?.["test:adversarial-readiness"] !== "node tools/test-adversarial-readiness.mjs") {
  errors.push("package.json must include test:adversarial-readiness for readiness/adversarial claim checks");
}
if (!packageJson.scripts?.test?.includes("npm run test:adversarial-readiness")) {
  errors.push("package.json test script must run test:adversarial-readiness");
}
if (packageJson.scripts?.["test:provider-pricing"] !== "node tools/test-provider-pricing.mjs") {
  errors.push("package.json must include test:provider-pricing for provider pricing freshness gates");
}
if (!packageJson.scripts?.test?.includes("npm run test:provider-pricing")) {
  errors.push("package.json test script must run test:provider-pricing");
}
if (!fs.existsSync(path.join(root, "tools/check-provider-pricing.mjs"))) {
  errors.push("tools/check-provider-pricing.mjs is required for provider pricing freshness gates");
} else {
  const providerPricingCheck = read("tools/check-provider-pricing.mjs");
  for (const requiredText of [
    "aipi.provider-pricing-validation.v1",
    "validateProviderPricingConfig",
    "--require-rates",
    "cost_unknown",
    "source metadata",
  ]) {
    if (!providerPricingCheck.includes(requiredText)) {
      errors.push(`tools/check-provider-pricing.mjs must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "tools/test-provider-pricing.mjs"))) {
  errors.push("tools/test-provider-pricing.mjs is required for provider pricing freshness gates");
} else {
  const providerPricingTest = read("tools/test-provider-pricing.mjs");
  for (const requiredText of [
    "AIPI_PROVIDER_PRICING_TEST_OK",
    "checked_at cannot be in the future",
    "--require-rates",
    "cost_unknown",
  ]) {
    if (!providerPricingTest.includes(requiredText)) {
      errors.push(`tools/test-provider-pricing.mjs must include ${requiredText}`);
    }
  }
}
if (packageJson.scripts?.["release:audit"] !== "node tools/check-npm-audit.mjs --strict") {
  errors.push("package.json must include release:audit for the npm audit release gate");
}
if (packageJson.scripts?.["release:check"] !== "node tools/run-release-check.mjs --strict") {
  errors.push("package.json must include release:check for the aggregate local release gate");
}
if (packageJson.scripts?.["test:npm-audit-check"] !== "node tools/test-npm-audit-check.mjs") {
  errors.push("package.json must include test:npm-audit-check for the npm audit wrapper");
}
if (packageJson.scripts?.["test:release-check"] !== "node tools/test-release-check.mjs") {
  errors.push("package.json must include test:release-check for the aggregate local release gate");
}
if (!packageJson.scripts?.test?.includes("npm run test:npm-audit-check")) {
  errors.push("package.json test script must run test:npm-audit-check");
}
if (!packageJson.scripts?.test?.includes("npm run test:release-check")) {
  errors.push("package.json test script must run test:release-check");
}
if (!fs.existsSync(path.join(root, "tools/check-npm-audit.mjs"))) {
  errors.push("tools/check-npm-audit.mjs is required for the npm audit release gate");
} else {
  const npmAuditCheck = read("tools/check-npm-audit.mjs");
  for (const requiredText of [
    "aipi.npm-audit-release-check.v1",
    "external_unavailable",
    "audit endpoint returned an error",
    "--omit=dev",
    "--legacy-peer-deps",
    "--timeout-ms",
  ]) {
    if (!npmAuditCheck.includes(requiredText)) {
      errors.push(`tools/check-npm-audit.mjs must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "tools/test-npm-audit-check.mjs"))) {
  errors.push("tools/test-npm-audit-check.mjs is required for the npm audit release gate");
} else {
  const npmAuditTest = read("tools/test-npm-audit-check.mjs");
  for (const requiredText of [
    "AIPI_NPM_AUDIT_CHECK_TEST_OK",
    "external_unavailable",
    "registry endpoint unavailable",
    "strictResult.exitCode",
  ]) {
    if (!npmAuditTest.includes(requiredText)) {
      errors.push(`tools/test-npm-audit-check.mjs must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "tools/run-release-check.mjs"))) {
  errors.push("tools/run-release-check.mjs is required for the aggregate local release gate");
} else {
  const releaseCheck = read("tools/run-release-check.mjs");
  for (const requiredText of [
    "aipi.release-check.v1",
    "npm_test",
    "npm_pack_dry_run",
    "npm_audit",
    "external_unavailable",
    "release:audit",
    "--skip-test",
    "--skip-audit",
  ]) {
    if (!releaseCheck.includes(requiredText)) {
      errors.push(`tools/run-release-check.mjs must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "tools/test-release-check.mjs"))) {
  errors.push("tools/test-release-check.mjs is required for the aggregate local release gate");
} else {
  const releaseCheckTest = read("tools/test-release-check.mjs");
  for (const requiredText of [
    "AIPI_RELEASE_CHECK_TEST_OK",
    "aipi.release-check.v1",
    "external_unavailable",
    "npm_pack_dry_run",
    "release:audit",
  ]) {
    if (!releaseCheckTest.includes(requiredText)) {
      errors.push(`tools/test-release-check.mjs must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "tools/test-adversarial-readiness.mjs"))) {
  errors.push("tools/test-adversarial-readiness.mjs is required for readiness/adversarial claim checks");
} else {
  const adversarialReadiness = read("tools/test-adversarial-readiness.mjs");
  for (const requiredText of [
    "aipi.readiness-report.v1",
    "needs_external_evidence",
    "`external`/`container` command adapters",
    "deterministic domain aliases",
    "polarity conflicts",
    "monetary conflicts",
    "threshold direction conflicts",
    "date conflicts",
    "time conflicts",
    "enum value conflicts",
    "boolean state conflicts",
    "cardinality conflicts",
    "historical run",
    "CLAIM_EVIDENCE_ANCHORS",
    "assertClaimEvidenceAnchors",
    "AIPI_ADVERSARIAL_READINESS_TEST_OK",
  ]) {
    if (!adversarialReadiness.includes(requiredText)) {
      errors.push(`tools/test-adversarial-readiness.mjs must include ${requiredText}`);
    }
  }
}
if (packageJson.scripts?.["test:release-fixture"] !== "node tools/test-release-fixture.mjs") {
  errors.push("package.json must include test:release-fixture for P10 clean package fixture verification");
}
if (!packageJson.scripts?.test?.includes("npm run test:release-fixture")) {
  errors.push("package.json test script must run test:release-fixture");
}
if (!fs.existsSync(path.join(root, "tools/test-release-fixture.mjs"))) {
  errors.push("tools/test-release-fixture.mjs is required for P10 release fixture verification");
} else {
  const releaseFixture = read("tools/test-release-fixture.mjs");
  for (const requiredText of [
    "AIPI_RELEASE_FIXTURE_TEST_OK",
    "materializePackageFiles",
    "initProject",
    "clean-project",
    "runAipiStatus",
    "aipi.readiness-report.v1",
    "provider.anthropic.auth",
    "model.capability_floors",
    "pressure.model_backed",
    "smoke.live_subagent",
    "Readiness: blocked",
  ]) {
    if (!releaseFixture.includes(requiredText)) {
      errors.push(`tools/test-release-fixture.mjs must include ${requiredText}`);
    }
  }
}
if (!fs.existsSync(path.join(root, "extensions/aipi/runtime/workflow-executor.js"))) {
  errors.push("extensions/aipi/runtime/workflow-executor.js is required for workflow execution");
} else {
  const workflowExecutor = read("extensions/aipi/runtime/workflow-executor.js");
  for (const requiredText of [
    "executeWorkflowRun",
    "validateStepResult",
    "assertControllerWriteAllowed",
    "createSubagentWorkflowAdapter",
    "executeFanoutSubagentStep",
    "dispatchSubagent",
    "local-workflow-slice-v1",
    "quick_change",
    "local-quick-slice-v1",
  ]) {
    if (!workflowExecutor.includes(requiredText)) {
      errors.push(`runtime/workflow-executor.js must include ${requiredText}`);
    }
  }
}
if (packageJson.scripts?.["test:step-result"] !== "node tools/test-step-result.mjs") {
  errors.push("package.json must include test:step-result for aipi.step-result.v1");
}
if (!packageJson.scripts?.test?.includes("npm run test:step-result")) {
  errors.push("package.json test script must run test:step-result");
}
if (!packageJson.pi || !Array.isArray(packageJson.pi.extensions) || packageJson.pi.extensions.length === 0) {
  errors.push("package.json must declare pi.extensions");
} else {
  for (const extensionPath of packageJson.pi.extensions) {
    if (!fs.existsSync(path.join(root, extensionPath))) {
      errors.push(`package.json pi.extensions path does not exist: ${extensionPath}`);
    }
  }
}
if (packageJson.pi?.skills) {
  for (const skillsPath of packageJson.pi.skills) {
    if (!fs.existsSync(path.join(root, skillsPath))) {
      errors.push(`package.json pi.skills path does not exist: ${skillsPath}`);
    }
  }
}
const anthropicAuth = contract.providerAuth?.anthropic;
if (!anthropicAuth) {
  errors.push("runtime-contract missing providerAuth.anthropic");
} else {
  const runtimeContractText = read("templates/.aipi/runtime-contract.json");
  const anthropicAuthDoc = read("docs/anthropic-auth-integration.md");
  const transitiveBehavior = JSON.stringify(anthropicAuth.adapterTransitiveBehavior ?? {});
  if (anthropicAuth.loginCommand !== "/login anthropic") {
    errors.push(`runtime-contract providerAuth.anthropic.loginCommand is wrong: ${anthropicAuth.loginCommand}`);
  }
  if (anthropicAuth.autoloadScope !== "anthropic-oauth-only") {
    errors.push("runtime-contract providerAuth.anthropic.autoloadScope must be anthropic-oauth-only");
  }
  if (anthropicAuth.blockedAutoloadPath && packageJson.pi?.extensions?.includes(anthropicAuth.blockedAutoloadPath)) {
    errors.push("package.json pi.extensions must not autoload the broad pi-toolkit index.ts by default");
  }
  if (anthropicAuth.adapterImport !== "../../../node_modules/@ersintarhan/pi-toolkit/src/claude-oauth-adapter.ts") {
    errors.push("runtime-contract providerAuth.anthropic.adapterImport must point at the narrow Claude OAuth adapter");
  }
  if (!runtimeContractText.includes("does not autoload the package's broad index.ts by default")) {
    errors.push("runtime-contract providerAuth.anthropic.rule must document the pi-toolkit trust-surface decision");
  }
  for (const requiredText of [
    "Claude Code identity",
    "x-anthropic-billing-header",
    "before_provider_request",
  ]) {
    if (!transitiveBehavior.includes(requiredText) || !anthropicAuthDoc.includes(requiredText)) {
      errors.push(`Anthropic provider contract and docs must disclose adapter transitive behavior: ${requiredText}`);
    }
  }
  const adapterSourcePath = "node_modules/@ersintarhan/pi-toolkit/src/claude-oauth-adapter.ts";
  if (fs.existsSync(path.join(root, adapterSourcePath))) {
    const adapterSource = read(adapterSourcePath);
    for (const [adapterNeedle, disclosureNeedle] of [
      ["IDENTITY_BLOCK", "Claude Code identity"],
      ["x-anthropic-billing-header", "x-anthropic-billing-header"],
      ["before_provider_request", "before_provider_request"],
    ]) {
      if (
        adapterSource.includes(adapterNeedle) &&
        (!transitiveBehavior.includes(disclosureNeedle) || !anthropicAuthDoc.includes(disclosureNeedle))
      ) {
        errors.push(`Anthropic adapter source includes ${adapterNeedle}; contract/docs must disclose ${disclosureNeedle}`);
      }
    }
  }
}
for (const [providerName, provider] of providerAuthEntries) {
  for (const field of ["providerId", "package", "version", "extensionPath", "loginCommand"]) {
    if (!provider?.[field]) {
      errors.push(`runtime-contract providerAuth.${providerName}.${field} is required`);
    }
  }
  if (provider?.package && provider?.version && packageJson.dependencies?.[provider.package] !== provider.version) {
    errors.push(`package.json must pin ${provider.package} to providerAuth.${providerName}.version ${provider.version}`);
  }
  if (provider?.extensionPath && !packageJson.pi?.extensions?.includes(provider.extensionPath)) {
    errors.push(`package.json pi.extensions must load providerAuth.${providerName} from ${provider.extensionPath}`);
  }
}
const providerAuthRuntime = read("extensions/aipi/runtime/provider-auth.js");
if (anthropicAuth?.version && providerAuthRuntime.includes(anthropicAuth.version)) {
  errors.push("provider-auth runtime must derive Anthropic package version from providerAuth.anthropic, not hard-code it");
}
if (providerAuthRuntime.includes("defaultAnthropicContract")) {
  errors.push("provider-auth runtime must not keep a defaultAnthropicContract fallback");
}
if (!providerAuthRuntime.includes("contract.data?.providerAuth?.anthropic")) {
  errors.push("provider-auth runtime must load providerAuth.anthropic from templates/.aipi/runtime-contract.json");
}
const anthropicWrapperPath = "extensions/aipi/provider/anthropic-oauth-only.ts";
if (!fs.existsSync(path.join(root, anthropicWrapperPath))) {
  errors.push(`${anthropicWrapperPath} is required to narrow Anthropic OAuth autoload scope`);
} else {
  const wrapper = read(anthropicWrapperPath);
  for (const requiredText of [
    "claude-oauth-adapter.ts",
    "aipiAnthropicOauthOnly",
  ]) {
    if (!wrapper.includes(requiredText)) {
      errors.push(`${anthropicWrapperPath} must include ${requiredText}`);
    }
  }
  for (const forbiddenText of [
    "native-search",
    "auto-context",
    "registerProvider",
    "pi-toolkit/index",
  ]) {
    if (wrapper.includes(forbiddenText)) {
      errors.push(`${anthropicWrapperPath} must not include broad pi-toolkit surface ${forbiddenText}`);
    }
  }
}

if (errors.length) {
  console.error(errors.map((err) => `ERROR ${err}`).join("\n"));
  process.exit(1);
}

console.log(
  `AIPI_TEMPLATE_VALIDATION_OK agents=${agents.size} workflows=${list("templates/.aipi/workflows", ".yaml").length} stages=${contract.canonicalStages.length} skipConditions=${skipConditions.size}`,
);

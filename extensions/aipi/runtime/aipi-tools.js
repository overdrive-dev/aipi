import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { piStreamingUpdate, runGuardedCommand } from "./command-watchdog.js";

export const AIPI_RUNTIME_TOOL_NAMES = [
  "aipi_memory_query",
  "aipi_rule_lookup",
  "aipi_rule_gap",
  "aipi_callers",
  "aipi_impact",
  "aipi_retrieve",
  "aipi_semantic_search",
  "aipi_guarded_bash",
  "aipi_kanban_update",
  "aipi_promote_memory",
];

const PROJECT_MEMORY_KIND_TO_FILE = new Map([
  ["business-rule", "business-rules.md"],
  ["business-rules", "business-rules.md"],
  ["decision", "decisions.md"],
  ["decisions", "decisions.md"],
  ["deployment", "deployment.md"],
  ["environment", "environment.md"],
  ["glossary", "glossary.md"],
  ["knowledge", "knowledge.md"],
  ["procedure", "procedures.md"],
  ["procedures", "procedures.md"],
  ["project", "project.md"],
]);
const MEMORY_PAGE_TYPES = new Set(["business-rule", "decision", "knowledge", "environment", "procedure", "deployment", "glossary", "project"]);
const PROJECT_MEMORY_FILE_TO_TYPE = new Map([
  ["business-rules.md", "business-rule"],
  ["decisions.md", "decision"],
  ["deployment.md", "deployment"],
  ["environment.md", "environment"],
  ["glossary.md", "glossary"],
  ["knowledge.md", "knowledge"],
  ["procedures.md", "procedure"],
  ["project.md", "project"],
]);
const MEMORY_TYPE_OWNER = new Map([
  ["business-rule", "product"],
  ["decision", "engineering"],
  ["deployment", "devops"],
  ["environment", "devops"],
  ["glossary", "product"],
  ["knowledge", "engineering"],
  ["procedure", "operations"],
  ["project", "project"],
]);

const CODE_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const VECTOR_EMBED_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".ts",
  ".tsx",
]);

const SKIP_DIRS = new Set([
  ".git",
  ".aipi",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".expo",
  ".venv",
  "venv",
  "__pycache__",
  ".turbo",
  ".gradle",
]);
const SKIP_REL_DIRS = new Set(["ios/Pods", "android/build"]);
const GRAPH_REL_PATH = ".aipi/state/aipi-graph.json";
const GRAPH_SQLITE_REL_PATH = ".aipi/state/aipi-graph.sqlite";
const GRAPH_VECTOR_DIMENSIONS = 1024;
const SQLITE_SIDECAR_SUFFIXES = ["-journal", "-wal", "-shm"];
const VECTOR_CHUNK_WINDOW_LINES = 32;
const VECTOR_CHUNK_WINDOW_OVERLAP_LINES = 8;
const VECTOR_CHUNK_MAX_CHARS = 12_000;
const SEMANTIC_CONFIG_REL_PATH = ".aipi/semantic-memory.json";
const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "bge-m3";
const LEGACY_DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
const LEGACY_DEFAULT_VECTOR_DIMENSIONS = 768;
const OLLAMA_EMBED_PATH = "/api/embed";
const OLLAMA_TAGS_PATH = "/api/tags";
const OLLAMA_PULL_PATH = "/api/pull";
const DEFAULT_OLLAMA_PULL_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_GRAPH_RELATIONSHIPS = 2500;
const MAX_CALL_RELATIONSHIPS_PER_FILE = 25;
const VECTOR_FILE_SUBPROGRESS_CHUNK_THRESHOLD = 25;
const VECTOR_FILE_SUBPROGRESS_CHUNK_INTERVAL = 10;
const RELATIONSHIP_PRIORITY = new Map([
  ["test_covers", 0],
  ["business_rule_impacts_code", 10],
  ["bdd_contract_impacts_code", 20],
  ["deployment_impacts_code", 30],
  ["calls", 35],
  ["run_outcome_impacts_code", 40],
  ["run_verifies_rule", 50],
  ["run_fails_rule", 50],
  ["run_blocks_rule", 50],
  ["run_skips_rule", 50],
  ["business_rule_conflicts", 60],
  ["business_rule_implements_code", 61],
  ["business_rule_relates_rule", 62],
  ["business_rule_decided_by", 63],
  ["decision_references_rule", 64],
  ["decision_references_code", 65],
  ["decision_references_test", 66],
  ["mentions_file", 70],
  ["mentions_symbol", 80],
  ["defines", 90],
]);
const GENERIC_TEST_COVER_STEMS = new Set([
  "__init__",
  "__main__",
  "conftest",
  "index",
  "main",
  "mod",
  "setup",
  "types",
]);
const HYBRID_RRF_K = 60;
const HYBRID_SIGNAL_WEIGHTS = {
  semantic: 1.0,
  lexical: 1.15,
  graph: 0.85,
  rules: 1.05,
};
const RULE_LINK_RELATIONS = new Set([
  "business_rule_impacts_code",
  "business_rule_implements_code",
  "bdd_contract_impacts_code",
  "test_covers",
]);
const DOMAIN_TOKEN_ALIASES = new Map([
  ["assinatura", "subscription"],
  ["assinaturas", "subscription"],
  ["billing", "billing"],
  ["cobranca", "billing"],
  ["cobrancas", "billing"],
  ["discount", "discount"],
  ["discounts", "discount"],
  ["desconto", "discount"],
  ["descontos", "discount"],
  ["faturamento", "billing"],
  ["invoice", "billing"],
  ["invoices", "billing"],
  ["preco", "price"],
  ["precos", "price"],
  ["price", "price"],
  ["prices", "price"],
  ["pricing", "price"],
  ["renews", "renew"],
  ["renewal", "renew"],
  ["renewals", "renew"],
  ["renewed", "renew"],
  ["renewing", "renew"],
  ["renovacao", "renew"],
  ["renovacoes", "renew"],
  ["renovada", "renew"],
  ["renovadas", "renew"],
  ["renovado", "renew"],
  ["renovados", "renew"],
  ["renovar", "renew"],
  ["subscription", "subscription"],
  ["subscriptions", "subscription"],
  ["valor", "price"],
  ["valores", "price"],
]);
const PRESERVE_RULE_TERMS = new Set([
  "accepted",
  "current",
  "keep",
  "keeps",
  "maintain",
  "preserve",
  "preserved",
  "preserves",
  "same",
  "aceito",
  "atual",
  "manter",
  "mantem",
  "preserva",
  "preservam",
]);
const REPLACE_RULE_TERMS = new Set([
  "always",
  "different",
  "new",
  "override",
  "recalculate",
  "recalculated",
  "replace",
  "replaced",
  "different",
  "novo",
  "nova",
  "recalcula",
  "recalculado",
  "recalculada",
  "substitui",
]);
const ALLOW_RULE_TERMS = new Set(["allow", "allowed", "permit", "permitted", "permite", "permitido"]);
const DENY_RULE_TERMS = new Set(["block", "blocked", "deny", "denied", "never", "prohibit", "prohibited", "bloqueia", "nega", "nunca", "proibe"]);
const REQUIRED_RULE_TERMS = new Set([
  "deve",
  "devem",
  "mandatory",
  "must",
  "obligatory",
  "obrigatoria",
  "obrigatorias",
  "obrigatorio",
  "obrigatorios",
  "require",
  "required",
  "requires",
  "shall",
]);
const OPTIONAL_RULE_TERMS = new Set([
  "dispensavel",
  "may",
  "omit",
  "omite",
  "omitem",
  "omitir",
  "omitted",
  "optional",
  "optionally",
  "opcional",
  "opcionais",
  "pode",
  "podem",
  "skip",
  "skippable",
]);
const BEFORE_RULE_TERMS = new Set(["antes", "before", "prior"]);
const AFTER_RULE_TERMS = new Set(["after", "apos", "depois", "following"]);
const AUTOMATIC_RULE_TERMS = new Set(["automatic", "automatically", "auto", "automated", "automatica", "automaticamente", "automatico", "automatizada", "automatizado"]);
const MANUAL_RULE_TERMS = new Set(["manual", "manually", "manual-review", "manualmente", "revisao-manual"]);
const DOMAIN_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "de",
  "do",
  "does",
  "for",
  "from",
  "given",
  "if",
  "in",
  "is",
  "it",
  "must",
  "no",
  "not",
  "of",
  "on",
  "or",
  "os",
  "para",
  "por",
  "should",
  "that",
  "the",
  "then",
  "to",
  "um",
  "uma",
  "when",
  "with",
]);

export function registerAipiRuntimeTools(pi, { projectRootResolver = () => process.cwd() } = {}) {
  pi.registerTool({
    name: "aipi_memory_query",
    description: "Query AIPI Markdown memory and return cited source snippets.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        layer: { type: "string", enum: ["project", "user", "all"] },
        limit: { type: "number" },
        type: { type: "string" },
        owner: { type: "string" },
        status: { type: "string" },
        stale_before: { type: "string" },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return jsonResult(await aipiMemoryQuery({ projectRoot: projectRootResolver(ctx), ...params }));
    },
  });

  pi.registerTool({
    name: "aipi_rule_lookup",
    description: "Look up accepted business rules and BDD contracts with source citations.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return jsonResult(await aipiRuleLookup({ projectRoot: projectRootResolver(ctx), ...params }));
    },
  });

  pi.registerTool({
    name: "aipi_rule_gap",
    description: "Classify whether a business decision is covered, a gap, a conflict, or mechanics-only.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return jsonResult(await aipiRuleGap({ projectRoot: projectRootResolver(ctx), ...params }));
    },
  });

  pi.registerTool({
    name: "aipi_callers",
    description: "Return lexical caller/reference matches for a symbol from the rebuildable AIPI code graph.",
    parameters: {
      type: "object",
      required: ["symbol"],
      properties: {
        symbol: { type: "string" },
        limit: { type: "number" },
        rebuild: { type: "boolean" },
      },
    },
    async execute(_id, params, _signal, onUpdate, ctx) {
      return jsonResult(await aipiCallers({
        projectRoot: projectRootResolver(ctx),
        ...params,
        onProgress: runtimeToolProgress(onUpdate),
      }));
    },
  });

  pi.registerTool({
    name: "aipi_impact",
    description: "Return semantic + lexical impact candidates and related tests from the rebuildable AIPI code graph.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        symbol: { type: "string" },
        path: { type: "string" },
        limit: { type: "number" },
        rebuild: { type: "boolean" },
      },
    },
    async execute(_id, params, _signal, onUpdate, ctx) {
      return jsonResult(await aipiImpact({
        projectRoot: projectRootResolver(ctx),
        ...params,
        onProgress: runtimeToolProgress(onUpdate),
      }));
    },
  });

  pi.registerTool({
    name: "aipi_retrieve",
    description:
      "Return fused code context from semantic chunks, lexical matches, graph proximity, and governing rules.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        rebuild: { type: "boolean" },
      },
    },
    async execute(_id, params, _signal, onUpdate, ctx) {
      return jsonResult(await aipiRetrieve({
        projectRoot: projectRootResolver(ctx),
        ...params,
        onProgress: runtimeToolProgress(onUpdate),
      }));
    },
  });

  pi.registerTool({
    name: "aipi_semantic_search",
    description:
      "Run semantic-only code search through Ollama bge-m3 chunk embeddings. Fails loudly if semantic embeddings are unavailable.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        rebuild: { type: "boolean" },
      },
    },
    async execute(_id, params, _signal, onUpdate, ctx) {
      return jsonResult(await aipiSemanticSearch({
        projectRoot: projectRootResolver(ctx),
        ...params,
        onProgress: runtimeToolProgress(onUpdate),
      }));
    },
  });

  pi.registerTool({
    name: "aipi_guarded_bash",
    description:
      "Run a non-interactive shell command through the AIPI command watchdog. Refuses common REPL/editor traps, kills stuck silent commands, and records a diagnostic trace.",
    parameters: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        min_runtime_ms: { type: "number" },
        silence_timeout_ms: { type: "number" },
        hard_cap_ms: { type: "number" },
        allow_interactive: { type: "boolean" },
      },
    },
    async execute(_id, params, _signal, onUpdate, ctx) {
      const projectRoot = projectRootResolver(ctx);
      return jsonResult(await runGuardedCommand({
        projectRoot,
        cwd: params.cwd ?? projectRoot,
        command: params.command,
        minRuntimeMs: params.min_runtime_ms,
        silenceTimeoutMs: params.silence_timeout_ms,
        hardCapMs: params.hard_cap_ms,
        allowInteractive: params.allow_interactive === true,
        onUpdate: piStreamingUpdate(onUpdate),
      }));
    },
  });

  pi.registerTool({
    name: "aipi_kanban_update",
    description: "Append a structured workflow task/status event under .aipi/runtime.",
    parameters: {
      type: "object",
      required: ["task", "status"],
      properties: {
        task: { type: "string" },
        status: { type: "string" },
        run_id: { type: "string" },
        notes: { type: "string" },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return jsonResult(await aipiKanbanUpdate({ projectRoot: projectRootResolver(ctx), ...params }));
    },
  });

  pi.registerTool({
    name: "aipi_promote_memory",
    description:
      "Promote approved reusable knowledge into Markdown memory, or record an unapproved candidate under runtime.",
    parameters: {
      type: "object",
      required: ["kind", "content", "source_ref"],
      properties: {
        kind: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        source_ref: { type: "string" },
        approved: { type: "boolean" },
        approval_ref: { type: "string" },
        user_memory: { type: "boolean" },
        run_id: { type: "string" },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return jsonResult(await aipiPromoteMemory({ projectRoot: projectRootResolver(ctx), ...params }));
    },
  });
}

function runtimeToolProgress(onUpdate) {
  if (typeof onUpdate !== "function") return null;
  return (event) => {
    // Pi renders EVERY onUpdate value as a partial tool result — getTextOutput does result.content.filter(...)
    // with no guard, so a partial WITHOUT a `content` array throws an uncaught TypeError that crashes the whole
    // session (the same class as the aipi_guarded_bash bug). Emit a content-shaped partial (the
    // tool-result contract) and swallow any render failure — streamed progress is advisory and must never
    // break the tool run.
    try {
      onUpdate({ content: [{ type: "text", text: event?.message ? `${event.message}\n` : "" }] });
    } catch {
      /* progress is best-effort */
    }
  };
}

export async function aipiMemoryQuery({
  projectRoot,
  query = "",
  layer = "project",
  limit = 8,
  type = null,
  owner = null,
  status = null,
  stale_before = null,
  staleBefore = null,
} = {}) {
  const root = assertRoot(projectRoot);
  const files = await memoryFiles(root, layer);
  const filters = normalizeMemoryFilters({ type, owner, status, stale_before: stale_before ?? staleBefore });
  const refs = await searchFiles({ root, files, query, limit, filters });
  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_memory_query",
    query,
    layer,
    filters,
    refs,
  };
}

export async function aipiRuleLookup({
  projectRoot,
  query = "",
  limit = 8,
} = {}) {
  const root = assertRoot(projectRoot);
  const files = [
    path.join(root, ".aipi", "memory", "project", "business-rules.md"),
    ...(await findRunContracts(root)),
  ];
  const refs = await searchFiles({ root, files, query, limit });
  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_rule_lookup",
    query,
    refs,
  };
}

export async function aipiRuleGap({
  projectRoot,
  query,
  limit = 8,
} = {}) {
  if (!query?.trim()) throw new Error("aipi_rule_gap requires query");
  const lookup = await aipiRuleLookup({ projectRoot, query, limit });
  const joinedMatchedLines = lookup.refs.map((ref) => ref.text ?? "").join("\n").toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let classification = "GAP";
  if (/\b(mechanical|mechanics|mecanica|mecânico|refactor|format)\b/i.test(normalizedQuery)) {
    classification = "MECHANICS";
  } else if (
    lookup.refs.length &&
    (/\b(conflict|conflicts|contradict|contradiction|conflito|contradicao)\b/i.test(normalizedQuery) ||
      /\b(conflict|conflicts|contradict|contradiction|conflito|contradicao)\b/i.test(joinedMatchedLines))
  ) {
    classification = "CONFLICT";
  } else if (lookup.refs.length) {
    classification = "COVERED";
  }
  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_rule_gap",
    query,
    classification,
    refs: lookup.refs,
    next_action:
      classification === "GAP" || classification === "CONFLICT"
        ? "ask one focused business-rule question before implementation"
        : "continue workflow",
  };
}

export async function rebuildCodeGraph({
  projectRoot,
  now = () => new Date(),
  env = process.env,
  embeddingFetch = globalThis.fetch,
  previousGraph = null,
  pullEmbeddings = false,
  onProgress = null,
  platform = process.platform,
  pullTimeoutMs = DEFAULT_OLLAMA_PULL_TIMEOUT_MS,
} = {}) {
  const root = assertRoot(projectRoot);
  const embeddingConfig = await resolveSemanticEmbeddingConfig({ root, env, migrate: true });
  const files = await listProjectFiles(root);
  const runReferenceFiles = await listRunReferenceFiles(root);
  const runOutcomes = await summarizeRunOutcomes({ root, runReferenceFiles });
  const graphFiles = [];
  const symbols = [];

  for (const rel of files) {
    const abs = path.join(root, rel);
    const content = await fs.readFile(abs, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    graphFiles.push({
      path: rel,
      line_count: lines.length,
      size: Buffer.byteLength(content, "utf8"),
      hash: contentHash(content),
      memory_metadata: memoryFrontmatterForFile(rel, content),
    });
    for (const symbol of extractSymbols(content, rel)) {
      symbols.push(symbol);
    }
  }

  const graph = {
    schema: "aipi.code-graph.v1",
    built_at: now().toISOString(),
    source: "sqlite+lexical",
    stale: false,
    files: graphFiles,
    symbols,
    run_outcomes: runOutcomes,
    relationships: await buildRelationships({ root, files: graphFiles, symbols, runReferenceFiles, runOutcomes }),
  };
  graph.sqlite = await writeSqliteGraph({
    root,
    graph,
    previousGraph,
    env,
    embeddingFetch,
    embeddingConfig,
    pullEmbeddings,
    onProgress,
    platform,
    pullTimeoutMs,
  });
  graph.vector = graph.sqlite.vector ?? {
    status: "unavailable",
    engine: "sqlite-vec",
    dimensions: embeddingConfig.dimensions,
    semantic_backend: "ollama",
    embedding_model: embeddingConfig.model,
    embedding_host: embeddingConfig.host,
    config_migration: embeddingConfig.config_migration ?? null,
    reason: "sqlite sidecar unavailable",
  };
  graph.source = graph.vector.status === "available" ? "sqlite+sqlite-vec+lexical" : "sqlite+lexical";
  graph.freshness = graphFreshnessFresh({ checkedAt: graph.built_at, fileCount: graph.files.length });
  const graphPath = path.join(root, GRAPH_REL_PATH);
  await fs.mkdir(path.dirname(graphPath), { recursive: true });
  await fs.writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  return graph;
}

export async function aipiCallers({
  projectRoot,
  symbol,
  limit = 12,
  rebuild = false,
  env = process.env,
  embeddingFetch = globalThis.fetch,
  onProgress = null,
} = {}) {
  if (!symbol?.trim()) throw new Error("aipi_callers requires symbol");
  const root = assertRoot(projectRoot);
  const graph = await ensureGraph(root, { rebuild, env, embeddingFetch, onProgress });
  const refs = await graphRefs({ root, graph, query: symbol, limit, env, embeddingFetch });
  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_callers",
    symbol,
    graph: graphSummary(graph),
    refs,
  };
}

export async function aipiImpact({
  projectRoot,
  query = "",
  symbol = "",
  path: targetPath = "",
  limit = 16,
  rebuild = false,
  env = process.env,
  embeddingFetch = globalThis.fetch,
  onProgress = null,
} = {}) {
  const root = assertRoot(projectRoot);
  const graph = await ensureGraph(root, { rebuild, env, embeddingFetch, onProgress });
  const needle = symbol || query || targetPath;
  const refs = needle ? await graphRefs({ root, graph, query: needle, limit, env, embeddingFetch }) : [];
  const relatedTests = graph.files
    .map((file) => file.path)
    .filter((rel) => /(^|\/)(test|tests|__tests__)\/|(\.test|\.spec)\./i.test(rel))
    .filter((rel) => !targetPath || sharesStem(rel, targetPath))
    .slice(0, Math.max(4, Math.min(limit, 12)));
  const relationships = await graphRelationships({ root, graph, query: needle, targetPath, limit });

  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_impact",
    query: needle,
    graph: graphSummary(graph),
    refs,
    relationships,
    related_tests: relatedTests,
  };
}

export async function aipiRetrieve({
  projectRoot,
  query = "",
  limit = 12,
  rebuild = false,
  env = process.env,
  embeddingFetch = globalThis.fetch,
  onProgress = null,
} = {}) {
  if (!query?.trim()) throw new Error("aipi_retrieve requires query");
  const root = assertRoot(projectRoot);
  const graph = await ensureGraph(root, { rebuild, env, embeddingFetch, onProgress });
  const needle = query.trim();
  const resultLimit = Math.max(1, limit);
  const signalLimit = Math.max(16, Math.min(64, resultLimit * 4));
  const queryPaths = queryGraphPaths(graph, needle);

  const semanticRefs = await graphRefs({
    root,
    graph,
    query: needle,
    limit: signalLimit,
    semanticOnly: true,
    env,
    embeddingFetch,
  }).catch(() => []);
  const lexicalRefs = await graphLexicalRefs({ root, graph, query: needle, limit: signalLimit }).catch(() => []);
  const matchingRelationships = uniqueRelationships([
    ...await graphRelationships({ root, graph, query: needle, limit: signalLimit }).catch(() => []),
    ...(graph.relationships ?? [])
      .filter((edge) => relationshipTouchesAnyPath(edge, queryPaths, graph))
      .map((edge) => ({ ...edge, source: edge.source ?? "manifest" })),
  ]).slice(0, signalLimit);
  const seedRefs = mergeRefs([...semanticRefs, ...lexicalRefs], signalLimit);
  const graphExpansionRefs = graphProximityRefs({
    graph,
    query: needle,
    seedRefs,
    seedRelationships: matchingRelationships,
    limit: signalLimit,
  });
  const ruleRefs = ruleLinkedRefs({
    graph,
    query: needle,
    seedRefs,
    seedRelationships: matchingRelationships,
    limit: signalLimit,
  });
  const refs = decorateHybridRefs({
    graph,
    query: needle,
    seedRelationships: matchingRelationships,
    refs: fuseHybridRefs({
      signals: [
        { name: "semantic", refs: semanticRefs },
        { name: "lexical", refs: lexicalRefs },
        { name: "graph", refs: graphExpansionRefs },
        { name: "rules", refs: ruleRefs },
      ],
      limit: resultLimit,
    }),
  });

  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_retrieve",
    query: needle,
    graph: graphSummary(graph),
    refs,
    relationships: uniqueRelationships([
      ...matchingRelationships,
      ...refs.flatMap((ref) => ref.relationships ?? []),
      ...refs.flatMap((ref) => ref.governing_rules ?? []),
    ]).slice(0, signalLimit),
    fusion: {
      method: "reciprocal_rank_fusion",
      k: HYBRID_RRF_K,
      weights: HYBRID_SIGNAL_WEIGHTS,
    },
  };
}

export async function aipiSemanticSearch({
  projectRoot,
  query = "",
  limit = 12,
  rebuild = false,
  env = process.env,
  embeddingFetch = globalThis.fetch,
  onProgress = null,
} = {}) {
  if (!query?.trim()) throw new Error("aipi_semantic_search requires query");
  const root = assertRoot(projectRoot);
  const graph = await ensureGraph(root, { rebuild, env, embeddingFetch, onProgress });
  const refs = await graphRefs({ root, graph, query, limit, semanticOnly: true, env, embeddingFetch });
  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_semantic_search",
    query,
    graph: graphSummary(graph),
    refs,
  };
}

export async function aipiKanbanUpdate({
  projectRoot,
  task,
  status,
  run_id = null,
  notes = "",
  now = () => new Date(),
} = {}) {
  const root = assertRoot(projectRoot);
  if (!task?.trim()) throw new Error("aipi_kanban_update requires task");
  if (!status?.trim()) throw new Error("aipi_kanban_update requires status");
  const event = {
    schema: "aipi.kanban-event.v1",
    task,
    status,
    run_id,
    notes,
    recorded_at: now().toISOString(),
  };
  const runtimeDir = path.join(root, ".aipi", "runtime");
  await fs.mkdir(runtimeDir, { recursive: true });
  await appendJsonLine(path.join(runtimeDir, "kanban.jsonl"), event);
  if (run_id) {
    await appendJsonLine(path.join(runtimeDir, "runs", run_id, "events.jsonl"), {
      ...event,
      type: "kanban_update",
    });
  }
  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_kanban_update",
    event,
    path: ".aipi/runtime/kanban.jsonl",
  };
}

// RC5: best-effort durable-memory versioning. After a successful durable write we commit ONLY the written
// memory file(s) so every promotion is reviewable/revertable. Flag-gated (AIPI_MEMORY_AUTOCOMMIT, default on),
// degrades SILENTLY when not a git repo or git fails — a promotion NEVER fails because its commit failed.
// The git runner is injectable for tests.
function memoryAutocommitEnabled(env = process.env) {
  const value = String(env?.AIPI_MEMORY_AUTOCOMMIT ?? "1").toLowerCase();
  return !["0", "false", "off", "no"].includes(value);
}

function defaultMemoryGit(root, args) {
  return spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

export async function commitDurableMemory({ root, files = [], message = "aipi(memory): promote", env = process.env, git = defaultMemoryGit } = {}) {
  if (!memoryAutocommitEnabled(env)) return { committed: false, reason: "disabled" };
  if (!files.length) return { committed: false, reason: "no_files" };
  try {
    const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside || inside.status !== 0 || String(inside.stdout ?? "").trim() !== "true") {
      return { committed: false, reason: "not_a_git_repo" };
    }
    const add = git(root, ["add", "--", ...files]);
    if (add?.status !== 0) return { committed: false, reason: `git add failed: ${String(add?.stderr ?? "").trim().slice(0, 200)}` };
    const commit = git(root, ["commit", "-m", message, "--", ...files]);
    if (commit?.status !== 0) {
      const out = `${commit?.stdout ?? ""}${commit?.stderr ?? ""}`;
      if (/nothing to commit|no changes added|nothing added/i.test(out)) return { committed: false, reason: "no_change" };
      return { committed: false, reason: `git commit failed: ${out.trim().slice(0, 200)}` };
    }
    return { committed: true };
  } catch (error) {
    return { committed: false, reason: `git error: ${String(error?.message ?? error)}` };
  }
}

// P1: append-only audit ledger for durable memory — one provenance line per promote/defer so the whole
// pipeline is inspectable (event, kind, source, approval decision+source, hash). Lives UNDER .aipi/memory so
// RC5 versioning tracks it. Best-effort: a ledger failure never fails the operation.
const MEMORY_AUDIT_LEDGER_REL = ".aipi/memory/audit-ledger.jsonl";

async function appendMemoryAudit(root, entry) {
  try {
    await appendJsonLine(path.join(root, MEMORY_AUDIT_LEDGER_REL), { schema: "aipi.memory-audit.v1", ...entry });
  } catch {
    // ledger is advisory; never break a promotion because the audit append failed
  }
}

export async function aipiPromoteMemory({
  projectRoot,
  kind,
  title = "",
  content,
  source_ref,
  approved = false,
  approval_ref = "",
  user_memory = false,
  run_id = null,
  env = process.env,
  commitMemory = commitDurableMemory,
  now = () => new Date(),
} = {}) {
  const root = assertRoot(projectRoot);
  if (!kind?.trim()) throw new Error("aipi_promote_memory requires kind");
  if (!content?.trim()) throw new Error("aipi_promote_memory requires content");
  if (!source_ref?.trim()) throw new Error("aipi_promote_memory requires source_ref");

  const timestamp = now().toISOString();
  const approval = await inspectDurableMemoryApproval(root, approval_ref);
  const approvedForDurableWrite = approval.ok;
  const promotionHash = memoryPromotionHash({ kind, title, content, source_ref });
  const entry = renderMemoryEntry({
    kind,
    title,
    content,
    source_ref,
    approval_ref,
    timestamp,
    promotionHash,
    accepted: approvedForDurableWrite,
  });

  if (!approvedForDurableWrite) {
    // Include the promotion hash so distinct candidates never collide on the same filename — even multiple
    // rules of the same kind captured in the same millisecond (otherwise writeProjectFile would overwrite).
    // Use ONLY the hex digest (drop the "sha256:" prefix): a colon is a legal filename char on POSIX but on
    // Windows/NTFS it opens an Alternate Data Stream, so `...-sha256:abcd.json` silently writes a stream on a
    // truncated file and the candidate vanishes from readdir — breaking the drain on every Windows client.
    const hashSegment = String(promotionHash).split(":").pop().slice(0, 12);
    const candidateBase = path.posix.join(".aipi", "runtime", "memory-candidates", `${timestamp.replace(/[:.]/g, "-")}-${slug(kind)}-${hashSegment}`);
    const candidateRel = `${candidateBase}.md`;
    const candidateJsonRel = `${candidateBase}.json`;
    await writeProjectFile(root, candidateRel, entry);
    // P1: structured sidecar so the drain can re-promote the EXACT fields (the .md is rendered/lossy).
    await writeProjectFile(root, candidateJsonRel, `${JSON.stringify({
      schema: "aipi.memory-candidate.v1",
      status: "candidate",
      kind,
      title,
      content,
      source_ref,
      user_memory,
      promotion_hash: promotionHash,
      created_at: timestamp,
      md_path: candidateRel,
      reason: approval_ref ? approval.reason : "no approval_ref",
    }, null, 2)}\n`);
    await appendMemoryAudit(root, {
      recorded_at: timestamp,
      event: "deferred",
      kind,
      title: title || null,
      source_ref,
      promotion_hash: promotionHash,
      approval: { ok: false, reason: approval_ref ? approval.reason : "no approval_ref" },
      candidate_path: candidateJsonRel,
    });
    return {
      schema: "aipi.tool-result.v1",
      tool: "aipi_promote_memory",
      status: "deferred",
      reason: approval_ref
        ? approval.reason
        : "durable memory promotion requires approval_ref for an existing .aipi/runtime/approvals/approved artifact",
      candidate_path: candidateRel,
      candidate_json_path: candidateJsonRel,
      approved_ignored: Boolean(approved),
    };
  }

  const targetRel = user_memory
    ? ".aipi/memory/user.local.md"
    : path.posix.join(".aipi", "memory", "project", projectMemoryFileForKind(kind));
  const insertion = await insertMemoryEntry({
    root,
    targetRel,
    entry,
    kind,
    timestamp,
    sourceRef: source_ref,
    promotionHash,
  });
  await appendMemoryAudit(root, {
    recorded_at: timestamp,
    event: "promoted",
    kind,
    title: title || null,
    source_ref,
    promotion_hash: promotionHash,
    approval: { decision: approval.decision ?? "APPROVED", source: approval.source ?? "unknown" },
    path: targetRel,
    changed: insertion.changed,
  });
  let memoryCommit = { committed: false, reason: "unchanged" };
  if (insertion.changed) {
    memoryCommit = await commitMemory({
      root,
      files: [targetRel, MEMORY_AUDIT_LEDGER_REL],
      message: `aipi(memory): promote ${kind} (${promotionHash.slice(0, 12)}) from ${source_ref}`,
      env,
    });
  }
  if (run_id) {
    await aipiKanbanUpdate({
      projectRoot: root,
      task: `memory:${kind}`,
      status: "promoted",
      run_id,
      notes: targetRel,
      now,
    });
  }
  return {
    schema: "aipi.tool-result.v1",
    tool: "aipi_promote_memory",
    status: "promoted",
    changed: insertion.changed,
    already_present: !insertion.changed,
    path: targetRel,
    promotion_hash: promotionHash,
    committed: memoryCommit.committed,
    commit_reason: memoryCommit.reason ?? null,
  };
}

async function memoryFiles(root, layer) {
  const files = [];
  if (layer === "project" || layer === "all") {
    files.push(...(await listMarkdownFiles(path.join(root, ".aipi", "memory", "project"))));
  }
  if (layer === "user" || layer === "all") {
    const userLocal = path.join(root, ".aipi", "memory", "user.local.md");
    if (await pathExists(userLocal)) files.push(userLocal);
  }
  return files;
}

async function searchFiles({ root, files, query, limit, filters = {} }) {
  const terms = tokenize(query);
  const refs = [];
  for (const file of files) {
    if (!(await pathExists(file))) continue;
    const rel = path.relative(root, file).replaceAll("\\", "/");
    const text = await fs.readFile(file, "utf8");
    const metadata = memoryFrontmatterForFile(rel, text);
    if (!memoryMetadataMatches(metadata, filters)) continue;
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const score = terms.size ? scoreLine(line, terms) : (/^#{1,3}\s+/.test(line) ? 1 : 0);
      if (score <= 0) continue;
      refs.push({
        path: rel,
        line: index + 1,
        score,
        text: line,
        excerpt: excerptAround(lines, index, 5),
        metadata,
      });
    }
  }
  return refs.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, limit);
}

function normalizeMemoryFilters({ type = null, owner = null, status = null, stale_before = null } = {}) {
  const filters = {};
  if (String(type ?? "").trim()) filters.type = slug(type);
  if (String(owner ?? "").trim()) filters.owner = String(owner).trim();
  if (String(status ?? "").trim()) filters.status = String(status).trim();
  if (String(stale_before ?? "").trim()) filters.stale_before = String(stale_before).trim();
  return filters;
}

function memoryMetadataMatches(metadata, filters = {}) {
  if (!filters || !Object.keys(filters).length) return true;
  const source = metadata ?? {};
  if (filters.type && source.type !== filters.type) return false;
  if (filters.owner && source.owner !== filters.owner) return false;
  if (filters.status && source.status !== filters.status) return false;
  if (filters.stale_before && !memoryReviewIsStale(source.last_reviewed, filters.stale_before)) return false;
  return true;
}

function memoryReviewIsStale(lastReviewed, staleBefore) {
  const cutoff = parseDateOnly(staleBefore);
  if (!cutoff) return false;
  const reviewed = parseDateOnly(lastReviewed);
  if (!reviewed) return true;
  return reviewed < cutoff;
}

function parseDateOnly(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function parseMemoryFrontmatter(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  if (lines[0] !== "---") return null;
  const metadata = {};
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "---") return normalizeMemoryFrontmatter(metadata);
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;
    const key = field[1].replaceAll("-", "_");
    metadata[key] = field[2].trim();
  }
  return null;
}

function memoryFrontmatterForFile(rel, text) {
  const metadata = parseMemoryFrontmatter(text);
  if (!metadata) return null;
  const inferredType = PROJECT_MEMORY_FILE_TO_TYPE.get(path.basename(rel));
  return normalizeMemoryFrontmatter({
    ...metadata,
    type: metadata.type ?? inferredType,
  });
}

function normalizeMemoryFrontmatter(metadata = {}) {
  const rawType = String(metadata.type ?? "").trim();
  const type = rawType ? slug(rawType) : null;
  return {
    type: MEMORY_PAGE_TYPES.has(type) ? type : type || null,
    owner: String(metadata.owner ?? "").trim() || null,
    status: String(metadata.status ?? "").trim() || null,
    last_reviewed: String(metadata.last_reviewed ?? "").trim() || null,
  };
}

async function findRunContracts(root) {
  const runsDir = path.join(root, ".aipi", "runtime", "runs");
  const entries = await fs.readdir(runsDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name, "BDD-CONTRACT.md"));
}

async function ensureGraph(root, {
  rebuild = false,
  env = process.env,
  embeddingFetch = globalThis.fetch,
  onProgress = null,
} = {}) {
  if (!rebuild) {
    const existing = await readJson(path.join(root, GRAPH_REL_PATH));
    if (existing?.schema === "aipi.code-graph.v1" && !existing.stale && (await graphSidecarReady(root, existing))) {
      const freshness = await inspectGraphFreshness(root, existing, { env });
      if (!freshness.stale) {
        return { ...existing, stale: false, freshness };
      }
      const rebuilt = await rebuildCodeGraph({ projectRoot: root, previousGraph: existing, env, embeddingFetch, onProgress });
      return { ...rebuilt, rebuilt_from_stale: freshness };
    }
  }
  const previousGraph = await readJson(path.join(root, GRAPH_REL_PATH)).catch(() => null);
  return rebuildCodeGraph({ projectRoot: root, previousGraph, env, embeddingFetch, onProgress });
}

async function graphSidecarReady(root, graph) {
  if (graph.sqlite?.status !== "available") return true;
  return pathExists(path.join(root, graph.sqlite.path ?? GRAPH_SQLITE_REL_PATH));
}

async function graphRefs({ root, graph, query, limit, semanticOnly = false, env = process.env, embeddingFetch = globalThis.fetch }) {
  const sqlite = await sqliteRefs({ root, query, limit, semanticOnly, env, embeddingFetch });
  if (sqlite) return sqlite;
  if (semanticOnly) {
    throw semanticUnavailableError("semantic-only search is unavailable because the SQLite vector index is missing.");
  }
  return lexicalRefs({ root, files: graph.files.map((file) => file.path), query, limit });
}

async function graphLexicalRefs({ root, graph, query, limit }) {
  const sqlite = await sqliteLexicalRefs({ root, query, limit });
  if (sqlite) return sqlite;
  return lexicalRefs({ root, files: graph.files.map((file) => file.path), query, limit });
}

async function graphRelationships({ root, graph, query = "", targetPath = "", limit = 16 } = {}) {
  const sqlite = await sqliteRelationshipRefs({ root, query, targetPath, limit });
  if (sqlite) return sqlite;
  return relationshipRefsFromGraph({ graph, query, targetPath, limit, source: "manifest" });
}

async function sqliteRefs({ root, query, limit, semanticOnly = false, env = process.env, embeddingFetch = globalThis.fetch }) {
  const needle = String(query ?? "").trim();
  if (!needle) return [];
  const sqlite = await loadSqlite();
  if (!sqlite) {
    if (semanticOnly) throw semanticUnavailableError("semantic-only search requires node:sqlite.");
    return null;
  }
  const sqlitePath = path.join(root, GRAPH_SQLITE_REL_PATH);
  if (!(await pathExists(sqlitePath))) {
    if (semanticOnly) throw semanticUnavailableError("semantic-only search requires a built AIPI SQLite graph.");
    return null;
  }

  let db;
  try {
    db = new sqlite.DatabaseSync(sqlitePath, { readOnly: true, allowExtension: true });
    const source = db.prepare("SELECT value FROM meta WHERE key = 'source'").get()?.value ?? "";
    const vectorEnabled = String(source).includes("sqlite-vec");
    const exact = sqliteLexicalRows(db, needle, limit);
    if (!vectorEnabled && semanticOnly) {
      throw semanticUnavailableError("semantic-only search requires a built sqlite-vec index.");
    }
    const vectorRows = vectorEnabled
      ? await sqliteVectorRefs({ db, root, query: needle, limit, semanticOnly, env, embeddingFetch })
      : [];
    return semanticOnly ? vectorRows : mergeRefs([...exact, ...vectorRows], limit);
  } catch (error) {
    if (semanticOnly) throw asSemanticUnavailable(error);
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

async function sqliteLexicalRefs({ root, query, limit }) {
  const needle = String(query ?? "").trim();
  if (!needle) return [];
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  const sqlitePath = path.join(root, GRAPH_SQLITE_REL_PATH);
  if (!(await pathExists(sqlitePath))) return null;

  let db;
  try {
    db = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    return sqliteLexicalRows(db, needle, limit);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

function sqliteLexicalRows(db, needle, limit) {
  const exactRows = db.prepare(`
    SELECT path, line, text
    FROM code_lines
    WHERE text LIKE ? ESCAPE '\\'
    ORDER BY path ASC, line ASC
    LIMIT ?
  `).all(`%${escapeLike(needle)}%`, Math.max(1, limit));
  return exactRows.map((row) => ({
    path: row.path,
    line: row.line,
    excerpt: String(row.text ?? "").trim(),
    source: "sqlite",
  }));
}

async function sqliteRelationshipRefs({ root, query, targetPath, limit }) {
  const sqlite = await loadSqlite();
  if (!sqlite) return null;
  const sqlitePath = path.join(root, GRAPH_SQLITE_REL_PATH);
  if (!(await pathExists(sqlitePath))) return null;
  const needle = String(targetPath || query || "").trim();
  if (!needle) return [];
  const fetchLimit = Math.max(64, Math.max(1, limit) * 8);

  let db;
  try {
    db = new sqlite.DatabaseSync(sqlitePath, { readOnly: true });
    const rows = db.prepare(`
      SELECT source_kind, source_ref, relation, target_kind, target_ref, evidence
      FROM relationships
      WHERE source_ref LIKE ? ESCAPE '\\'
        OR target_ref LIKE ? ESCAPE '\\'
        OR relation LIKE ? ESCAPE '\\'
        OR evidence LIKE ? ESCAPE '\\'
      ORDER BY relation ASC, source_ref ASC, target_ref ASC
      LIMIT ?
    `).all(...Array(4).fill(`%${escapeLike(needle)}%`), fetchLimit);
    return rows
      .map((row) => ({
        source_kind: row.source_kind,
        source_ref: row.source_ref,
        relation: row.relation,
        target_kind: row.target_kind,
        target_ref: row.target_ref,
        evidence: row.evidence ?? null,
        source: "sqlite",
      }))
      .sort((left, right) => compareRelationshipRefs(left, right, needle))
      .slice(0, Math.max(1, limit));
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

async function lexicalRefs({ root, files, query, limit }) {
  const needle = String(query ?? "").trim();
  if (!needle) return [];
  const refs = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    const lines = (await fs.readFile(abs, "utf8").catch(() => "")).split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle.toLowerCase())) continue;
      refs.push({
        path: rel,
        line: index + 1,
        excerpt: excerptAround(lines, index, 5),
        source: "lexical",
      });
      if (refs.length >= limit) return refs;
    }
  }
  return refs;
}

function graphProximityRefs({ graph, query = "", seedRefs = [], seedRelationships = [], limit = 16 } = {}) {
  const out = [];
  const seedPaths = new Set(seedRefs.map((ref) => ref.path).filter(Boolean));
  const relevantRelationships = uniqueRelationships([
    ...seedRelationships,
    ...(graph.relationships ?? []).filter((edge) =>
      relationshipMatches(edge, String(query ?? "").toLowerCase()) ||
      relationshipTouchesAnyPath(edge, seedPaths, graph),
    ),
  ]);

  for (const edge of relevantRelationships) {
    for (const ref of codeRefsFromRelationship({ edge, graph, source: "graph" })) {
      out.push(ref);
      if (out.length >= Math.max(1, limit)) return mergeRefs(out, limit);
    }
  }
  return mergeRefs(out, limit);
}

function queryGraphPaths(graph, query = "") {
  const haystack = String(query ?? "").replaceAll("\\", "/").toLowerCase();
  const paths = new Set();
  if (!haystack) return paths;
  for (const file of graph.files ?? []) {
    const normalized = String(file.path ?? "").replaceAll("\\", "/");
    if (normalized && haystack.includes(normalized.toLowerCase())) paths.add(normalized);
  }
  return paths;
}

function ruleLinkedRefs({ graph, query = "", seedRefs = [], seedRelationships = [], limit = 16 } = {}) {
  const seedPaths = new Set(seedRefs.map((ref) => ref.path).filter(Boolean));
  const ruleRelationships = uniqueRelationships([
    ...seedRelationships,
    ...(graph.relationships ?? []),
  ])
    .filter((edge) => RULE_LINK_RELATIONS.has(edge.relation))
    .filter((edge) =>
      relationshipMatches(edge, String(query ?? "").toLowerCase()) ||
      relationshipTouchesAnyPath(edge, seedPaths, graph),
    );
  const out = [];
  for (const edge of ruleRelationships) {
    for (const ref of codeRefsFromRelationship({ edge, graph, source: "rules" })) {
      out.push(ref);
      if (out.length >= Math.max(1, limit)) return mergeRefs(out, limit);
    }
  }
  return mergeRefs(out, limit);
}

function fuseHybridRefs({ signals = [], limit = 12 } = {}) {
  const candidates = [];
  for (const signal of signals) {
    const name = signal.name;
    const weight = HYBRID_SIGNAL_WEIGHTS[name] ?? 1;
    for (const [index, ref] of (signal.refs ?? []).entries()) {
      if (!ref?.path) continue;
      const rank = index + 1;
      const contribution = weight / (HYBRID_RRF_K + rank);
      let candidate = candidates.find((existing) => hybridRefsOverlap(existing, ref));
      if (!candidate) {
        const span = normalizedRefSpan(ref);
        candidate = {
          path: ref.path,
          line: span.line,
          end_line: span.end_line,
          span,
          excerpt: ref.excerpt ?? ref.text ?? "",
          source: "hybrid",
          score: 0,
          provenance: {
            method: "reciprocal_rank_fusion",
            k: HYBRID_RRF_K,
            signals: [],
          },
        };
        candidates.push(candidate);
      } else {
        const existingSpan = normalizedRefSpan(candidate);
        const refSpan = normalizedRefSpan(ref);
        candidate.line = Math.min(existingSpan.line, refSpan.line);
        candidate.end_line = Math.max(existingSpan.end_line, refSpan.end_line);
        candidate.span = { start_line: candidate.line, end_line: candidate.end_line };
        if (!candidate.excerpt && (ref.excerpt || ref.text)) candidate.excerpt = ref.excerpt ?? ref.text;
      }
      candidate.score += contribution;
      candidate.provenance.signals.push({
        name,
        rank,
        score: Number(contribution.toFixed(6)),
        source: ref.source ?? name,
        distance: Number.isFinite(ref.distance) ? Number(ref.distance) : undefined,
      });
    }
  }

  return candidates
    .map((candidate) => ({
      ...candidate,
      score: Number(candidate.score.toFixed(6)),
      provenance: {
        ...candidate.provenance,
        score: Number(candidate.score.toFixed(6)),
      },
    }))
    .sort((left, right) =>
      right.score - left.score ||
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.end_line - right.end_line,
    )
    .slice(0, Math.max(1, limit));
}

function decorateHybridRefs({ graph, query = "", seedRelationships = [], refs = [] } = {}) {
  const allRelationships = uniqueRelationships([...seedRelationships, ...(graph.relationships ?? [])]);
  return refs.map((ref) => {
    const relationships = allRelationships
      .filter((edge) => relationshipTouchesRef(edge, ref, graph) || relationshipMatches(edge, String(query ?? "").toLowerCase()))
      .sort((left, right) => compareRelationshipRefs(left, right, query))
      .slice(0, 12)
      .map((edge) => ({ ...edge, source: edge.source ?? "manifest" }));
    const governingRules = relationships
      .filter((edge) => RULE_LINK_RELATIONS.has(edge.relation))
      .slice(0, 8);
    return {
      ...ref,
      relationships,
      governing_rules: governingRules,
    };
  });
}

function codeRefsFromRelationship({ edge, graph, source = "graph" } = {}) {
  const refs = [];
  refs.push(...codeRefsFromRelationshipEndpoint({ edge, graph, side: "source", source }));
  refs.push(...codeRefsFromRelationshipEndpoint({ edge, graph, side: "target", source }));
  return mergeRefs(refs, refs.length || 1);
}

function codeRefsFromRelationshipEndpoint({ edge, graph, side, source }) {
  const kind = edge?.[`${side}_kind`];
  const ref = edge?.[`${side}_ref`];
  if (!kind || !ref) return [];
  const excerpt = relationshipExcerpt(edge);
  if ((kind === "file" || kind === "test") && isGraphCodePath(graph, ref)) {
    return [{
      path: ref,
      line: 1,
      excerpt,
      source,
      relationship: edge,
    }];
  }
  if (kind === "symbol") {
    return (graph.symbols ?? [])
      .filter((symbol) => symbol.name === ref && isGraphCodePath(graph, symbol.path))
      .map((symbol) => ({
        path: symbol.path,
        line: symbol.line ?? 1,
        excerpt,
        source,
        relationship: edge,
      }));
  }
  return [];
}

function relationshipExcerpt(edge) {
  const evidence = edge.evidence ? ` (${edge.evidence})` : "";
  return `${edge.relation}: ${edge.source_ref} -> ${edge.target_ref}${evidence}`;
}

function relationshipTouchesAnyPath(edge, paths, graph) {
  if (!paths?.size) return false;
  for (const rel of paths) {
    if (relationshipTouchesPath(edge, rel, graph)) return true;
  }
  return false;
}

function relationshipTouchesRef(edge, ref, graph) {
  if (!ref?.path) return false;
  if (relationshipTouchesPath(edge, ref.path, graph)) return true;
  return codeRefsFromRelationship({ edge, graph }).some((edgeRef) => hybridRefsOverlap(edgeRef, ref));
}

function relationshipTouchesPath(edge, rel, graph) {
  const normalized = String(rel ?? "").replaceAll("\\", "/");
  if (!normalized) return false;
  for (const side of ["source", "target"]) {
    const kind = edge?.[`${side}_kind`];
    const ref = String(edge?.[`${side}_ref`] ?? "").replaceAll("\\", "/");
    if (ref === normalized || ref.startsWith(`${normalized}#`)) return true;
    if (kind === "symbol" && (graph.symbols ?? []).some((symbol) => symbol.name === ref && symbol.path === normalized)) {
      return true;
    }
  }
  return false;
}

function isGraphCodePath(graph, rel) {
  const normalized = String(rel ?? "").replaceAll("\\", "/");
  if (!normalized || isMemoryFile(normalized) || normalized.startsWith(".aipi/runtime/")) return false;
  return (graph.files ?? []).some((file) => file.path === normalized);
}

function hybridRefsOverlap(left, right) {
  if (!left?.path || !right?.path || left.path !== right.path) return false;
  const leftSpan = normalizedRefSpan(left);
  const rightSpan = normalizedRefSpan(right);
  return leftSpan.line <= rightSpan.end_line && rightSpan.line <= leftSpan.end_line;
}

function normalizedRefSpan(ref) {
  const line = Number(ref?.span?.start_line ?? ref?.start_line ?? ref?.line ?? 1);
  const endLine = Number(ref?.span?.end_line ?? ref?.end_line ?? ref?.line ?? line);
  const start = Number.isFinite(line) && line > 0 ? line : 1;
  const end = Number.isFinite(endLine) && endLine >= start ? endLine : start;
  return { start_line: start, line: start, end_line: end };
}

function uniqueRelationships(edges = []) {
  const out = [];
  const seen = new Set();
  for (const edge of edges) {
    if (!edge) continue;
    const key = [
      edge.source_kind,
      edge.source_ref,
      edge.relation,
      edge.target_kind,
      edge.target_ref,
      edge.evidence,
    ].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

async function listProjectFiles(root) {
  const out = [];
  const gitignore = await readGitignoreRules(root);
  async function visit(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const relDir = path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/");
        if (shouldSkipProjectDir(relDir, entry.name, gitignore)) continue;
        await visit(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replaceAll("\\", "/");
      if (matchesGitignore(rel, false, gitignore)) continue;
      if (!CODE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.stat(abs);
      if (stat.size > 512_000) continue;
      out.push(rel);
    }
  }
  await visit(root);
  return out.sort();
}

function shouldSkipProjectDir(relDir, name, gitignore = []) {
  const normalized = normalizeRelDir(relDir);
  if (normalized === ".aipi") return false;
  if (normalized === ".aipi/memory") return false;
  if (normalized.startsWith(".aipi/") && !normalized.startsWith(".aipi/memory/project")) return true;
  if (SKIP_DIRS.has(name)) return true;
  if ([...SKIP_REL_DIRS].some((skip) => normalized === skip || normalized.startsWith(`${skip}/`))) return true;
  return matchesGitignore(normalized, true, gitignore);
}

async function readGitignoreRules(root) {
  const text = await fs.readFile(path.join(root, ".gitignore"), "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("!"))
    .map((pattern) => normalizeGitignorePattern(pattern));
}

function normalizeGitignorePattern(pattern) {
  const directoryOnly = pattern.endsWith("/");
  const anchored = pattern.startsWith("/");
  const normalized = pattern.replace(/^\/+/, "").replace(/\/+$/, "").replaceAll("\\", "/");
  return { pattern: normalized, directoryOnly, anchored };
}

function matchesGitignore(relPath, isDirectory, rules = []) {
  const rel = String(relPath ?? "").replaceAll("\\", "/").replace(/^\/+/, "");
  if (!rel) return false;
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue;
    if (gitignoreRuleMatches(rel, rule)) return true;
  }
  return false;
}

function gitignoreRuleMatches(rel, rule) {
  if (!rule.pattern) return false;
  if (rule.pattern.includes("*")) return gitignoreGlobMatches(rel, rule.pattern);
  if (rule.anchored || rule.pattern.includes("/")) {
    return rel === rule.pattern || rel.startsWith(`${rule.pattern}/`);
  }
  return rel.split("/").includes(rule.pattern);
}

function gitignoreGlobMatches(rel, pattern) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`(^|/)${escaped}($|/)`).test(rel);
}

function normalizeRelDir(relDir) {
  return String(relDir ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

async function buildRelationships({ root, files, symbols, runReferenceFiles = [], runOutcomes = [] }) {
  const filePaths = files.map((file) => file.path);
  const sourceFiles = filePaths.filter((rel) => !isTestFile(rel) && !isMemoryFile(rel));
  const testFiles = filePaths.filter(isTestFile);
  const memoryFilesInGraph = filePaths.filter(isMemoryFile);
  const runOutcomesByRef = new Map(runOutcomes.map((outcome) => [outcome.ref, outcome]));
  const edges = [];
  const seen = new Set();

  const add = (edge) => {
    const normalized = {
      source_kind: edge.source_kind,
      source_ref: edge.source_ref,
      relation: edge.relation,
      target_kind: edge.target_kind,
      target_ref: edge.target_ref,
      evidence: edge.evidence ?? null,
    };
    if (!normalized.source_ref || !normalized.target_ref || !normalized.relation) return;
    const key = [
      normalized.source_kind,
      normalized.source_ref,
      normalized.relation,
      normalized.target_kind,
      normalized.target_ref,
    ].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(normalized);
  };

  for (const symbol of symbols) {
    add({
      source_kind: "file",
      source_ref: symbol.path,
      relation: "defines",
      target_kind: "symbol",
      target_ref: symbol.name,
      evidence: symbol.line ? `line ${symbol.line}` : null,
    });
  }

  for (const testRel of testFiles) {
    const content = await readProjectText(root, testRel);
    const normalizedContent = content.toLowerCase();
    for (const sourceRel of sourceFiles) {
      const evidence = testCoverageEvidence({ testRel, sourceRel, normalizedContent });
      if (!evidence) continue;
      add({
        source_kind: "test",
        source_ref: testRel,
        relation: "test_covers",
        target_kind: "file",
        target_ref: sourceRel,
        evidence,
      });
    }
  }

  await addCallRelationships({ root, sourceFiles, symbols, add });

  for (const memoryRel of memoryFilesInGraph) {
    const content = await readProjectText(root, memoryRel);
    const normalizedContent = content.toLowerCase();
    const sourceKind = memorySourceKind(memoryRel);
    for (const sourceRel of sourceFiles) {
      if (!mentionsPath(normalizedContent, sourceRel)) continue;
      add({
        source_kind: sourceKind,
        source_ref: memoryRel,
        relation: "mentions_file",
        target_kind: "file",
        target_ref: sourceRel,
        evidence: "memory text references path or basename",
      });
    }
    for (const symbol of symbols.slice(0, 1000)) {
      if (!mentionsWord(normalizedContent, symbol.name)) continue;
      add({
        source_kind: sourceKind,
        source_ref: memoryRel,
        relation: "mentions_symbol",
        target_kind: "symbol",
        target_ref: symbol.name,
        evidence: `defined in ${symbol.path}`,
      });
    }
  }

  for (const runRel of runReferenceFiles) {
    const content = await readProjectText(root, runRel);
    const normalizedContent = content.toLowerCase();
    const outcome = runOutcomesByRef.get(runRel) ?? extractRunOutcome({ rel: runRel, content });
    for (const sourceRel of sourceFiles) {
      if (!mentionsPath(normalizedContent, sourceRel)) continue;
      add({
        source_kind: "run_artifact",
        source_ref: runRel,
        relation: "mentions_file",
        target_kind: "file",
        target_ref: sourceRel,
        evidence: "run artifact references path or basename",
      });
      if (outcome?.verdict) {
        add({
          source_kind: "run_artifact",
          source_ref: runRel,
          relation: "run_outcome_impacts_code",
          target_kind: "file",
          target_ref: sourceRel,
          evidence: `${outcome.verdict} outcome references path or basename`,
        });
      }
    }
  }

  await addDomainRelationships({
    root,
    files: filePaths,
    sourceFiles,
    memoryFilesInGraph,
    runReferenceFiles,
    add,
  });

  return capGraphRelationships(edges);
}

async function addCallRelationships({ root, sourceFiles, symbols, add }) {
  const symbolsByName = new Map();
  for (const symbol of symbols) {
    const key = String(symbol.name ?? "").toLowerCase();
    if (!key || key.length < 3) continue;
    const existing = symbolsByName.get(key) ?? [];
    existing.push(symbol);
    symbolsByName.set(key, existing);
  }
  if (!symbolsByName.size) return;

  for (const sourceRel of sourceFiles.filter((candidate) => !candidate.startsWith(".aipi/"))) {
    const content = await readProjectText(root, sourceRel);
    const identifiers = new Set(content.match(/\b[A-Za-z_$][\w$]{2,}\b/g) ?? []);
    let addedForFile = 0;
    for (const identifier of [...identifiers].sort((left, right) => left.localeCompare(right))) {
      const definitions = symbolsByName.get(identifier.toLowerCase()) ?? [];
      for (const symbol of definitions) {
        if (symbol.path === sourceRel) continue;
        add({
          source_kind: "file",
          source_ref: sourceRel,
          relation: "calls",
          target_kind: "symbol",
          target_ref: symbol.name,
          evidence: `references symbol defined in ${symbol.path}`,
        });
        addedForFile += 1;
        if (addedForFile >= MAX_CALL_RELATIONSHIPS_PER_FILE) break;
      }
      if (addedForFile >= MAX_CALL_RELATIONSHIPS_PER_FILE) break;
    }
  }
}

function capGraphRelationships(edges) {
  if (edges.length <= MAX_GRAPH_RELATIONSHIPS) return edges;
  const byRelation = new Map();
  for (const edge of edges) {
    const relation = String(edge.relation ?? "");
    const group = byRelation.get(relation) ?? [];
    group.push(edge);
    byRelation.set(relation, group);
  }
  const relationOrder = [...byRelation.keys()].sort((left, right) =>
    (RELATIONSHIP_PRIORITY.get(left) ?? 100) - (RELATIONSHIP_PRIORITY.get(right) ?? 100) ||
    left.localeCompare(right)
  );
  for (const group of byRelation.values()) group.sort(compareGraphRelationshipPriority);

  const selected = [];
  const relationOffsets = new Map(relationOrder.map((relation) => [relation, 0]));
  while (selected.length < MAX_GRAPH_RELATIONSHIPS) {
    let addedThisPass = false;
    for (const relation of relationOrder) {
      const group = byRelation.get(relation);
      const offset = relationOffsets.get(relation) ?? 0;
      if (!group || offset >= group.length) continue;
      const edge = group[offset];
      relationOffsets.set(relation, offset + 1);
      selected.push(edge);
      addedThisPass = true;
      if (selected.length >= MAX_GRAPH_RELATIONSHIPS) break;
    }
    if (!addedThisPass) break;
  }
  return selected.sort(compareGraphRelationshipPriority);
}

function compareGraphRelationshipPriority(left, right) {
  return relationshipRank(left) - relationshipRank(right) ||
    String(left.relation ?? "").localeCompare(String(right.relation ?? "")) ||
    String(left.source_ref ?? "").localeCompare(String(right.source_ref ?? "")) ||
    String(left.target_ref ?? "").localeCompare(String(right.target_ref ?? ""));
}

async function addDomainRelationships({ root, files, sourceFiles, memoryFilesInGraph, runReferenceFiles, add }) {
  const sourceDocs = [];
  const fileSet = new Set(files);
  for (const rel of sourceFiles.filter((candidate) => !candidate.startsWith(".aipi/"))) {
    const content = await readProjectText(root, rel);
    sourceDocs.push({
      rel,
      tokens: domainTokenSet(`${rel}\n${content.slice(0, 80_000)}`),
    });
  }

  const businessRules = [];
  const decisions = [];
  const bddContracts = [];
  const deploymentDocs = [];
  for (const rel of memoryFilesInGraph) {
    const content = await readProjectText(root, rel);
    if (rel.endsWith("/business-rules.md")) {
      businessRules.push(...extractBusinessRules(content, rel));
    }
    if (rel.endsWith("/decisions.md")) {
      decisions.push(...extractDecisions(content, rel));
    }
    if (rel.endsWith("/deployment.md")) {
      deploymentDocs.push({
        kind: "deployment_surface",
        ref: rel,
        title: "deployment",
        text: content,
        tokens: domainTokenSet(`${rel}\n${content}`),
      });
    }
  }

  for (const rel of runReferenceFiles) {
    const content = await readProjectText(root, rel);
    if (rel.endsWith("/BDD-CONTRACT.md") || looksLikeBddContract(content)) {
      bddContracts.push({
        kind: "bdd_contract",
        ref: rel,
        title: firstMarkdownHeading(content) ?? path.basename(rel),
        text: content,
        tokens: domainTokenSet(`${rel}\n${content}`),
      });
    }
  }

  addDomainToSourceEdges({
    add,
    docs: businessRules,
    sourceDocs,
    relation: "business_rule_impacts_code",
    sourceKind: "business_rule",
  });
  addDomainToSourceEdges({
    add,
    docs: bddContracts,
    sourceDocs,
    relation: "bdd_contract_impacts_code",
    sourceKind: "bdd_contract",
  });
  addDomainToSourceEdges({
    add,
    docs: deploymentDocs,
    sourceDocs,
    relation: "deployment_impacts_code",
    sourceKind: "deployment_surface",
  });
  addStructuredMemoryLinkEdges({ add, businessRules, decisions, fileSet });
  addBusinessRuleConflictEdges({ add, businessRules });
  await addRunRuleEdges({ root, add, runReferenceFiles, businessRules });
}

function addDomainToSourceEdges({ add, docs, sourceDocs, relation, sourceKind }) {
  for (const doc of docs) {
    for (const source of sourceDocs) {
      const match = domainMatchEvidence(doc, source);
      if (!match) continue;
      add({
        source_kind: sourceKind,
        source_ref: doc.ref,
        relation,
        target_kind: "file",
        target_ref: source.rel,
        evidence: match.evidence,
      });
    }
  }
}

function domainMatchEvidence(doc, source) {
  const normalizedText = String(doc.text ?? "").toLowerCase();
  const normalizedSourcePath = source.rel.toLowerCase();
  const sourceBasename = path.basename(source.rel).replace(/\.[^.]+$/, "").toLowerCase();
  if (normalizedText.includes(normalizedSourcePath)) {
    return { evidence: `explicit source path: ${source.rel}` };
  }
  const overlap = tokenOverlap(doc.tokens, source.tokens).slice(0, 5);
  if (overlap.length >= 2) {
    return { evidence: `shared canonical domain terms: ${overlap.join(", ")}` };
  }
  if (doc.tokens.has(sourceBasename)) {
    return { evidence: "source basename referenced" };
  }
  return null;
}

function addBusinessRuleConflictEdges({ add, businessRules }) {
  const byId = new Map(businessRules.map((rule) => [rule.id.toLowerCase(), rule]));
  for (const rule of businessRules) {
    for (const conflictId of extractConflictRuleIds(rule.text)) {
      const target = byId.get(conflictId.toLowerCase());
      if (!target || target.ref === rule.ref) continue;
      add({
        source_kind: "business_rule",
        source_ref: rule.ref,
        relation: "business_rule_conflicts",
        target_kind: "business_rule",
        target_ref: target.ref,
        evidence: `explicit conflict reference ${conflictId}`,
      });
    }
  }
  addImplicitBusinessRuleConflictEdges({ add, businessRules });
}

function addStructuredMemoryLinkEdges({ add, businessRules, decisions, fileSet }) {
  const rulesById = new Map(businessRules.map((rule) => [rule.id.toLowerCase(), rule]));
  const decisionsById = new Map(decisions.map((decision) => [decision.id.toLowerCase(), decision]));

  for (const rule of businessRules) {
    for (const targetPath of rule.links.implements ?? []) {
      if (!fileSet.has(targetPath)) continue;
      const targetKind = isTestFile(targetPath) ? "test" : "file";
      add({
        source_kind: "business_rule",
        source_ref: rule.ref,
        relation: "business_rule_implements_code",
        target_kind: targetKind,
        target_ref: targetPath,
        evidence: `structured implements link ${targetPath}`,
      });
      add({
        source_kind: "business_rule",
        source_ref: rule.ref,
        relation: "business_rule_impacts_code",
        target_kind: targetKind,
        target_ref: targetPath,
        evidence: `structured implements link ${targetPath}`,
      });
    }
    for (const relatedId of rule.links.relates ?? []) {
      const related = rulesById.get(relatedId.toLowerCase());
      if (!related || related.ref === rule.ref) continue;
      add({
        source_kind: "business_rule",
        source_ref: rule.ref,
        relation: "business_rule_relates_rule",
        target_kind: "business_rule",
        target_ref: related.ref,
        evidence: `structured relates link ${related.id}`,
      });
    }
    for (const decisionId of rule.links["decided-by"] ?? []) {
      const decision = decisionsById.get(decisionId.toLowerCase());
      if (!decision) continue;
      add({
        source_kind: "business_rule",
        source_ref: rule.ref,
        relation: "business_rule_decided_by",
        target_kind: "decision",
        target_ref: decision.ref,
        evidence: `structured decided-by link ${decision.id}`,
      });
    }
  }

  for (const decision of decisions) {
    for (const ruleId of decision.links.rules ?? []) {
      const rule = rulesById.get(ruleId.toLowerCase());
      if (!rule) continue;
      add({
        source_kind: "decision",
        source_ref: decision.ref,
        relation: "decision_references_rule",
        target_kind: "business_rule",
        target_ref: rule.ref,
        evidence: `structured rules link ${rule.id}`,
      });
    }
    for (const codePath of decision.links.code ?? []) {
      if (!fileSet.has(codePath)) continue;
      add({
        source_kind: "decision",
        source_ref: decision.ref,
        relation: "decision_references_code",
        target_kind: isTestFile(codePath) ? "test" : "file",
        target_ref: codePath,
        evidence: `structured code link ${codePath}`,
      });
    }
    for (const testPath of decision.links.tests ?? []) {
      if (!fileSet.has(testPath)) continue;
      add({
        source_kind: "decision",
        source_ref: decision.ref,
        relation: "decision_references_test",
        target_kind: "test",
        target_ref: testPath,
        evidence: `structured tests link ${testPath}`,
      });
    }
  }
}

function addImplicitBusinessRuleConflictEdges({ add, businessRules }) {
  for (let leftIndex = 0; leftIndex < businessRules.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < businessRules.length; rightIndex += 1) {
      const left = businessRules[leftIndex];
      const right = businessRules[rightIndex];
      const conflict = implicitBusinessRuleConflict(left, right);
      if (!conflict) continue;
      add({
        source_kind: "business_rule",
        source_ref: right.ref,
        relation: "business_rule_conflicts",
        target_kind: "business_rule",
        target_ref: left.ref,
        evidence: `${implicitBusinessRuleConflictEvidence(conflict.reason)} over: ${conflict.overlap.join(", ")}`,
      });
    }
  }
}

function implicitBusinessRuleConflictEvidence(reason) {
  if (reason === "preserve-vs-replace") return "implicit preserve-vs-replace conflict";
  if (reason === "allow-vs-deny") return "implicit allow-vs-deny conflict";
  if (reason === "required-vs-optional") return "implicit required-vs-optional conflict";
  if (reason === "automatic-vs-manual") return "implicit automatic-vs-manual conflict";
  if (reason === "sequence-mismatch") return "implicit sequence mismatch conflict";
  if (reason === "numeric-mismatch") return "implicit numeric mismatch conflict";
  if (reason === "monetary-mismatch") return "implicit monetary mismatch conflict";
  if (reason === "threshold-direction-mismatch") return "implicit threshold direction conflict";
  if (reason === "date-mismatch") return "implicit date mismatch conflict";
  if (reason === "time-mismatch") return "implicit time mismatch conflict";
  if (reason === "enum-value-mismatch") return "implicit enum value mismatch conflict";
  if (reason === "boolean-state-mismatch") return "implicit boolean state mismatch conflict";
  if (reason === "cardinality-mismatch") return "implicit cardinality mismatch conflict";
  return `implicit ${reason} conflict`;
}

function implicitBusinessRuleConflict(left, right) {
  const overlap = tokenOverlap(left.tokens, right.tokens)
    .filter((token) => !["accepted", "current", "new", "same"].includes(token))
    .slice(0, 5);
  if (overlap.length < 2) return null;
  const leftPolarity = businessRulePolarity(left);
  const rightPolarity = businessRulePolarity(right);
  if ((leftPolarity.preserve && rightPolarity.replace) || (leftPolarity.replace && rightPolarity.preserve)) {
    return { reason: "preserve-vs-replace", overlap };
  }
  if ((leftPolarity.allow && rightPolarity.deny) || (leftPolarity.deny && rightPolarity.allow)) {
    return { reason: "allow-vs-deny", overlap };
  }
  if ((leftPolarity.required && rightPolarity.optional) || (leftPolarity.optional && rightPolarity.required)) {
    return { reason: "required-vs-optional", overlap };
  }
  if ((leftPolarity.automatic && rightPolarity.manual) || (leftPolarity.manual && rightPolarity.automatic)) {
    return { reason: "automatic-vs-manual", overlap };
  }
  if ((leftPolarity.before && rightPolarity.after) || (leftPolarity.after && rightPolarity.before)) {
    return { reason: "sequence-mismatch", overlap };
  }
  const dateConflict = businessRuleDateConflict(left, right);
  if (dateConflict) {
    return {
      reason: "date-mismatch",
      overlap: [...new Set([...overlap, dateConflict.unit])].slice(0, 5),
    };
  }
  const timeConflict = businessRuleTimeConflict(left, right);
  if (timeConflict) {
    return {
      reason: "time-mismatch",
      overlap: [...new Set([...overlap, timeConflict.unit])].slice(0, 5),
    };
  }
  const enumConflict = businessRuleEnumConflict(left, right);
  if (enumConflict) {
    return {
      reason: "enum-value-mismatch",
      overlap: [...new Set([...overlap, enumConflict.unit])].slice(0, 5),
    };
  }
  const booleanStateConflict = businessRuleBooleanStateConflict(left, right);
  if (booleanStateConflict) {
    return {
      reason: "boolean-state-mismatch",
      overlap: [...new Set([...overlap, booleanStateConflict.unit])].slice(0, 5),
    };
  }
  const cardinalityConflict = businessRuleCardinalityConflict(left, right);
  if (cardinalityConflict) {
    return {
      reason: "cardinality-mismatch",
      overlap: [...new Set([...overlap, cardinalityConflict.unit])].slice(0, 5),
    };
  }
  const numericConflict = businessRuleNumericConflict(left, right);
  if (numericConflict) {
    return {
      reason: numericConflict.reason ?? "numeric-mismatch",
      overlap: [...new Set([...overlap, numericConflict.unit])].slice(0, 5),
    };
  }
  return null;
}

function businessRulePolarity(rule) {
  const tokens = new Set([...rule.tokens, ...domainTokenSet(rule.text ?? "")]);
  const rawTokens = businessRuleRawTokens(rule.text);
  return {
    preserve: hasAnyToken(tokens, PRESERVE_RULE_TERMS),
    replace: hasAnyToken(tokens, REPLACE_RULE_TERMS),
    allow: hasAnyToken(tokens, ALLOW_RULE_TERMS),
    deny: hasAnyToken(tokens, DENY_RULE_TERMS),
    required: hasAnyToken(rawTokens, REQUIRED_RULE_TERMS),
    optional: hasAnyToken(rawTokens, OPTIONAL_RULE_TERMS),
    automatic: hasAnyToken(rawTokens, AUTOMATIC_RULE_TERMS),
    manual: hasAnyToken(rawTokens, MANUAL_RULE_TERMS),
    before: hasAnyToken(rawTokens, BEFORE_RULE_TERMS),
    after: hasAnyToken(rawTokens, AFTER_RULE_TERMS),
  };
}

function hasAnyToken(tokens, candidates) {
  for (const candidate of candidates) {
    if (tokens.has(candidate)) return true;
  }
  return false;
}

function businessRuleRawTokens(text) {
  const raw = String(text ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9_]+/g);
  return new Set(raw ?? []);
}

function businessRuleDateConflict(left, right) {
  const leftFacts = extractRuleDateFacts(left.text);
  const rightFacts = extractRuleDateFacts(right.text);
  for (const leftFact of leftFacts) {
    for (const rightFact of rightFacts) {
      if (leftFact.unit !== rightFact.unit) continue;
      if (leftFact.value === rightFact.value) continue;
      return {
        unit: leftFact.unit,
        left: leftFact.value,
        right: rightFact.value,
      };
    }
  }
  return null;
}

function businessRuleTimeConflict(left, right) {
  const leftFacts = extractRuleTimeFacts(left.text);
  const rightFacts = extractRuleTimeFacts(right.text);
  for (const leftFact of leftFacts) {
    for (const rightFact of rightFacts) {
      if (leftFact.unit !== rightFact.unit) continue;
      if (leftFact.value === rightFact.value) continue;
      return {
        unit: leftFact.unit,
        left: leftFact.value,
        right: rightFact.value,
      };
    }
  }
  return null;
}

function businessRuleEnumConflict(left, right) {
  const leftFacts = extractRuleEnumFacts(left.text);
  const rightFacts = extractRuleEnumFacts(right.text);
  for (const leftFact of leftFacts) {
    for (const rightFact of rightFacts) {
      if (leftFact.unit !== rightFact.unit) continue;
      if (leftFact.value === rightFact.value) continue;
      return {
        unit: leftFact.unit,
        left: leftFact.value,
        right: rightFact.value,
      };
    }
  }
  return null;
}

function businessRuleBooleanStateConflict(left, right) {
  const leftFacts = extractRuleBooleanStateFacts(left.text);
  const rightFacts = extractRuleBooleanStateFacts(right.text);
  for (const leftFact of leftFacts) {
    for (const rightFact of rightFacts) {
      if (leftFact.unit !== rightFact.unit) continue;
      if (leftFact.value === rightFact.value) continue;
      return {
        unit: leftFact.unit,
        left: leftFact.value,
        right: rightFact.value,
      };
    }
  }
  return null;
}

function businessRuleCardinalityConflict(left, right) {
  const leftFacts = extractRuleCardinalityFacts(left.text);
  const rightFacts = extractRuleCardinalityFacts(right.text);
  for (const leftFact of leftFacts) {
    for (const rightFact of rightFacts) {
      if (leftFact.unit !== rightFact.unit) continue;
      if (leftFact.value === rightFact.value) continue;
      return {
        unit: leftFact.unit,
        left: leftFact.value,
        right: rightFact.value,
      };
    }
  }
  return null;
}

function businessRuleNumericConflict(left, right) {
  const leftFacts = extractRuleNumericFacts(left.text);
  const rightFacts = extractRuleNumericFacts(right.text);
  for (const leftFact of leftFacts) {
    for (const rightFact of rightFacts) {
      if (leftFact.unit !== rightFact.unit) continue;
      if (thresholdDirectionConflict(leftFact, rightFact)) {
        return {
          unit: leftFact.unit,
          left: leftFact.value,
          right: rightFact.value,
          reason: "threshold-direction-mismatch",
        };
      }
      if (thresholdFactsCompatible(leftFact, rightFact)) continue;
      if (leftFact.value === rightFact.value) continue;
      return {
        unit: leftFact.unit,
        left: leftFact.value,
        right: rightFact.value,
        reason: leftFact.reason ?? rightFact.reason ?? "numeric-mismatch",
      };
    }
  }
  return null;
}

function extractRuleNumericFacts(text) {
  const normalized = String(text ?? "").replace(/\bBR-[A-Za-z0-9_-]+\b/g, " ");
  const facts = [];
  for (const match of normalized.matchAll(/\b(at\s+least|minimum|min|no\s+less\s+than|at\s+most|maximum|max|no\s+more\s+than)\s+(\d+(?:[.,]\d+)?)\s*(days?|dias?|hours?|horas?|attempts?|tentativas?|percent|percentage|%|por\s+cento)\b/gi)) {
    const comparator = normalizeThresholdComparator(match[1]);
    const value = parseLocaleNumber(match[2]);
    const unit = normalizeNumericUnit(match[3]);
    if (!comparator || !Number.isFinite(value) || !unit) continue;
    facts.push({ value, unit, comparator, reason: "threshold-direction-mismatch" });
  }
  for (const match of normalized.matchAll(/\b(\d+(?:[.,]\d+)?)\s+or\s+(more|greater|higher|less|fewer)\s*(days?|dias?|hours?|horas?|attempts?|tentativas?|percent|percentage|%|por\s+cento)\b/gi)) {
    const comparator = normalizeThresholdComparator(match[2]);
    const value = parseLocaleNumber(match[1]);
    const unit = normalizeNumericUnit(match[3]);
    if (!comparator || !Number.isFinite(value) || !unit) continue;
    facts.push({ value, unit, comparator, reason: "threshold-direction-mismatch" });
  }
  for (const match of normalized.matchAll(/(USD|US\$|\$|BRL|R\$)\s*(\d+(?:[.,]\d+)?)/gi)) {
    const value = parseLocaleNumber(match[2]);
    const unit = normalizeCurrencyUnit(match[1]);
    if (!Number.isFinite(value) || !unit) continue;
    facts.push({ value, unit, reason: "monetary-mismatch" });
  }
  for (const match of normalized.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(USD|BRL|dollars?|reais)\b/gi)) {
    const value = parseLocaleNumber(match[1]);
    const unit = normalizeCurrencyUnit(match[2]);
    if (!Number.isFinite(value) || !unit) continue;
    facts.push({ value, unit, reason: "monetary-mismatch" });
  }
  for (const match of normalized.matchAll(/\b(\d+(?:\.\d+)?)\s*(days?|dias?|hours?|horas?|attempts?|tentativas?|percent|percentage|%|por\s+cento)\b/gi)) {
    const value = Number(match[1]);
    const unit = normalizeNumericUnit(match[2]);
    if (!Number.isFinite(value) || !unit) continue;
    facts.push({ value, unit });
  }
  return facts;
}

function extractRuleCardinalityFacts(text) {
  const normalized = String(text ?? "")
    .replace(/\bBR-[A-Za-z0-9_-]+\b/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const facts = [];
  for (const match of normalized.matchAll(/\b(?:only\s+one|exactly\s+one|one)\s+([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,3})\b/g)) {
    const subject = normalizeCardinalitySubject(match[1]);
    if (!subject) continue;
    facts.push({ value: "single", unit: `cardinality:${subject}` });
  }
  for (const match of normalized.matchAll(/\b(?:multiple|many|several|more\s+than\s+one)\s+([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,3})\b/g)) {
    const subject = normalizeCardinalitySubject(match[1]);
    if (!subject) continue;
    facts.push({ value: "multiple", unit: `cardinality:${subject}` });
  }
  return facts;
}

function extractRuleBooleanStateFacts(text) {
  const normalized = String(text ?? "")
    .replace(/\bBR-[A-Za-z0-9_-]+\b/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const facts = [];
  for (const match of normalized.matchAll(/\b([a-z][a-z0-9_-]*(?:\s+[a-z][a-z0-9_-]*){0,3})\s+(?:is|must\s+be|should\s+be|shall\s+be|stays?|remains?)\s+(enabled|disabled|active|inactive|on|off|true|false)\b/g)) {
    const subject = normalizeBooleanSubject(match[1]);
    const value = normalizeBooleanState(match[2]);
    if (!subject || !value) continue;
    facts.push({ value, unit: `boolean:${subject}` });
  }
  return facts;
}

function extractRuleEnumFacts(text) {
  const normalized = String(text ?? "")
    .replace(/\bBR-[A-Za-z0-9_-]+\b/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const facts = [];
  for (const match of normalized.matchAll(/\b([a-z][a-z0-9_-]*)\s+(status|state|stage|tier|plan|role|visibility|access|classification|mode|type|scope|provider|channel|source|owner|region|locale|language|environment|method|currency)\s+(?:is|must\s+be|must\s+equal|should\s+be|equals?|=|becomes?)\s+[`'"]?([a-z][a-z0-9_-]{1,40})[`'"]?\b/g)) {
    const object = normalizeEnumToken(match[1]);
    const field = normalizeEnumToken(match[2]);
    const value = normalizeEnumToken(match[3]);
    if (!object || !field || !value) continue;
    facts.push({ value, unit: `enum:${object}:${field}` });
  }
  return facts;
}

function extractRuleTimeFacts(text) {
  const normalized = String(text ?? "")
    .replace(/\bBR-[A-Za-z0-9_-]+\b/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const facts = [];
  for (const match of normalized.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    const value = normalizeTimeParts(match[1], match[2]);
    if (!value) continue;
    facts.push({ value, unit: timeRoleForContext(normalized, match.index ?? 0) });
  }
  return facts;
}

function extractRuleDateFacts(text) {
  const normalized = String(text ?? "")
    .replace(/\bBR-[A-Za-z0-9_-]+\b/g, " ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const facts = [];
  for (const match of normalized.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const value = normalizeDateParts(match[1], match[2], match[3]);
    if (!value) continue;
    facts.push({ value, unit: dateRoleForContext(normalized, match.index ?? 0) });
  }
  for (const match of normalized.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const value = normalizeDateParts(match[3], match[2], match[1]);
    if (!value) continue;
    facts.push({ value, unit: dateRoleForContext(normalized, match.index ?? 0) });
  }
  return facts;
}

function thresholdDirectionConflict(leftFact, rightFact) {
  if (!leftFact.comparator || !rightFact.comparator) return false;
  if (leftFact.comparator === rightFact.comparator) return false;
  if (leftFact.value === rightFact.value) return true;
  const minValue = leftFact.comparator === "min" ? leftFact.value : rightFact.value;
  const maxValue = leftFact.comparator === "max" ? leftFact.value : rightFact.value;
  return minValue > maxValue;
}

function thresholdFactsCompatible(leftFact, rightFact) {
  if (!leftFact.comparator || !rightFact.comparator) return false;
  if (leftFact.comparator === rightFact.comparator) return true;
  if (leftFact.value === rightFact.value) return false;
  const minValue = leftFact.comparator === "min" ? leftFact.value : rightFact.value;
  const maxValue = leftFact.comparator === "max" ? leftFact.value : rightFact.value;
  return minValue <= maxValue;
}

function parseLocaleNumber(value) {
  const normalized = String(value ?? "").replace(",", ".");
  return Number(normalized);
}

function normalizeThresholdComparator(comparator) {
  const normalized = String(comparator ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (["at least", "minimum", "min", "no less than", "more", "greater", "higher"].includes(normalized)) {
    return "min";
  }
  if (["at most", "maximum", "max", "no more than", "less", "fewer"].includes(normalized)) {
    return "max";
  }
  return null;
}

function normalizeCurrencyUnit(unit) {
  const normalized = String(unit ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (["usd", "us$", "$", "dollar", "dollars"].includes(normalized)) return "currency:usd";
  if (["brl", "r$", "real", "reais"].includes(normalized)) return "currency:brl";
  return null;
}

function normalizeDateParts(year, month, day) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  const parsedDay = Number(day);
  if (
    !Number.isInteger(parsedYear) ||
    !Number.isInteger(parsedMonth) ||
    !Number.isInteger(parsedDay) ||
    parsedYear < 1900 ||
    parsedYear > 2200 ||
    parsedMonth < 1 ||
    parsedMonth > 12 ||
    parsedDay < 1 ||
    parsedDay > 31
  ) {
    return null;
  }
  const date = new Date(Date.UTC(parsedYear, parsedMonth - 1, parsedDay));
  if (
    date.getUTCFullYear() !== parsedYear ||
    date.getUTCMonth() !== parsedMonth - 1 ||
    date.getUTCDate() !== parsedDay
  ) {
    return null;
  }
  return `${String(parsedYear).padStart(4, "0")}-${String(parsedMonth).padStart(2, "0")}-${String(parsedDay).padStart(2, "0")}`;
}

function normalizeTimeParts(hour, minute) {
  const parsedHour = Number(hour);
  const parsedMinute = Number(minute);
  if (
    !Number.isInteger(parsedHour) ||
    !Number.isInteger(parsedMinute) ||
    parsedHour < 0 ||
    parsedHour > 23 ||
    parsedMinute < 0 ||
    parsedMinute > 59
  ) {
    return null;
  }
  return `${String(parsedHour).padStart(2, "0")}:${String(parsedMinute).padStart(2, "0")}`;
}

function normalizeEnumToken(token) {
  const normalized = String(token ?? "").toLowerCase().replace(/[^a-z0-9_-]+/g, "").trim();
  if (!normalized || ["new", "current", "same", "accepted", "proposed"].includes(normalized)) return null;
  return normalized;
}

function normalizeBooleanSubject(subject) {
  const rawTokens = String(subject ?? "")
    .toLowerCase()
    .match(/[a-z0-9_-]+/g) ?? [];
  const tokens = rawTokens.filter((token) => !["the", "a", "an", "is", "must", "should", "shall"].includes(token));
  if (!tokens.length || tokens.every((token) => ["feature", "flag", "setting", "status", "state"].includes(token))) return null;
  return tokens.slice(-4).join("-");
}

function normalizeBooleanState(state) {
  const normalized = String(state ?? "").toLowerCase().trim();
  if (["enabled", "active", "on", "true"].includes(normalized)) return "enabled";
  if (["disabled", "inactive", "off", "false"].includes(normalized)) return "disabled";
  return null;
}

function normalizeCardinalitySubject(subject) {
  const rawTokens = String(subject ?? "")
    .toLowerCase()
    .match(/[a-z0-9_-]+/g) ?? [];
  const tokens = rawTokens
    .filter((token) => !["the", "a", "an", "new", "current", "same", "allowed", "required", "requires"].includes(token))
    .map((token, index, all) => {
      if (index !== all.length - 1 || token.length <= 3 || !token.endsWith("s")) return token;
      return token.slice(0, -1);
    });
  if (!tokens.length || tokens.every((token) => ["item", "items", "record", "records", "thing", "things"].includes(token))) return null;
  return tokens.slice(-4).join("-");
}

function dateRoleForContext(text, index) {
  const lower = String(text ?? "").toLowerCase();
  const window = lower.slice(Math.max(0, index - 60), Math.min(lower.length, index + 40));
  if (/\b(expires?|expiration|deadline|due|validade|vence|vencimento|expira|prazo)\b/.test(window)) {
    return "date:deadline";
  }
  if (/\b(effective|starts?|begins?|inicio|inicia|vigencia|comeca)\b/.test(window)) {
    return "date:effective";
  }
  if (/\b(created|creation|criado|criacao)\b/.test(window)) {
    return "date:created";
  }
  return "date:unspecified";
}

function timeRoleForContext(text, index) {
  const lower = String(text ?? "").toLowerCase();
  const window = lower.slice(Math.max(0, index - 60), Math.min(lower.length, index + 40));
  if (/\b(cutoff|cut-off|deadline|due|limit|limite|horario|fechamento|closes?|encerra|fim)\b/.test(window)) {
    return "time:cutoff";
  }
  if (/\b(starts?|begins?|opens?|inicio|inicia|abre|abertura|comeca)\b/.test(window)) {
    return "time:start";
  }
  return "time:unspecified";
}

function normalizeNumericUnit(unit) {
  const normalized = String(unit ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (["day", "days", "dia", "dias"].includes(normalized)) return "day";
  if (["hour", "hours", "hora", "horas"].includes(normalized)) return "hour";
  if (["attempt", "attempts", "tentativa", "tentativas"].includes(normalized)) return "attempt";
  if (["percent", "percentage", "%", "por cento"].includes(normalized)) return "percent";
  return null;
}

async function addRunRuleEdges({ root, add, runReferenceFiles, businessRules }) {
  if (!businessRules.length) return;
  for (const rel of runReferenceFiles) {
    if (rel.endsWith("/BDD-CONTRACT.md")) continue;
    const content = await readProjectText(root, rel);
    const tokens = domainTokenSet(`${rel}\n${content}`);
    const normalizedContent = content.toLowerCase();
    const outcome = extractRunOutcome({ rel, content });
    for (const rule of businessRules) {
      const direct = normalizedContent.includes(rule.id.toLowerCase()) ||
        (rule.title && normalizedContent.includes(rule.title.toLowerCase()));
      const overlap = direct ? [] : tokenOverlap(tokens, rule.tokens).slice(0, 5);
      if (!direct && overlap.length < 2) continue;
      add({
        source_kind: "run_artifact",
        source_ref: rel,
        relation: runOutcomeRuleRelation(outcome?.verdict) ?? "run_references_rule",
        target_kind: "business_rule",
        target_ref: rule.ref,
        evidence: runRuleEvidence({ outcome, direct, rule, overlap }),
      });
    }
  }
}

async function summarizeRunOutcomes({ root, runReferenceFiles }) {
  const outcomes = [];
  for (const rel of runReferenceFiles) {
    const content = await readProjectText(root, rel);
    const outcome = extractRunOutcome({ rel, content });
    if (!outcome?.verdict) continue;
    outcomes.push(outcome);
  }
  return outcomes;
}

function extractRunOutcome({ rel, content }) {
  const text = String(content ?? "");
  const verdict =
    firstMatch(text, /\bVERDICT\s*:\s*(PASS|FAIL|BLOCKED|SKIPPED)\b/i) ??
    firstMatch(text, /"verdict"\s*:\s*"(PASS|FAIL|BLOCKED|SKIPPED)"/i) ??
    firstJsonLikeOutcome(text, "verdict") ??
    firstJsonLikeOutcome(text, "status");
  const normalizedVerdict = normalizeRunOutcome(verdict);
  if (!normalizedVerdict) return null;
  return {
    ref: rel,
    run_id: runIdFromRunRef(rel),
    step_id: stepIdFromRunRef(rel),
    verdict: normalizedVerdict,
    evidence: `outcome=${normalizedVerdict}`,
  };
}

function firstJsonLikeOutcome(text, key) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const value = parsed?.[key] ?? parsed?.result?.[key] ?? parsed?.step_result?.[key];
      const normalized = normalizeRunOutcome(value);
      if (normalized) return normalized;
    } catch {
      /* ignore non-json lines */
    }
  }
  try {
    const parsed = JSON.parse(text);
    return normalizeRunOutcome(parsed?.[key] ?? parsed?.result?.[key] ?? parsed?.step_result?.[key]);
  } catch {
    return null;
  }
}

function firstMatch(text, pattern) {
  return String(text ?? "").match(pattern)?.[1] ?? null;
}

function normalizeRunOutcome(value) {
  const normalized = String(value ?? "").trim().toUpperCase().replaceAll("-", "_");
  if (["PASS", "FAIL", "BLOCKED", "SKIPPED"].includes(normalized)) return normalized;
  if (normalized === "PASSED") return "PASS";
  if (normalized === "FAILED") return "FAIL";
  return null;
}

function runOutcomeRuleRelation(verdict) {
  if (verdict === "PASS") return "run_verifies_rule";
  if (verdict === "FAIL") return "run_fails_rule";
  if (verdict === "BLOCKED") return "run_blocks_rule";
  if (verdict === "SKIPPED") return "run_skips_rule";
  return null;
}

function runRuleEvidence({ outcome, direct, rule, overlap }) {
  const matchEvidence = direct ? `mentions ${rule.id}` : `shared domain terms: ${overlap.join(", ")}`;
  return outcome?.verdict ? `${outcome.verdict} outcome; ${matchEvidence}` : matchEvidence;
}

function runIdFromRunRef(rel) {
  return String(rel ?? "").match(/(?:^|\/)\.aipi\/runtime\/runs\/([^/]+)/)?.[1] ?? null;
}

function stepIdFromRunRef(rel) {
  return String(rel ?? "").match(/\/steps\/([^/]+)\//)?.[1] ?? null;
}

function extractBusinessRules(content, rel) {
  const scanContent = stripFencedCodeBlocks(content);
  const matches = [...scanContent.matchAll(/^###\s+(BR-[A-Za-z0-9_-]+)\s*-?\s*(.*?)\s*$/gim)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? scanContent.length : scanContent.length;
    const id = match[1];
    const title = match[2]?.trim() ?? id;
    const text = scanContent.slice(start, end).trim();
    return {
      id,
      title,
      ref: `${rel}#${id}`,
      text,
      links: extractStructuredLinks(text),
      tokens: domainTokenSet(`${id} ${title}\n${text}`),
    };
  });
}

function extractDecisions(content, rel) {
  const scanContent = stripFencedCodeBlocks(content);
  const matches = [...scanContent.matchAll(/^###\s+(ADR-[A-Za-z0-9_-]+)\s*-?\s*(.*?)\s*$/gim)];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = index + 1 < matches.length ? matches[index + 1].index ?? scanContent.length : scanContent.length;
    const id = match[1];
    const title = match[2]?.trim() ?? id;
    const text = scanContent.slice(start, end).trim();
    return {
      id,
      title,
      ref: `${rel}#${id}`,
      text,
      links: extractStructuredLinks(text),
      tokens: domainTokenSet(`${id} ${title}\n${text}`),
    };
  });
}

function stripFencedCodeBlocks(content) {
  const out = [];
  let inFence = false;
  for (const line of String(content ?? "").split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out.join("\n");
}

function extractStructuredLinks(text) {
  return {
    implements: extractLinkValues(text, "implements"),
    relates: extractLinkValues(text, "relates"),
    "decided-by": extractLinkValues(text, "decided-by"),
    rules: extractLinkValues(text, "rules"),
    code: extractLinkValues(text, "code"),
    tests: extractLinkValues(text, "tests"),
  };
}

function extractLinkValues(text, key) {
  const escaped = escapeRegex(key);
  const match = String(text ?? "").match(new RegExp(`${escaped}\\s*:\\s*\\[([^\\]]*)\\]`, "i"));
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim().replace(/^["'`]+|["'`]+$/g, ""))
    .filter(Boolean);
}

function extractConflictRuleIds(text) {
  const ids = new Set();
  for (const match of String(text ?? "").matchAll(/\bconflicts?(?:-with)?\s*:\s*([^\n]+)/gi)) {
    for (const id of match[1].match(/\bBR-[A-Za-z0-9_-]+\b/gi) ?? []) ids.add(id.toUpperCase());
  }
  return [...ids];
}

function looksLikeBddContract(content) {
  const text = String(content ?? "").toLowerCase();
  return text.includes("given ") && text.includes("when ") && text.includes("then ");
}

function firstMarkdownHeading(content) {
  return String(content ?? "").match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null;
}

function runArtifactLooksVerified(rel, content) {
  const outcome = extractRunOutcome({ rel, content });
  if (outcome?.verdict) return outcome.verdict === "PASS";
  const text = `${rel}\n${content}`.toLowerCase();
  return text.includes("verification") ||
    text.includes("verified") ||
    text.includes("verdict: pass") ||
    text.includes('"verdict":"pass"') ||
    text.includes('"verdict": "pass"');
}

function domainTokenSet(text) {
  const raw = String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .match(/[a-z0-9_]+/g) ?? [];
  const tokens = new Set();
  for (const token of raw.map((item) => item.replace(/^_+|_+$/g, ""))) {
    addDomainToken(tokens, token);
  }
  return tokens;
}

function addDomainToken(tokens, token) {
  if (!token || token.length <= 2 || /^\d+$/.test(token) || DOMAIN_STOP_WORDS.has(token)) return;
  tokens.add(token);
  const alias = DOMAIN_TOKEN_ALIASES.get(token);
  if (alias && !DOMAIN_STOP_WORDS.has(alias)) tokens.add(alias);
  const singular = singularDomainToken(token);
  if (singular && singular !== token && !DOMAIN_STOP_WORDS.has(singular)) {
    tokens.add(singular);
    const singularAlias = DOMAIN_TOKEN_ALIASES.get(singular);
    if (singularAlias && !DOMAIN_STOP_WORDS.has(singularAlias)) tokens.add(singularAlias);
  }
}

function singularDomainToken(token) {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("oes") && token.length > 4) return `${token.slice(0, -3)}ao`;
  if (token.endsWith("es") && token.length > 4 && !token.endsWith("ses")) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3 && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokenOverlap(left, right) {
  const out = [];
  for (const token of left) {
    if (right.has(token)) out.push(token);
  }
  return out.sort();
}

async function listRunReferenceFiles(root, maxFiles = 80) {
  const runsDir = path.join(root, ".aipi", "runtime", "runs");
  const out = [];
  async function visit(dir) {
    if (out.length >= maxFiles) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (![".md", ".json", ".jsonl", ".txt"].includes(ext)) continue;
      const stat = await fs.stat(abs);
      if (stat.size > 128_000) continue;
      out.push(path.relative(root, abs).replaceAll("\\", "/"));
    }
  }
  await visit(runsDir);
  return out.sort();
}

function extractSymbols(content, relPath) {
  const symbols = [];
  const patterns = [
    /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\b(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      symbols.push({ name: match[1], path: relPath, line: lineNumberForIndex(content, match.index ?? 0) });
    }
  }
  return symbols;
}

function graphSummary(graph) {
  return {
    path: GRAPH_REL_PATH,
    source: graph.source ?? "lexical",
    built_at: graph.built_at ?? null,
    stale: Boolean(graph.stale),
    freshness: graph.freshness ?? { status: graph.stale ? "stale" : "unknown" },
    rebuilt_from_stale: graph.rebuilt_from_stale ?? null,
    file_count: graph.files?.length ?? 0,
    memory_metadata_count: graph.files?.filter((file) => file.memory_metadata).length ?? 0,
    symbol_count: graph.symbols?.length ?? 0,
    relationship_count: graph.relationships?.length ?? 0,
    run_outcome_count: graph.run_outcomes?.length ?? 0,
    sqlite: graph.sqlite ?? { path: GRAPH_SQLITE_REL_PATH, status: "unknown" },
    vector: graph.vector ?? graph.sqlite?.vector ?? { status: "unknown", engine: "sqlite-vec" },
  };
}

async function inspectGraphFreshness(root, graph, { env = process.env } = {}) {
  const checkedAt = new Date().toISOString();
  const embeddingConfig = await resolveSemanticEmbeddingConfig({ root, env });
  if (embeddingConfig.migration_required) {
    return graphFreshnessStale({
      checkedAt,
      reason: "legacy embedding config migration required: target is bge-m3/1024",
      expectedCount: graph.files?.length ?? 0,
      actualCount: graph.files?.length ?? 0,
    });
  }
  const graphVector = graph.vector ?? graph.sqlite?.vector ?? null;
  if (graphVector?.dimensions && graphVector.dimensions !== embeddingConfig.dimensions) {
    return graphFreshnessStale({
      checkedAt,
      reason: `embedding dimension mismatch: indexed ${graphVector.dimensions}, configured ${embeddingConfig.dimensions}`,
      expectedCount: graph.files?.length ?? 0,
      actualCount: graph.files?.length ?? 0,
    });
  }
  if (graphVector?.embedding_model && graphVector.embedding_model !== embeddingConfig.model) {
    return graphFreshnessStale({
      checkedAt,
      reason: `embedding model mismatch: indexed ${graphVector.embedding_model}, configured ${embeddingConfig.model}`,
      expectedCount: graph.files?.length ?? 0,
      actualCount: graph.files?.length ?? 0,
    });
  }
  if (graphVector?.status === "available" && graphVector?.chunking?.strategy !== "symbol_or_window") {
    return graphFreshnessStale({
      checkedAt,
      reason: "semantic vector chunking strategy changed: rebuild required for symbol/window chunks",
      expectedCount: graph.files?.length ?? 0,
      actualCount: graph.files?.length ?? 0,
    });
  }
  if (!Array.isArray(graph.files)) {
    return graphFreshnessStale({
      checkedAt,
      reason: "graph missing file list",
      expectedCount: 0,
      actualCount: 0,
    });
  }
  const indexed = new Map(graph.files.map((file) => [file.path, file]));
  if ([...indexed.values()].some((file) => !file.hash)) {
    return graphFreshnessStale({
      checkedAt,
      reason: "graph missing file hash metadata",
      expectedCount: indexed.size,
      actualCount: indexed.size,
    });
  }

  const currentFiles = await listProjectFiles(root);
  const current = new Map();
  for (const rel of currentFiles) {
    const content = await fs.readFile(path.join(root, rel), "utf8").catch(() => "");
    current.set(rel, {
      path: rel,
      line_count: content.split(/\r?\n/).length,
      size: Buffer.byteLength(content, "utf8"),
      hash: contentHash(content),
    });
  }

  for (const rel of indexed.keys()) {
    if (!current.has(rel)) {
      return graphFreshnessStale({
        checkedAt,
        reason: `indexed file removed: ${rel}`,
        expectedCount: indexed.size,
        actualCount: current.size,
      });
    }
  }
  for (const [rel, actual] of current.entries()) {
    const expected = indexed.get(rel);
    if (!expected) {
      return graphFreshnessStale({
        checkedAt,
        reason: `new file not indexed: ${rel}`,
        expectedCount: indexed.size,
        actualCount: current.size,
      });
    }
    if (
      expected.hash !== actual.hash ||
      expected.size !== actual.size ||
      expected.line_count !== actual.line_count
    ) {
      return graphFreshnessStale({
        checkedAt,
        reason: `indexed file changed: ${rel}`,
        expectedCount: indexed.size,
        actualCount: current.size,
      });
    }
  }
  return graphFreshnessFresh({ checkedAt, fileCount: current.size });
}

function graphFreshnessFresh({ checkedAt, fileCount }) {
  return {
    status: "fresh",
    stale: false,
    checked_at: checkedAt,
    reason: null,
    indexed_file_count: fileCount,
    current_file_count: fileCount,
  };
}

function graphFreshnessStale({ checkedAt, reason, expectedCount, actualCount }) {
  return {
    status: "stale",
    stale: true,
    checked_at: checkedAt,
    reason,
    indexed_file_count: expectedCount,
    current_file_count: actualCount,
  };
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function embeddingInputForCodeLine(line) {
  return String(line ?? "").trim().replace(/\s+/g, " ");
}

function embeddingInputForCodeChunk(text) {
  return String(text ?? "").trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
}

function embeddingContentKey(input) {
  return `sha256:${contentHash(input)}`;
}

function shouldEmbedCodeLine(relPath, line) {
  if (!isEmbeddableVectorFile(relPath)) return false;
  const text = embeddingInputForCodeLine(line);
  if (text.length < 4) return false;
  if (!/[A-Za-z0-9_]/.test(text)) return false;
  if (/^[{}()[\];,.:+\-*/<>=!&|"'`\s]+$/.test(text)) return false;
  if (/^\/\/\s*(generated|auto-generated|@generated)\b/i.test(text)) return false;
  return true;
}

function isEmbeddableVectorFile(relPath) {
  const normalized = String(relPath ?? "").replaceAll("\\", "/");
  const base = path.posix.basename(normalized).toLowerCase();
  if (isTestFile(normalized)) return false;
  if (isGeneratedOrMigrationFile(normalized)) return false;
  if ([".css", ".html"].includes(path.posix.extname(base))) return false;
  if (base.endsWith(".d.ts")) return false;
  if (/\.min\.[cm]?js$/.test(base)) return false;
  if (/(^|\.)(lock|snap)$/.test(base)) return false;
  return VECTOR_EMBED_EXTENSIONS.has(path.posix.extname(base));
}

function buildVectorChunksForFile({ file, lines, symbols = [], relationships = [] } = {}) {
  if (!file?.path || !isEmbeddableVectorFile(file.path)) return [];
  if (hasGeneratedMarker(lines)) return [];
  if (!isHighSignalVectorFile(file.path, { symbols, relationships })) return [];
  const fileSymbols = symbols
    .filter((symbol) => symbol.path === file.path && Number.isFinite(Number(symbol.line)) && Number(symbol.line) > 0)
    .map((symbol) => ({
      ...symbol,
      line: Math.min(lines.length, Math.max(1, Number(symbol.line))),
    }))
    .sort((left, right) => left.line - right.line || left.name.localeCompare(right.name));
  const chunks = [];
  const coveredLines = new Set();

  for (const [index, symbol] of fileSymbols.entries()) {
    if (coveredLines.has(symbol.line)) continue;
    const nextSymbol = fileSymbols.slice(index + 1).find((candidate) => candidate.line > symbol.line);
    const startLine = symbol.line;
    const fallbackEndLine = Math.max(startLine, Math.min(lines.length, (nextSymbol?.line ?? (lines.length + 1)) - 1));
    const endLine = symbolSpanEndLine(lines, startLine, fallbackEndLine);
    const text = vectorChunkTextForSpan({ relPath: file.path, lines, startLine, endLine });
    if (!text) continue;
    chunks.push({
      path: file.path,
      start_line: startLine,
      end_line: endLine,
      text,
      chunk_kind: "symbol",
      symbol_name: symbol.name,
    });
    for (let line = startLine; line <= endLine; line += 1) coveredLines.add(line);
  }

  const uncoveredEmbeddableLines = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (coveredLines.has(lineNumber)) continue;
    if (shouldEmbedCodeLine(file.path, line)) uncoveredEmbeddableLines.push(lineNumber);
  }
  for (const [startLine, endLine] of contiguousLineRanges(uncoveredEmbeddableLines)) {
    chunks.push(...windowChunksForSpan({ relPath: file.path, lines, startLine, endLine }));
  }

  return chunks;
}

function isGeneratedOrMigrationFile(relPath) {
  const normalized = String(relPath ?? "").replaceAll("\\", "/").toLowerCase();
  if (/(^|\/)__generated__(\/|$)/.test(normalized)) return true;
  if (/(^|\/)migrations?(\/|$)/.test(normalized)) return true;
  return /\.generated\.[^/]+$/.test(normalized);
}

function hasGeneratedMarker(lines = []) {
  return lines.some((line) => /@generated\b/i.test(String(line ?? "")));
}

function isHighSignalVectorFile(relPath, { symbols = [], relationships = [] } = {}) {
  const normalized = normalizeGraphRefPath(relPath);
  if (!normalized) return false;
  if (symbols.some((symbol) => normalizeGraphRefPath(symbol.path) === normalized)) return true;
  return relationships.some((edge) =>
    graphRefMatchesFile(edge.source_ref, normalized) || graphRefMatchesFile(edge.target_ref, normalized),
  );
}

function graphRefMatchesFile(ref, normalizedRelPath) {
  const normalizedRef = normalizeGraphRefPath(ref);
  return normalizedRef === normalizedRelPath ||
    normalizedRef.startsWith(`${normalizedRelPath}#`) ||
    normalizedRef.startsWith(`${normalizedRelPath}:`);
}

function normalizeGraphRefPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function symbolSpanEndLine(lines, startLine, fallbackEndLine) {
  let depth = 0;
  let sawBlock = false;
  for (let index = startLine - 1; index < lines.length; index += 1) {
    const line = stripQuotedTextForBraceScan(lines[index] ?? "");
    for (const char of line) {
      if (char === "{") {
        depth += 1;
        sawBlock = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (sawBlock && depth <= 0) return index + 1;
  }
  return fallbackEndLine;
}

function stripQuotedTextForBraceScan(line) {
  return String(line ?? "")
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
    .replace(/`[^`]*`/g, "``");
}

function vectorChunkTextForSpan({ relPath, lines, startLine, endLine } = {}) {
  const spanLines = lines.slice(startLine - 1, endLine);
  if (!spanLines.some((line) => shouldEmbedCodeLine(relPath, line))) return "";
  const text = spanLines.join("\n").trim();
  if (!text) return "";
  return text.length > VECTOR_CHUNK_MAX_CHARS ? text.slice(0, VECTOR_CHUNK_MAX_CHARS) : text;
}

function contiguousLineRanges(lineNumbers = []) {
  const ranges = [];
  let start = null;
  let previous = null;
  for (const line of lineNumbers) {
    if (start == null) {
      start = line;
      previous = line;
      continue;
    }
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    ranges.push([start, previous]);
    start = line;
    previous = line;
  }
  if (start != null) ranges.push([start, previous]);
  return ranges;
}

function windowChunksForSpan({ relPath, lines, startLine, endLine } = {}) {
  const chunks = [];
  const step = Math.max(1, VECTOR_CHUNK_WINDOW_LINES - VECTOR_CHUNK_WINDOW_OVERLAP_LINES);
  for (let windowStart = startLine; windowStart <= endLine; windowStart += step) {
    const windowEnd = Math.min(endLine, windowStart + VECTOR_CHUNK_WINDOW_LINES - 1);
    const text = vectorChunkTextForSpan({ relPath, lines, startLine: windowStart, endLine: windowEnd });
    if (text) {
      chunks.push({
        path: relPath,
        start_line: windowStart,
        end_line: windowEnd,
        text,
        chunk_kind: "window",
        symbol_name: null,
      });
    }
    if (windowEnd >= endLine) break;
  }
  return chunks;
}

function embeddingCacheEntryFromVector(vector) {
  return {
    literal: vectorLiteralFromArray(vector),
    blob: vectorFloat32Blob(vector),
  };
}

function embeddingCacheEntryFromStored(value, dimensions) {
  if (value == null) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const vector = vectorFromFloat32Blob(value, dimensions);
    return vector ? embeddingCacheEntryFromVector(vector) : null;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? embeddingCacheEntryFromVector(parsed) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function vectorLiteralFromArray(vector) {
  return JSON.stringify(Array.from(vector, (value) => Number(Number(value).toFixed(6))));
}

function vectorFloat32Blob(vector) {
  const floats = new Float32Array(vector.length);
  for (const [index, value] of vector.entries()) floats[index] = Number(value);
  return Buffer.from(floats.buffer);
}

function vectorFromFloat32Blob(value, dimensions) {
  const buffer = Buffer.isBuffer(value)
    ? value
    : value instanceof ArrayBuffer
      ? Buffer.from(value)
      : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (buffer.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return null;
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  return Array.from(new Float32Array(arrayBuffer));
}

async function writeSqliteGraph({
  root,
  graph,
  previousGraph = null,
  env = process.env,
  embeddingFetch = globalThis.fetch,
  embeddingConfig = null,
  pullEmbeddings = false,
  onProgress = null,
  platform = process.platform,
  pullTimeoutMs = DEFAULT_OLLAMA_PULL_TIMEOUT_MS,
}) {
  const sqlite = await loadSqlite();
  const status = {
    path: GRAPH_SQLITE_REL_PATH,
    status: sqlite ? "available" : "unavailable",
    engine: sqlite ? "node:sqlite" : null,
  };
  if (!sqlite) return status;

  const sqlitePath = path.join(root, GRAPH_SQLITE_REL_PATH);
  await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
  let db;
  let transactionOpen = false;
  try {
    const sqliteRecovery = await recoverOrRemovePartialSqlite({ sqlite, sqlitePath });
    const resolvedEmbeddingConfig = embeddingConfig ?? await resolveSemanticEmbeddingConfig({ root, env });
    const readinessResult = await prepareSemanticReadiness({
      config: resolvedEmbeddingConfig,
      fetchFn: embeddingFetch,
      pullEmbeddings,
      onProgress,
      platform,
      pullTimeoutMs,
      env,
    });
    const semanticReadiness = readinessResult.readiness;
    const embeddingPull = readinessResult.pull;
    const reusableEmbeddingCache = await readReusableEmbeddingCache({
      sqlite,
      sqlitePath,
      previousGraph,
      graph,
      embeddingConfig: resolvedEmbeddingConfig,
    });
    await removeSqliteSidecarFiles(sqlitePath);
    db = new sqlite.DatabaseSync(sqlitePath, { allowExtension: true });
    db.exec(`
      DROP TABLE IF EXISTS meta;
      DROP TABLE IF EXISTS files;
      DROP TABLE IF EXISTS symbols;
      DROP TABLE IF EXISTS code_lines;
      DROP TABLE IF EXISTS relationships;
      DROP TABLE IF EXISTS vector_items;
      DROP TABLE IF EXISTS vector_chunks;
      DROP TABLE IF EXISTS embedding_cache;
      DROP TABLE IF EXISTS code_vectors;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        line_count INTEGER NOT NULL,
        size INTEGER NOT NULL,
        memory_type TEXT,
        memory_owner TEXT,
        memory_status TEXT,
        memory_last_reviewed TEXT
      );
      CREATE INDEX files_memory_metadata_idx ON files(memory_type, memory_owner, memory_status, memory_last_reviewed);
      CREATE TABLE symbols (name TEXT NOT NULL, path TEXT NOT NULL, line INTEGER);
      CREATE INDEX symbols_name_idx ON symbols(name);
      CREATE INDEX symbols_path_idx ON symbols(path);
      CREATE TABLE code_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, line INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE INDEX code_lines_path_idx ON code_lines(path);
      CREATE INDEX code_lines_text_idx ON code_lines(text);
      CREATE TABLE relationships (
        source_kind TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        relation TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        evidence TEXT
      );
      CREATE INDEX relationships_source_idx ON relationships(source_kind, source_ref);
      CREATE INDEX relationships_target_idx ON relationships(target_kind, target_ref);
      CREATE INDEX relationships_relation_idx ON relationships(relation);
      CREATE TABLE vector_items (
        vector_rowid INTEGER NOT NULL,
        code_line_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY(vector_rowid, code_line_id)
      );
      CREATE TABLE vector_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        vector_rowid INTEGER NOT NULL,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        text TEXT NOT NULL,
        chunk_kind TEXT NOT NULL,
        symbol_name TEXT,
        item_key TEXT NOT NULL
      );
      CREATE INDEX vector_chunks_vector_idx ON vector_chunks(vector_rowid);
      CREATE INDEX vector_chunks_path_span_idx ON vector_chunks(path, start_line, end_line);
      CREATE TABLE embedding_cache (
        item_key TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        model TEXT NOT NULL,
        host TEXT NOT NULL,
        embedding BLOB NOT NULL
      );
    `);

    let vector = withEmbeddingMetadata(await prepareSqliteVec(db, resolvedEmbeddingConfig), resolvedEmbeddingConfig);
    if (semanticReadiness.status !== "ready") {
      const sqliteVecStatus = vector;
      vector = {
        ...semanticVectorUnavailable(semanticReadiness.message, resolvedEmbeddingConfig, semanticReadiness),
        sqlite_vec_status: sqliteVecStatus.status,
        sqlite_vec_reason: sqliteVecStatus.reason ?? null,
      };
    }
    vector.embedding_pull = embeddingPull;
    if (vector.status === "available") {
      db.exec(`CREATE VIRTUAL TABLE code_vectors USING vec0(embedding float[${resolvedEmbeddingConfig.dimensions}])`);
    }

    const beginWrite = () => {
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
    };
    const commitWrite = () => {
      db.exec("COMMIT");
      transactionOpen = false;
    };

    beginWrite();

    const metaInsert = db.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
    metaInsert.run("schema", graph.schema);
    metaInsert.run("built_at", graph.built_at);

    const fileInsert = db.prepare(
      "INSERT INTO files(path, line_count, size, memory_type, memory_owner, memory_status, memory_last_reviewed) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const file of graph.files) {
      fileInsert.run(
        file.path,
        file.line_count,
        file.size,
        file.memory_metadata?.type ?? null,
        file.memory_metadata?.owner ?? null,
        file.memory_metadata?.status ?? null,
        file.memory_metadata?.last_reviewed ?? null,
      );
    }

    const symbolInsert = db.prepare("INSERT INTO symbols(name, path, line) VALUES (?, ?, ?)");
    for (const symbol of graph.symbols) {
      symbolInsert.run(symbol.name, symbol.path, symbol.line ?? null);
    }

    const relationshipInsert = db.prepare(
      "INSERT INTO relationships(source_kind, source_ref, relation, target_kind, target_ref, evidence) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const edge of graph.relationships ?? []) {
      relationshipInsert.run(
        edge.source_kind,
        edge.source_ref,
        edge.relation,
        edge.target_kind,
        edge.target_ref,
        edge.evidence ?? null,
      );
    }

    const lineInsert = db.prepare("INSERT INTO code_lines(path, line, text) VALUES (?, ?, ?)");
    let vectorInsert = vector.status === "available" ? db.prepare("INSERT INTO code_vectors(embedding) VALUES (?)") : null;
    let vectorMapInsert =
      vector.status === "available"
        ? db.prepare("INSERT INTO vector_items(vector_rowid, code_line_id, source) VALUES (?, ?, ?)")
        : null;
    let vectorChunkInsert =
      vector.status === "available"
        ? db.prepare(`
          INSERT INTO vector_chunks(vector_rowid, path, start_line, end_line, text, chunk_kind, symbol_name, item_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        : null;
    const lastInsertId = db.prepare("SELECT last_insert_rowid() AS id");
    const cacheInsert =
      vector.status === "available"
        ? db.prepare("INSERT OR IGNORE INTO embedding_cache(item_key, path, file_hash, dimensions, model, host, embedding) VALUES (?, ?, ?, ?, ?, ?, ?)")
        : null;
    let vectorChunkCount = 0;
    let vectorLineMapCount = 0;
    let uniqueVectorCount = 0;
    let scannedFileCount = 0;
    let filesWithVectors = 0;
    const vectorProgressEnabled = vector.status === "available";
    if (vectorProgressEnabled) {
      await emitSemanticProgress(onProgress, {
        phase: "semantic-vectors",
        status: "running",
        file_count: graph.files.length,
        files_scanned: 0,
        files_embedded: 0,
        files_with_vectors: 0,
        line_count: 0,
        chunk_count: 0,
        message: `AIPI semantic memory: building semantic vectors for ${graph.files.length} files.`,
      });
    }
    const embeddingCache = new Map(reusableEmbeddingCache.cache);
    const embeddingRequestCache = new Map();
    const vectorRowidsByContentKey = new Map();
    const codeLineIdsByPath = new Map();
    const fileLinesByPath = new Map();
    for (const file of graph.files) {
      const content = await fs.readFile(path.join(root, file.path), "utf8").catch(() => "");
      const lines = content.split(/\r?\n/);
      fileLinesByPath.set(file.path, lines);
      const lineIds = new Map();
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        lineInsert.run(file.path, index + 1, line);
        const codeLineId = lastInsertId.get().id;
        lineIds.set(index + 1, codeLineId);
      }
      codeLineIdsByPath.set(file.path, lineIds);
    }
    commitWrite();

    for (const file of graph.files) {
      const lines = fileLinesByPath.get(file.path) ?? [];
      const lineIds = codeLineIdsByPath.get(file.path) ?? new Map();
      if (vectorInsert && vectorMapInsert && vectorChunkInsert) {
        beginWrite();
        const chunks = buildVectorChunksForFile({
          file,
          lines,
          symbols: graph.symbols ?? [],
          relationships: graph.relationships ?? [],
        });
        let fileChunkCount = 0;
        for (const chunk of chunks) {
          try {
            const mappedLineIds = [];
            for (let lineNumber = chunk.start_line; lineNumber <= chunk.end_line; lineNumber += 1) {
              const codeLineId = lineIds.get(lineNumber);
              if (codeLineId != null) mappedLineIds.push(codeLineId);
            }
            if (!mappedLineIds.length) continue;
            const embeddingInput = embeddingInputForCodeChunk(chunk.text);
            const itemKey = embeddingContentKey(embeddingInput);
            let vectorRowid = vectorRowidsByContentKey.get(itemKey);
            if (vectorRowid == null) {
              let cachedEmbedding = embeddingCache.get(itemKey);
              if (!cachedEmbedding) {
                const vectorValues = await embedText(embeddingInput, {
                  root,
                  env,
                  fetchFn: embeddingFetch,
                  cache: embeddingRequestCache,
                });
                cachedEmbedding = embeddingCacheEntryFromVector(vectorValues);
                embeddingCache.set(itemKey, cachedEmbedding);
              }
              vectorInsert.run(cachedEmbedding.literal);
              vectorRowid = lastInsertId.get().id;
              vectorRowidsByContentKey.set(itemKey, vectorRowid);
              cacheInsert?.run(
                itemKey,
                file.path,
                file.hash,
                resolvedEmbeddingConfig.dimensions,
                resolvedEmbeddingConfig.model,
                resolvedEmbeddingConfig.host,
                cachedEmbedding.blob,
              );
              uniqueVectorCount += 1;
            }
            vectorChunkInsert.run(
              vectorRowid,
              chunk.path,
              chunk.start_line,
              chunk.end_line,
              chunk.text,
              chunk.chunk_kind,
              chunk.symbol_name ?? null,
              itemKey,
            );
            for (const codeLineId of mappedLineIds) {
              vectorMapInsert.run(vectorRowid, codeLineId, "code_chunk");
              vectorLineMapCount += 1;
            }
            vectorChunkCount += 1;
            fileChunkCount += 1;
            if (
              vectorProgressEnabled &&
              chunks.length > VECTOR_FILE_SUBPROGRESS_CHUNK_THRESHOLD &&
              (fileChunkCount % VECTOR_FILE_SUBPROGRESS_CHUNK_INTERVAL === 0 || fileChunkCount === chunks.length)
            ) {
              await emitSemanticProgress(onProgress, {
                phase: "semantic-vectors",
                status: "running",
                file_count: graph.files.length,
                files_scanned: scannedFileCount,
                files_embedded: filesWithVectors,
                files_with_vectors: filesWithVectors,
                line_count: vectorChunkCount,
                chunk_count: vectorChunkCount,
                file_path: file.path,
                file_chunks_embedded: fileChunkCount,
                file_chunk_count: chunks.length,
                message: `AIPI semantic memory: embedding ${file.path}: ${fileChunkCount}/${chunks.length} chunks...`,
              });
            }
          } catch (error) {
            vector = semanticVectorUnavailable(error, resolvedEmbeddingConfig);
            vector.embedding_pull = embeddingPull;
            vector.item_count = vectorChunkCount;
            vector.unique_item_count = uniqueVectorCount;
            vector.line_mapping_count = vectorLineMapCount;
            vectorInsert = null;
            vectorMapInsert = null;
            vectorChunkInsert = null;
            break;
          }
        }
        if (fileChunkCount > 0) filesWithVectors += 1;
        commitWrite();
      }
      scannedFileCount += 1;
      if (vectorProgressEnabled && vector.status === "available") {
        await emitSemanticProgress(onProgress, {
          phase: "semantic-vectors",
          status: "running",
          file_count: graph.files.length,
          files_scanned: scannedFileCount,
          files_embedded: filesWithVectors,
          files_with_vectors: filesWithVectors,
          line_count: vectorChunkCount,
          chunk_count: vectorChunkCount,
          files_skipped: scannedFileCount - filesWithVectors,
          message: `AIPI semantic memory: embedded ${filesWithVectors} high-signal files (${vectorChunkCount} chunks); ${scannedFileCount}/${graph.files.length} scanned, ${scannedFileCount - filesWithVectors} low-signal skipped.`,
        });
      }
    }
    if (vectorProgressEnabled) {
      await emitSemanticProgress(onProgress, {
        phase: "semantic-vectors",
        status: vector.status === "available" ? "done" : "failed",
        file_count: graph.files.length,
        files_scanned: scannedFileCount,
        files_embedded: filesWithVectors,
        files_with_vectors: filesWithVectors,
        line_count: vectorChunkCount,
        chunk_count: vectorChunkCount,
        files_skipped: scannedFileCount - filesWithVectors,
        message: vector.status === "available"
          ? `AIPI semantic memory: semantic vectors built: embedded ${filesWithVectors} high-signal files (${vectorChunkCount} chunks); scanned ${scannedFileCount} files, skipped ${scannedFileCount - filesWithVectors} low-signal/no-vector files.`
          : `AIPI semantic memory: semantic vector build stopped after ${vectorChunkCount} chunks; scanned ${scannedFileCount} files, embedded ${filesWithVectors} high-signal files; continuing with lexical memory.`,
      });
    }

    const source = vector.status === "available" ? "sqlite+sqlite-vec+lexical" : "sqlite+lexical";
    if (vector.status === "available") {
      vector.item_count = vectorChunkCount;
      vector.unique_item_count = uniqueVectorCount;
      vector.line_mapping_count = vectorLineMapCount;
      vector.file_count = filesWithVectors;
      vector.scanned_file_count = scannedFileCount;
      vector.skipped_file_count = scannedFileCount - filesWithVectors;
      vector.embedding_cache_reuse = reusableEmbeddingCache.status;
      vector.chunking = {
        strategy: "symbol_or_window",
        window_lines: VECTOR_CHUNK_WINDOW_LINES,
        overlap_lines: VECTOR_CHUNK_WINDOW_OVERLAP_LINES,
      };
    }
    beginWrite();
    metaInsert.run("source", source);
    commitWrite();

    return {
      ...status,
      source,
      file_count: graph.files.length,
      symbol_count: graph.symbols.length,
      relationship_count: graph.relationships?.length ?? 0,
      vector,
      embedding_pull: embeddingPull,
      sqlite_recovery: sqliteRecovery,
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        db?.exec("ROLLBACK");
      } catch {
        /* best-effort rollback */
      }
      transactionOpen = false;
    }
    return {
      ...status,
      status: "unavailable",
      error: String(error?.message ?? error),
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

async function recoverOrRemovePartialSqlite({ sqlite, sqlitePath } = {}) {
  if (!sqlite || !(await pathExists(sqlitePath))) return { status: "missing" };
  const sidecars = SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${sqlitePath}${suffix}`);
  const hadSidecar = (await Promise.all(sidecars.map(pathExists))).some(Boolean);
  let db;
  try {
    db = new sqlite.DatabaseSync(sqlitePath);
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    db.close();
    db = null;
    if (integrity !== "ok") throw new Error(`integrity_check=${integrity}`);
    return { status: hadSidecar ? "recovered" : "ok", hot_journal: hadSidecar };
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
    await removeSqliteSidecarFiles(sqlitePath);
    return {
      status: "removed",
      hot_journal: hadSidecar,
      reason: String(error?.message ?? error),
    };
  }
}

async function removeSqliteSidecarFiles(sqlitePath) {
  await fs.rm(sqlitePath, { force: true }).catch(() => {});
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    await fs.rm(`${sqlitePath}${suffix}`, { force: true }).catch(() => {});
  }
}

async function readReusableEmbeddingCache({
  sqlite,
  sqlitePath,
  previousGraph,
  graph,
  embeddingConfig,
} = {}) {
  if (!sqlite) {
    return {
      cache: new Map(),
      status: { status: "unavailable", reused_item_count: 0, reason: "node:sqlite unavailable" },
    };
  }
  if (!(await pathExists(sqlitePath))) {
    return {
      cache: new Map(),
      status: { status: "missing", reused_item_count: 0, reason: "previous sqlite graph missing" },
    };
  }
  const previousHashes = new Map((previousGraph?.files ?? []).map((file) => [file.path, file.hash]));
  const currentHashes = new Map((graph.files ?? []).map((file) => [file.path, file.hash]));
  const unchanged = new Set();
  for (const [rel, hash] of currentHashes.entries()) {
    if (hash && previousHashes.get(rel) === hash) unchanged.add(rel);
  }

  const failures = [];
  for (const openMode of ["read_only", "immutable"]) {
    try {
      const result = await readReusableEmbeddingCacheWithOpenMode({
        sqlite,
        sqlitePath,
        unchanged,
        currentHashes,
        embeddingConfig,
        openMode,
      });
      if (failures.length > 0) {
        result.status.recovered_from_reason = failures.map((failure) => `${failure.open_mode}: ${failure.reason}`).join("; ");
      }
      return result;
    } catch (error) {
      failures.push({
        open_mode: openMode,
        reason: String(error?.message ?? error),
      });
    }
  }

  return {
    cache: new Map(),
    status: {
      status: "unavailable",
      reused_item_count: 0,
      reason: failures.map((failure) => `${failure.open_mode}: ${failure.reason}`).join("; "),
    },
  };
}

async function readReusableEmbeddingCacheWithOpenMode({
  sqlite,
  sqlitePath,
  unchanged,
  currentHashes,
  embeddingConfig,
  openMode,
} = {}) {
  let db;
  const location = openMode === "immutable" ? sqliteImmutableUri(sqlitePath) : sqlitePath;
  try {
    // embedding_cache is a PLAIN BLOB table — reading it touches no vec0 virtual table, so it must NOT
    // depend on sqlite-vec. Gating this read on prepareSqliteVec (which can throw when the extension is
    // momentarily unavailable) made BOTH open modes fail -> readReusableEmbeddingCache returned an empty
    // Map -> and because every rebuild drops+recreates the DB, the whole codebase was re-embedded from
    // scratch. The decode (embeddingCacheEntryFromStored) is pure JS (Float32 BLOB -> array), no extension
    // needed. Open read-only WITHOUT loading any extension.
    db = new sqlite.DatabaseSync(location, { readOnly: true, timeout: 1 });
    const rows = db.prepare(`
      SELECT item_key, path, file_hash, dimensions, model, host, embedding
      FROM embedding_cache
      WHERE dimensions = ? AND model = ? AND host = ?
    `).all(embeddingConfig.dimensions, embeddingConfig.model, embeddingConfig.host);
    const cache = new Map();
    for (const row of rows) {
      const entry = embeddingCacheEntryFromStored(row.embedding, embeddingConfig.dimensions);
      if (!entry) continue;
      if (String(row.item_key ?? "").startsWith("sha256:")) {
        cache.set(row.item_key, entry);
        continue;
      }
      if (!unchanged.has(row.path)) continue;
      if (currentHashes.get(row.path) !== row.file_hash) continue;
      cache.set(row.item_key, entry);
    }
    return {
      cache,
      status: {
        status: "available",
        open_mode: openMode,
        reused_item_count: cache.size,
        row_count: rows.length,
      },
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

function sqliteImmutableUri(sqlitePath) {
  return `${pathToFileURL(sqlitePath).href}?immutable=1`;
}

async function loadSqlite() {
  try {
    return await import("node:sqlite");
  } catch {
    return null;
  }
}

async function prepareSqliteVec(db, embeddingConfig = {}) {
  const dimensions = embeddingConfig.dimensions ?? GRAPH_VECTOR_DIMENSIONS;
  try {
    const sqliteVec = await import("sqlite-vec");
    db.enableLoadExtension?.(true);
    sqliteVec.load(db);
    const version = db.prepare("SELECT vec_version() AS version").get()?.version ?? null;
    return {
      status: "available",
      engine: "sqlite-vec",
      version,
      dimensions,
    };
  } catch (error) {
    return {
      status: "unavailable",
      engine: "sqlite-vec",
      dimensions,
      reason: String(error?.message ?? error),
    };
  } finally {
    try {
      db.enableLoadExtension?.(false);
    } catch {
      /* best-effort hardening */
    }
  }
}

async function sqliteVectorRefs({ db, root, query, limit, semanticOnly = false, env = process.env, embeddingFetch = globalThis.fetch }) {
  const embeddingConfig = await resolveSemanticEmbeddingConfig({ root, env });
  const vector = await prepareSqliteVec(db, embeddingConfig);
  if (vector.status !== "available") return [];
  try {
    const embedding = await vectorLiteral(query, { root, env, fetchFn: embeddingFetch });
    const rows = db.prepare(`
      SELECT
        chunks.path AS path,
        chunks.start_line AS start_line,
        chunks.end_line AS end_line,
        chunks.text AS text,
        chunks.chunk_kind AS chunk_kind,
        chunks.symbol_name AS symbol_name,
        vectors.distance AS distance
      FROM code_vectors AS vectors
      JOIN vector_chunks AS chunks ON chunks.vector_rowid = vectors.rowid
      WHERE vectors.embedding MATCH ? AND k = ?
      ORDER BY vectors.distance ASC
      LIMIT ?
    `).all(embedding, Math.max(1, limit), Math.max(1, limit));
    return rows.map((row) => ({
      path: row.path,
      line: row.start_line,
      end_line: row.end_line,
      span: { start_line: row.start_line, end_line: row.end_line },
      excerpt: String(row.text ?? "").trim(),
      source: "sqlite-vec",
      chunk_kind: row.chunk_kind,
      symbol: row.symbol_name ?? null,
      distance: Number(row.distance),
    }));
  } catch (error) {
    if (semanticOnly) throw asSemanticUnavailable(error);
    return [];
  }
}

function mergeRefs(refs, limit) {
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const key = `${ref.path}:${ref.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
    if (out.length >= limit) break;
  }
  return out;
}

function escapeLike(value) {
  return String(value ?? "").replace(/[\\%_]/g, "\\$&");
}

async function vectorLiteral(text, options = {}) {
  const vector = await embedText(text, options);
  return vectorLiteralFromArray(vector);
}

export async function embedText(text, {
  root = process.cwd(),
  env = process.env,
  fetchFn = globalThis.fetch,
  cache = null,
} = {}) {
  const input = String(text ?? "");
  const config = await resolveSemanticEmbeddingConfig({ root, env });
  const cacheKey = `${config.host}\n${config.model}\n${input}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  if (typeof fetchFn !== "function") {
    throw semanticUnavailableError("Ollama embedding fetch API is unavailable.", config);
  }

  let response;
  try {
    response = await fetchFn(ollamaEmbedUrl(config.host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        input: [input],
      }),
    });
  } catch (error) {
    throw semanticUnavailableError(`Ollama embedding request failed: ${String(error?.message ?? error)}`, config);
  }

  if (!response?.ok) {
    const status = response?.status ? `HTTP ${response.status}` : "unknown HTTP status";
    throw semanticUnavailableError(`Ollama embedding request failed with ${status}.`, config);
  }

  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw semanticUnavailableError(`Ollama embedding response was not valid JSON: ${String(error?.message ?? error)}`, config);
  }

  const vector = extractOllamaEmbedding(body);
  if (!Array.isArray(vector)) {
    throw semanticUnavailableError("Ollama embedding response did not include an embedding vector.", config);
  }
  if (vector.length !== config.dimensions) {
    throw semanticUnavailableError(
      `Ollama model ${config.model} returned ${vector.length} dimensions; AIPI requires ${config.dimensions}.`,
      config,
    );
  }
  const normalized = vector.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) throw semanticUnavailableError("Ollama embedding vector contains a non-numeric value.", config);
    return number;
  });
  cache?.set(cacheKey, normalized);
  return normalized;
}

function extractOllamaEmbedding(body) {
  if (Array.isArray(body?.embeddings?.[0])) return body.embeddings[0];
  if (Array.isArray(body?.embedding)) return body.embedding;
  if (Array.isArray(body?.data?.[0]?.embedding)) return body.data[0].embedding;
  return null;
}

export async function resolveSemanticEmbeddingConfig({ root = process.cwd(), env = process.env, migrate = false } = {}) {
  const configPath = path.join(root, SEMANTIC_CONFIG_REL_PATH);
  const config = await readJson(configPath).catch(() => null);
  const migration = migrate ? await maybeMigrateLegacySemanticConfig({ configPath, config, env }) : null;
  const resolvedConfig = migration?.config ?? config;
  return {
    host: normalizeOllamaHost(env.AIPI_OLLAMA_HOST ?? resolvedConfig?.ollama_host ?? resolvedConfig?.host ?? DEFAULT_OLLAMA_HOST),
    model: DEFAULT_OLLAMA_MODEL,
    dimensions: GRAPH_VECTOR_DIMENSIONS,
    migration_required: semanticConfigNeedsMigration(config),
    config_migration: migration?.summary ?? null,
  };
}

export function resolveEmbeddingDimensions({ raw, model }) {
  return GRAPH_VECTOR_DIMENSIONS;
}

async function maybeMigrateLegacySemanticConfig({ configPath, config, env = process.env } = {}) {
  if (!semanticConfigNeedsMigration(config)) return null;
  const migrated = {
    ...config,
    schema: "aipi.semantic-memory.v1",
    ollama_host: config.ollama_host ?? config.host ?? DEFAULT_OLLAMA_HOST,
    ollama_model: DEFAULT_OLLAMA_MODEL,
    dimensions: GRAPH_VECTOR_DIMENSIONS,
    rule: defaultSemanticMemoryRule({ model: DEFAULT_OLLAMA_MODEL, dimensions: GRAPH_VECTOR_DIMENSIONS }),
  };
  delete migrated.model;
  delete migrated.ollama_dimensions;
  delete migrated.vector_dimensions;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(migrated, null, 2)}\n`);
  return {
    config: migrated,
    summary: {
      from_model: LEGACY_DEFAULT_OLLAMA_MODEL,
      from_dimensions: LEGACY_DEFAULT_VECTOR_DIMENSIONS,
      to_model: DEFAULT_OLLAMA_MODEL,
      to_dimensions: GRAPH_VECTOR_DIMENSIONS,
    },
  };
}

function semanticConfigNeedsMigration(config) {
  if (!config || typeof config !== "object") return false;
  const model = String(config.ollama_model ?? config.model ?? "").trim();
  const dimensionsRaw = config.ollama_dimensions ?? config.dimensions ?? config.vector_dimensions;
  const dimensions = Number(dimensionsRaw);
  if (!model || normalizeOllamaModelName(model) !== DEFAULT_OLLAMA_MODEL) return true;
  if (!Number.isInteger(dimensions) || dimensions !== GRAPH_VECTOR_DIMENSIONS) return true;
  return false;
}

function normalizeOllamaModelName(model) {
  const text = String(model ?? "").trim();
  return text.replace(/:latest$/i, "");
}

function defaultSemanticMemoryRule({ model, dimensions }) {
  return `Semantic code search uses local Ollama embeddings. Run \`ollama pull ${model}\` before semantic-only search or onboarding rebuild; aipi_retrieve, aipi_callers, and aipi_impact continue with exact/lexical fallback when embeddings are unavailable, but onboarding must report semantic memory is OFF loudly instead of silently degrading. Expected vector width: ${dimensions}.`;
}

function normalizeOllamaHost(value) {
  const raw = String(value ?? DEFAULT_OLLAMA_HOST).trim() || DEFAULT_OLLAMA_HOST;
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, "") : `http://${raw.replace(/\/+$/, "")}`;
}

function ollamaEmbedUrl(host) {
  return `${normalizeOllamaHost(host)}${OLLAMA_EMBED_PATH}`;
}

function ollamaTagsUrl(host) {
  return `${normalizeOllamaHost(host)}${OLLAMA_TAGS_PATH}`;
}

function ollamaPullUrl(host) {
  return `${normalizeOllamaHost(host)}${OLLAMA_PULL_PATH}`;
}

async function prepareSemanticReadiness({
  config,
  fetchFn = globalThis.fetch,
  pullEmbeddings = false,
  onProgress = null,
  platform = process.platform,
  pullTimeoutMs = DEFAULT_OLLAMA_PULL_TIMEOUT_MS,
  env = process.env,
} = {}) {
  let readiness = await checkSemanticEmbeddingReadiness({ config, fetchFn, platform });
  if (readiness.status !== "model_missing") return { readiness, pull: null };

  if (!pullEmbeddings || pullEmbeddingsDisabled(env)) {
    return {
      readiness,
      pull: {
        status: "skipped",
        reason: pullEmbeddings ? "env_disabled" : "disabled",
        host: readiness.host,
        model: readiness.model,
      },
    };
  }

  const startedAt = new Date().toISOString();
  try {
    await emitSemanticPullProgress(onProgress, {
      phase: "semantic-pull",
      status: "running",
      model: readiness.model,
      message: `AIPI onboarding: pulling ${readiness.model} (~1.2GB) for semantic memory.`,
    });
    const pull = await pullOllamaModel({
      host: readiness.host,
      model: readiness.model,
      fetchFn,
      onProgress,
      timeoutMs: pullTimeoutMs,
    });
    readiness = await checkSemanticEmbeddingReadiness({ config, fetchFn, platform });
    return {
      readiness,
      pull: {
        ...pull,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        readiness_after: readiness.status,
      },
    };
  } catch (error) {
    const pull = {
      status: "failed",
      host: readiness.host,
      model: readiness.model,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      error: String(error?.message ?? error),
    };
    await emitSemanticPullProgress(onProgress, {
      phase: "semantic-pull",
      status: "failed",
      model: readiness.model,
      message: `AIPI onboarding: ${readiness.model} pull failed; continuing with lexical memory.`,
    });
    return {
      readiness: {
        ...readiness,
        message: `${readiness.message} Auto-pull failed: ${pull.error}`,
        pull,
      },
      pull,
    };
  }
}

export async function checkSemanticEmbeddingReadiness({ config, fetchFn = globalThis.fetch, platform = process.platform } = {}) {
  const normalized = {
    host: normalizeOllamaHost(config?.host ?? DEFAULT_OLLAMA_HOST),
    model: DEFAULT_OLLAMA_MODEL,
    dimensions: GRAPH_VECTOR_DIMENSIONS,
    config_migration: config?.config_migration ?? null,
  };
  if (typeof fetchFn !== "function") {
    return semanticReadinessOff("ollama_unreachable", normalized, "Ollama fetch API is unavailable.", { platform });
  }
  let response;
  try {
    response = await fetchFn(ollamaTagsUrl(normalized.host), { method: "GET" });
  } catch (error) {
    return semanticReadinessOff("ollama_unreachable", normalized, `Ollama is unreachable: ${String(error?.message ?? error)}`, { platform });
  }
  if (!response?.ok) {
    const status = response?.status ? `HTTP ${response.status}` : "unknown HTTP status";
    return semanticReadinessOff("ollama_unreachable", normalized, `Ollama /api/tags failed with ${status}.`, { platform });
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    return semanticReadinessOff("ollama_unreachable", normalized, `Ollama /api/tags returned invalid JSON: ${String(error?.message ?? error)}`, { platform });
  }
  const names = new Set((body?.models ?? []).map((item) => {
    if (typeof item === "string") return item;
    return String(item?.name ?? item?.model ?? "").trim();
  }).filter(Boolean));
  const found = [...names].some((name) => name === normalized.model || name.startsWith(`${normalized.model}:`));
  if (!found) {
    return semanticReadinessOff(
      "model_missing",
      normalized,
      `Ollama is running but model ${normalized.model} is not pulled.`,
    );
  }
  return {
    status: "ready",
    host: normalized.host,
    model: normalized.model,
    dimensions: normalized.dimensions,
    config_migration: normalized.config_migration,
    message: `semantic memory is ON - Ollama model ${normalized.model} is available.`,
    action: null,
  };
}

export async function pullOllamaModel({
  host = DEFAULT_OLLAMA_HOST,
  model = DEFAULT_OLLAMA_MODEL,
  fetchFn = globalThis.fetch,
  onProgress = null,
  timeoutMs = DEFAULT_OLLAMA_PULL_TIMEOUT_MS,
} = {}) {
  if (typeof fetchFn !== "function") {
    throw new Error("Ollama pull fetch API is unavailable.");
  }
  const normalizedHost = normalizeOllamaHost(host);
  const startedAt = new Date().toISOString();
  const first = await postOllamaPull({ host: normalizedHost, body: { model, stream: true }, fetchFn, timeoutMs });
  const response = first.ok
    ? first
    : await postOllamaPull({ host: normalizedHost, body: { name: model, stream: true }, fetchFn, timeoutMs });
  if (!response.ok) {
    const status = response.status ? `HTTP ${response.status}` : "unknown HTTP status";
    throw new Error(`Ollama /api/pull failed with ${status}.`);
  }
  const events = await readOllamaPullEvents(response, async (event) => {
    const total = Number(event.total);
    const completed = Number(event.completed);
    const percent = Number.isFinite(total) && total > 0 && Number.isFinite(completed)
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : null;
    await emitSemanticPullProgress(onProgress, {
      phase: "semantic-pull",
      status: "running",
      model,
      percent,
      message: percent == null
        ? `AIPI onboarding: pulling ${model}: ${String(event.status ?? "in progress")}.`
        : `AIPI onboarding: pulling ${model}: ${percent}%.`,
    });
  });
  await emitSemanticPullProgress(onProgress, {
    phase: "semantic-pull",
    status: "done",
    model,
    percent: 100,
    message: `AIPI onboarding: ${model} pull complete.`,
  });
  return {
    status: "success",
    host: normalizedHost,
    model,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    events,
  };
}

async function postOllamaPull({ host, body, fetchFn, timeoutMs }) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    return await fetchFn(ollamaPullUrl(host), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller?.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`Ollama /api/pull timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function readOllamaPullEvents(response, onEvent) {
  const events = [];
  const handleLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      if (/^\s*\{/.test(trimmed)) throw new Error(`Ollama /api/pull returned invalid JSON: ${trimmed}`);
      events.push({ status: trimmed });
      await onEvent?.({ status: trimmed });
      return;
    }
    events.push(event);
    await onEvent?.(event);
    if (event.error) throw new Error(`Ollama /api/pull failed: ${String(event.error)}`);
  };

  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) await handleLine(line);
    }
    buffered += decoder.decode();
    if (buffered) await handleLine(buffered);
    return events;
  }

  if (response.body?.[Symbol.asyncIterator]) {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of response.body) {
      buffered += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) await handleLine(line);
    }
    buffered += decoder.decode();
    if (buffered) await handleLine(buffered);
    return events;
  }

  const text = typeof response.text === "function" ? await response.text() : "";
  for (const line of text.split(/\r?\n/)) await handleLine(line);
  return events;
}

async function emitSemanticPullProgress(onProgress, event) {
  await emitSemanticProgress(onProgress, event);
}

async function emitSemanticProgress(onProgress, event) {
  if (typeof onProgress !== "function") return;
  try {
    await Promise.resolve(onProgress(event));
  } catch {
    /* semantic progress is best-effort; the graph result remains authoritative */
  }
}

function pullEmbeddingsDisabled(env = process.env) {
  return /^(0|false|no|off)$/i.test(String(env.AIPI_PULL_EMBEDDINGS ?? "").trim());
}

function semanticReadinessOff(status, config, reason, { platform = process.platform } = {}) {
  const installHint = status === "ollama_unreachable" ? ollamaInstallHint(platform) : null;
  return {
    status,
    host: config.host,
    model: config.model,
    dimensions: config.dimensions,
    config_migration: config.config_migration ?? null,
    reason,
    message: `${reason} ${ollamaInstallMessage(config, { installHint })}`,
    action: `ollama pull ${config.model}`,
    install_hint: installHint,
  };
}

function withEmbeddingMetadata(vector, config) {
  return {
    ...vector,
    dimensions: config.dimensions ?? GRAPH_VECTOR_DIMENSIONS,
    semantic_backend: "ollama",
    embedding_model: config.model,
    embedding_host: config.host,
    config_migration: config.config_migration ?? null,
  };
}

function semanticVectorUnavailable(error, config = {}, readiness = null) {
  return {
    status: "unavailable",
    engine: "sqlite-vec",
    dimensions: config.dimensions ?? GRAPH_VECTOR_DIMENSIONS,
    semantic_backend: "ollama",
    embedding_model: config.model ?? DEFAULT_OLLAMA_MODEL,
    embedding_host: config.host ?? DEFAULT_OLLAMA_HOST,
    config_migration: config.config_migration ?? null,
    reason: semanticUnavailableReason(error, config),
    readiness: readiness
        ? {
          status: readiness.status,
          message: readiness.message,
          action: readiness.action ?? null,
          install_hint: readiness.install_hint ?? null,
          pull: readiness.pull ?? null,
        }
      : null,
  };
}

function semanticUnavailableReason(error, config = {}) {
  const message = String(error?.message ?? error ?? "").trim();
  return hasOllamaInstallGuidance(message) ? message : `${message || "semantic embeddings unavailable"} ${ollamaInstallMessage(config)}`;
}

function semanticUnavailableError(message, config = {}) {
  const error = new Error(semanticUnavailableReason(message, config));
  error.code = "AIPI_SEMANTIC_UNAVAILABLE";
  error.details = {
    semantic_backend: "ollama",
    embedding_model: config.model ?? DEFAULT_OLLAMA_MODEL,
    embedding_host: config.host ?? DEFAULT_OLLAMA_HOST,
    dimensions: config.dimensions ?? GRAPH_VECTOR_DIMENSIONS,
  };
  return error;
}

function asSemanticUnavailable(error) {
  if (error?.code === "AIPI_SEMANTIC_UNAVAILABLE") return error;
  return semanticUnavailableError(error);
}

function ollamaInstallMessage(config = {}, { installHint = null } = {}) {
  const model = String(config.model ?? DEFAULT_OLLAMA_MODEL).trim() || DEFAULT_OLLAMA_MODEL;
  const dimensions = resolveEmbeddingDimensions({ raw: config.dimensions, model });
  const message = (
    `semantic memory is OFF - run \`ollama pull ${model}\`, then re-run onboarding / rebuild. ` +
    `AIPI semantic search requires Ollama running with the ${dimensions}-dim ${model} model. ` +
    "Set AIPI_OLLAMA_HOST only if Ollama runs on another host."
  );
  return installHint?.message ? `${message} ${installHint.message}` : message;
}

function hasOllamaInstallGuidance(message) {
  return /semantic memory is OFF - run `ollama pull [^`]+`/.test(String(message ?? ""));
}

function ollamaInstallHint(platform = process.platform) {
  const normalized = String(platform ?? "").toLowerCase();
  if (normalized === "win32") {
    return {
      platform: "win32",
      command: "winget install Ollama.Ollama",
      message: "Ollama does not appear reachable; install it on Windows with `winget install Ollama.Ollama` or visit https://ollama.com/download. AIPI will not install system software.",
    };
  }
  if (normalized === "darwin") {
    return {
      platform: "darwin",
      command: "brew install ollama",
      message: "Ollama does not appear reachable; install it on macOS with `brew install ollama` or visit https://ollama.com/download. AIPI will not install system software.",
    };
  }
  if (normalized === "linux") {
    return {
      platform: "linux",
      command: "curl -fsSL https://ollama.com/install.sh | sh",
      message: "Ollama does not appear reachable; install it on Linux with `curl -fsSL https://ollama.com/install.sh | sh` or visit https://ollama.com/download. AIPI will not install system software.",
    };
  }
  return {
    platform: normalized || "unknown",
    command: null,
    message: "Ollama does not appear reachable; install it from https://ollama.com/download. AIPI will not install system software.",
  };
}

function lineNumberForIndex(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function relationshipRefsFromGraph({ graph, query = "", targetPath = "", limit = 16, source = "manifest" } = {}) {
  const needle = String(targetPath || query || "").trim().toLowerCase();
  if (!needle) return [];
  return (graph.relationships ?? [])
    .filter((edge) => relationshipMatches(edge, needle))
    .sort((left, right) => compareRelationshipRefs(left, right, needle))
    .slice(0, Math.max(1, limit))
    .map((edge) => ({ ...edge, source }));
}

function compareRelationshipRefs(left, right, needle = "") {
  const leftRank = relationshipRank(left, needle);
  const rightRank = relationshipRank(right, needle);
  return leftRank - rightRank ||
    String(left.relation ?? "").localeCompare(String(right.relation ?? "")) ||
    String(left.source_ref ?? "").localeCompare(String(right.source_ref ?? "")) ||
    String(left.target_ref ?? "").localeCompare(String(right.target_ref ?? ""));
}

function relationshipRank(edge, needle = "") {
  const normalizedNeedle = String(needle ?? "").toLowerCase();
  const sourceRef = String(edge.source_ref ?? "").toLowerCase();
  const targetRef = String(edge.target_ref ?? "").toLowerCase();
  const exactPathMatch = normalizedNeedle && (sourceRef === normalizedNeedle || targetRef === normalizedNeedle) ? 0 : 5;
  return exactPathMatch + (RELATIONSHIP_PRIORITY.get(edge.relation) ?? 100) + relationshipEvidenceRank(edge);
}

function relationshipEvidenceRank(edge) {
  const evidence = String(edge?.evidence ?? "").toLowerCase();
  if (/structured .*link/.test(evidence)) return 0;
  if (evidence.includes("explicit source path")) return 1;
  if (evidence.includes("source import/reference")) return 2;
  return 5;
}

function relationshipMatches(edge, needle) {
  return [
    edge.source_kind,
    edge.source_ref,
    edge.relation,
    edge.target_kind,
    edge.target_ref,
    edge.evidence,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(needle));
}

async function readProjectText(root, rel) {
  return fs.readFile(path.join(root, rel), "utf8").catch(() => "");
}

function isTestFile(rel) {
  return /(^|\/)(test|tests|__tests__)\/|(\.test|\.spec)\./i.test(rel);
}

function isMemoryFile(rel) {
  return rel.startsWith(".aipi/memory/project/") && rel.endsWith(".md");
}

function testCoverageEvidence({ testRel, sourceRel, normalizedContent }) {
  const withoutExt = sourceRel.replace(/\.[^.]+$/, "").toLowerCase();
  const basename = path.basename(withoutExt).toLowerCase();
  if (normalizedContent.includes(sourceRel.toLowerCase()) ||
    normalizedContent.includes(withoutExt) ||
    normalizedContent.includes(`/${basename}`) ||
    normalizedContent.includes(`..\/${basename}`)) {
    return "source import/reference";
  }
  return sharesStem(testRel, sourceRel) ? "shared stem" : null;
}

function mentionsPath(normalizedContent, rel) {
  const normalizedRel = rel.toLowerCase();
  const basename = path.basename(rel).toLowerCase();
  const stem = basename.replace(/\.[^.]+$/, "");
  return normalizedContent.includes(normalizedRel) ||
    normalizedContent.includes(normalizedRel.replace(/\.[^.]+$/, "")) ||
    normalizedContent.includes(basename) ||
    normalizedContent.includes(stem);
}

function mentionsWord(normalizedContent, word) {
  const normalized = String(word ?? "").toLowerCase();
  if (!normalized || normalized.length < 3) return false;
  return new RegExp(`(^|[^a-z0-9_$])${escapeRegex(normalized)}([^a-z0-9_$]|$)`, "i").test(normalizedContent);
}

function memorySourceKind(rel) {
  if (rel.endsWith("/business-rules.md")) return "business_rule_memory";
  if (rel.endsWith("/decisions.md")) return "decision_memory";
  if (rel.endsWith("/deployment.md")) return "deployment_memory";
  if (rel.endsWith("/environment.md")) return "environment_memory";
  return "project_memory";
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sharesStem(a, b) {
  const left = coverageStem(a);
  const right = coverageStem(b);
  if (GENERIC_TEST_COVER_STEMS.has(left) || GENERIC_TEST_COVER_STEMS.has(right)) return false;
  return left && right && (left.includes(right) || right.includes(left));
}

function coverageStem(rel) {
  return path.basename(rel)
    .replace(/\.(test|spec)\./i, ".")
    .split(".")[0]
    .toLowerCase()
    .replace(/^test[_-]/, "")
    .replace(/[_-]test$/, "");
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function projectMemoryFileForKind(kind) {
  const normalized = slug(kind);
  return PROJECT_MEMORY_KIND_TO_FILE.get(normalized) ?? "knowledge.md";
}

export function memoryPromotionHash({ kind, title, content, source_ref } = {}) {
  return `sha256:${contentHash([
    slug(kind),
    String(title ?? "").trim(),
    String(content ?? "").trim(),
    String(source_ref ?? "").trim(),
  ].join("\n")).slice(0, 16)}`;
}

function renderMemoryEntry({ kind, title, content, source_ref, approval_ref, timestamp, promotionHash, accepted = false }) {
  const normalizedKind = slug(kind);
  if (normalizedKind === "business-rule" || normalizedKind === "business-rules") {
    return renderBusinessRuleEntry({ title, content, source_ref, approval_ref, timestamp, promotionHash, accepted });
  }
  if (normalizedKind === "decision" || normalizedKind === "decisions") {
    return renderDecisionEntry({ title, content, source_ref, approval_ref, timestamp, promotionHash });
  }
  return [
    `## ${title?.trim() || kind}`,
    "",
    `- promoted_at: ${timestamp}`,
    `- kind: ${kind}`,
    `- source_ref: ${source_ref}`,
    `- approval_ref: ${approval_ref}`,
    `- promotion_hash: ${promotionHash}`,
    "",
    content.trim(),
    "",
  ].join("\n");
}

function renderBusinessRuleEntry({ title, content, source_ref, approval_ref, timestamp, promotionHash, accepted = false }) {
  const ruleId = extractBusinessRuleId(content) ?? generatedBusinessRuleId(timestamp);
  const ruleTitle = title?.trim() || firstContentLine(content) || "Promoted business rule";
  const statement = extractField(content, "statement") ?? stripMarkdownHeading(content).trim();
  const sourcePath = codePathFromSourceRef(source_ref);
  const links = sourcePath ? `implements:[${sourcePath}], relates:[], decided-by:[]` : "implements:[], relates:[], decided-by:[]";
  // Rule-as-contract fields (RC4): the code the rule governs (impacted-files), an OPTIONAL executable anchor
  // that asserts the rule still holds (verify), and when the rule was last confirmed against code
  // (last-verified). The drift detector reads these — see detectBusinessRuleDrift. impacted-files defaults to
  // the source code path so even a minimally-stated rule gets code-drift coverage.
  const impactedFiles = (extractField(content, "impacted-files") || sourcePath || "").trim();
  const verify = (extractField(content, "verify") || "").trim();
  return [
    `### ${ruleId} - ${ruleTitle}`,
    "- **domain:** project",
    `- **statement:** ${singleLine(statement)}`,
    "- **scenarios:**",
    "  - Given the accepted project context, When this rule applies, Then the statement above remains true.",
    `- **status:** ${accepted ? "accepted" : "candidate"}`,
    `- **source:** ${source_ref}`,
    `- **impacted-files:** ${impactedFiles}`,
    `- **verify:** ${verify}`,
    `- **rationale:** Promoted through aipi_promote_memory at ${timestamp}.`,
    `- **links:** ${links}`,
    `- **approval-ref:** ${approval_ref}`,
    `- **promotion-hash:** ${promotionHash}`,
    `- **last-verified:** ${timestamp.slice(0, 10)}`,
    `- **last-reviewed:** ${timestamp.slice(0, 10)}`,
    "",
  ].join("\n");
}

function codePathFromSourceRef(sourceRef) {
  const normalized = String(sourceRef ?? "").trim().replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith(".aipi/")) return "";
  const withoutFragment = normalized.split("#")[0];
  const withoutLine = withoutFragment.replace(/:\d+(?::\d+)?$/, "");
  const ext = path.posix.extname(withoutLine).toLowerCase();
  if (!ext || ext === ".md" || !CODE_EXTENSIONS.has(ext)) return "";
  return withoutLine;
}

function renderDecisionEntry({ title, content, source_ref, approval_ref, timestamp, promotionHash }) {
  const decisionId = generatedDecisionId(timestamp);
  const decisionTitle = title?.trim() || firstContentLine(content) || "Promoted decision";
  return [
    `### ${decisionId} - ${decisionTitle}`,
    "- **status:** accepted",
    `- **context:** ${source_ref}`,
    `- **decision:** ${singleLine(stripMarkdownHeading(content).trim())}`,
    "- **consequences:** See source evidence and follow-up implementation artifacts.",
    "- **links:** rules:[], code:[], tests:[]",
    `- **approval-ref:** ${approval_ref}`,
    `- **promotion-hash:** ${promotionHash}`,
    `- **date:** ${timestamp.slice(0, 10)}`,
    "",
  ].join("\n");
}

// RC4: code-vs-rule drift. Durable business rules are contracts over code (impacted-files + optional verify
// anchor). When a run changes the code a rule governs, the rule MIGHT be stale — we SURFACE that (queue a
// drift report + audit-ledger entry) and NEVER mutate business-rules.md. A human reconciles via
// `/aipi-memory reconcile`. Deterministic by default (no model, no shell on the hot path): the executor wires
// detection-only (impacted-files ∩ changed). The executable verify anchor is opt-in (inject runVerify) so the
// engine never runs arbitrary shell from a memory file on autopilot. Honest residual: detection is only as
// good as a rule's anchor adequacy and its impacted-files recall.
const MEMORY_DRIFT_DIR = ".aipi/runtime/memory-drift";

// Parse business-rules.md into structured rule contracts. Tolerant of hand-edited files (missing fields → "").
// Fenced code blocks are blanked first (via stripFencedCodeBlocks) so an EXAMPLE rule inside docs — e.g. the
// "### BR-001 …" template seeded into every project's business-rules.md — is never parsed as a real rule
// (which would otherwise be a phantom contract: a spurious doctor warning + a `verify --strict` failure on a
// fresh project).
export function parseBusinessRules(text) {
  const src = stripFencedCodeBlocks(text);
  const headers = [...src.matchAll(/^### (.+)$/gm)];
  const rules = [];
  for (let index = 0; index < headers.length; index += 1) {
    const start = headers[index].index;
    const end = index + 1 < headers.length ? headers[index + 1].index : src.length;
    const block = src.slice(start, end);
    const header = headers[index][1].trim();
    const id = header.match(/\bBR-[A-Za-z0-9_-]+\b/)?.[0] ?? null;
    const titleParts = header.split(/\s+-\s+/);
    const title = titleParts.length > 1 ? titleParts.slice(1).join(" - ").trim() : header;
    const impactedRaw = extractField(block, "impacted-files") ?? "";
    const impacted_files = impactedRaw
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter((value) => value && value.toLowerCase() !== "none");
    rules.push({
      id,
      title,
      statement: extractField(block, "statement") ?? "",
      source: extractField(block, "source") ?? "",
      impacted_files,
      verify: extractField(block, "verify") ?? "",
      last_verified: extractField(block, "last-verified") ?? "",
      promotion_hash: extractField(block, "promotion-hash") ?? "",
    });
  }
  return rules;
}

function normalizeDriftPath(value) {
  return String(value ?? "")
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/#.*$/, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .trim();
}

function ruleFileMatchesChange(ruleFile, changed) {
  const a = normalizeDriftPath(ruleFile);
  if (!a) return false;
  return changed.some((c) => c === a || c.endsWith(`/${a}`) || a.endsWith(`/${c}`));
}

// A verify anchor is only runnable if it is a non-empty command that is NOT a markdown field line. Defense in
// depth: even if a hand-edited file leaves a malformed/field-shaped value in `verify`, we never hand it to the
// shell runner — we fall back to detection-only (impacted_files_changed) for that rule.
function isRunnableVerifyAnchor(verify) {
  const value = String(verify ?? "").trim();
  return Boolean(value) && !value.startsWith("- **");
}

// The drift id is the STABLE identity of "this rule has this kind of drift": rule_id + signal + source +
// statement. It deliberately excludes the changed-file SUBSET — that is evidence (carried as report payload),
// not identity. Folding `changed` in would mutate the id as a multi-impacted-file rule accrues more matched
// files across the steps of one run (gitChangedFiles unions all uncommitted), which would defeat dismissal
// (a fresh id every step) and duplicate open reports. source + statement still separate two DISTINCT rules
// that share a BR- id (or both parse to null → "BR-UNKNOWN"); no time/run component → same rule re-detected
// hashes identically and dedupes.
function computeDriftId(drift) {
  return `${drift.rule_id ?? "BR-UNKNOWN"}-${contentHash([drift.signal, drift.source ?? "", drift.statement ?? ""].join("|")).slice(0, 8)}`;
}

// Best-effort union of staged + unstaged + untracked paths, used only when the caller passes no changedFiles.
function gitChangedFiles(root, git) {
  const out = new Set();
  for (const args of [["diff", "--name-only", "HEAD"], ["diff", "--name-only"], ["ls-files", "--others", "--exclude-standard"]]) {
    try {
      const result = git(root, args);
      if (result && result.status === 0) {
        for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
          const value = normalizeDriftPath(line);
          if (value) out.add(value);
        }
      }
    } catch {
      // git unavailable / not a repo → no code-drift signal (honest limit), never throw
    }
  }
  return [...out];
}

export async function detectBusinessRuleDrift({
  root: rootIn,
  changedFiles = null,
  now = () => new Date(),
  git = defaultMemoryGit,
  runVerify = null,
  queue = true,
} = {}) {
  const root = assertRoot(rootIn);
  const rulesAbs = path.join(root, ".aipi", "memory", "project", "business-rules.md");
  const text = await fs.readFile(rulesAbs, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const allRules = parseBusinessRules(text);
  const rules = allRules.filter((rule) => rule.impacted_files.length);
  const changed = (Array.isArray(changedFiles) ? changedFiles : gitChangedFiles(root, git))
    .map(normalizeDriftPath)
    .filter(Boolean);

  const drifts = [];
  let inScope = 0;
  for (const rule of rules) {
    const hit = rule.impacted_files.filter((file) => ruleFileMatchesChange(file, changed));
    if (!hit.length) continue;
    inScope += 1;
    let signal = "impacted_files_changed";
    let severity = "review";
    if (isRunnableVerifyAnchor(rule.verify) && typeof runVerify === "function") {
      let status = 1; // fail-safe: unknown/missing/non-numeric outcome SURFACES drift, never suppresses it
      try {
        const result = await runVerify({ cwd: root, command: rule.verify });
        // Only a REAL numeric exit code may signal "pass". `Number()` would coerce null/false/""/[] to 0 — and
        // child_process.spawnSync returns `status: null` when the process is killed by a signal (timeout/OOM),
        // i.e. exactly when a rule is most likely violated. Treating those as 0 would be fail-OPEN; require a
        // finite number so a missing/signal-killed/garbage result surfaces a high verify_failed drift instead.
        status = (typeof result?.status === "number" && Number.isFinite(result.status)) ? result.status : 1;
      } catch {
        status = 1;
      }
      if (status === 0) continue; // anchor passed → the rule still holds → not drift
      signal = "verify_failed";
      severity = "high";
    }
    drifts.push({
      rule_id: rule.id,
      title: rule.title,
      signal,
      severity,
      changed: hit,
      source: rule.source,
      statement: rule.statement || "",
      verify: rule.verify || "",
    });
  }

  const queued = [];
  if (queue) {
    const currentIds = new Set(drifts.map(computeDriftId));
    // Reap dismissed/resolved TOMBSTONES whose cause is no longer in the current change set. This scopes a
    // dismissal to the episode that produced it: it sticks while the rule's files stay dirty (so it does not
    // re-spam every passed step), but once those changes are committed/reverted the tombstone is cleared, so a
    // GENUINE future re-violation of the same rule re-surfaces instead of being silently swallowed forever. It
    // also bounds the queue dir. Open reports are left alone — they are the human's pending queue.
    await reapStaleDriftTombstones(root, currentIds);
    for (const drift of drifts) {
      const id = computeDriftId(drift);
      const rel = path.posix.join(MEMORY_DRIFT_DIR, `${id}.json`);
      // pathExists suppresses re-queue for BOTH open reports AND still-relevant dismissed/resolved tombstones,
      // so a dismissed false positive does not re-surface on every passed step while its files stay dirty.
      if (await pathExists(path.join(root, rel))) {
        queued.push({ id, status: "duplicate" });
        continue;
      }
      const detectedAt = now().toISOString();
      await writeProjectFile(root, rel, `${JSON.stringify({ schema: "aipi.memory-drift.v1", id, status: "open", detected_at: detectedAt, ...drift }, null, 2)}\n`);
      await appendMemoryAudit(root, {
        recorded_at: detectedAt,
        event: "drift_detected",
        kind: "business-rule",
        title: drift.title ?? null,
        source_ref: drift.source,
        drift_id: id,
        signal: drift.signal,
        severity: drift.severity,
        changed: drift.changed,
      });
      queued.push({ id, status: "queued", path: rel });
    }
  }

  return { schema: "aipi.memory-drift-scan.v1", checked: rules.length, in_scope: inScope, drifts, queued };
}

// Delete dismissed/resolved tombstones whose id is NOT in the current scan's active drift set — their cause has
// cleared, so they should no longer suppress a future re-detection. Filename (not the JSON `id` field) is the
// path source, so a hand-tampered report can't redirect the unlink. Open reports are never reaped here.
async function reapStaleDriftTombstones(root, currentIds) {
  const dir = path.join(root, MEMORY_DRIFT_DIR);
  const names = await fs.readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    if (currentIds.has(id)) continue; // still an active cause → keep suppressing
    let status = "open";
    try {
      status = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")).status ?? "open";
    } catch {
      status = "open"; // unreadable → treat as open and leave it for the human, don't reap
    }
    if (status === "dismissed" || status === "resolved") {
      await fs.rm(path.join(dir, name), { force: true });
    }
  }
}

export async function listBusinessRuleDrifts(rootIn, { includeResolved = false } = {}) {
  const root = assertRoot(rootIn);
  const dir = path.join(root, MEMORY_DRIFT_DIR);
  const entries = await fs.readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const drifts = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      drifts.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
    } catch {
      drifts.push({ id: name.replace(/\.json$/, ""), status: "unreadable" });
    }
  }
  // The human surface shows only OPEN drifts; dismissed/resolved tombstones stay on disk (so detection won't
  // re-queue them on a still-dirty tree) but are hidden unless explicitly requested.
  const visible = includeResolved ? drifts : drifts.filter((d) => (d.status ?? "open") === "open");
  return visible.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

// Tombstone (not delete) a drift: rewrite the queue file with a non-open status so it disappears from the human
// surface BUT still exists on disk — the detect dedup guard (pathExists) then keeps it suppressed, so a
// dismissed false positive does not re-surface on every passed step while the working tree is still dirty. The
// id is run-stable, so a hard delete would let the very next scan re-queue the identical drift.
export async function resolveBusinessRuleDrift({ root: rootIn, id, action = "dismiss", now = () => new Date() } = {}) {
  const root = assertRoot(rootIn);
  const clean = String(id ?? "").trim().replace(/\.json$/i, "");
  if (!clean || /[\\/]/.test(clean) || clean.includes("..")) {
    throw new Error(`invalid drift id: ${id}`);
  }
  const rel = path.posix.join(MEMORY_DRIFT_DIR, `${clean}.json`);
  const abs = path.join(root, rel);
  if (!(await pathExists(abs))) {
    throw new Error(`no drift '${clean}' to ${action}`);
  }
  const resolvedAt = now().toISOString();
  const status = action === "resolve" ? "resolved" : "dismissed";
  let report;
  try {
    report = JSON.parse(await fs.readFile(abs, "utf8"));
  } catch {
    report = { schema: "aipi.memory-drift.v1", id: clean };
  }
  await writeProjectFile(root, rel, `${JSON.stringify({ ...report, id: clean, status, resolved_at: resolvedAt }, null, 2)}\n`);
  await appendMemoryAudit(root, {
    recorded_at: resolvedAt,
    event: action === "resolve" ? "drift_resolved" : "drift_dismissed",
    drift_id: clean,
  });
  return { id: clean, action, status, path: rel };
}

async function inspectDurableMemoryApproval(root, approvalRef) {
  if (!approvalRef?.trim()) {
    return { ok: false, reason: "durable memory promotion requires approval_ref" };
  }
  const normalized = String(approvalRef).replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (!normalized.startsWith(".aipi/runtime/approvals/approved/")) {
    return {
      ok: false,
      reason: "approval_ref must point under .aipi/runtime/approvals/approved/",
    };
  }
  const abs = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    return { ok: false, reason: "approval_ref escapes project root" };
  }
  if (!(await pathExists(abs))) {
    return { ok: false, reason: `approval_ref does not exist: ${normalized}` };
  }
  // RC2: validate the artifact's CONTENT, not mere existence — a durable write must be backed by an
  // explicit APPROVED decision AND a non-empty source. This is what stops a self-minted/blank artifact
  // from passing, and keeps the source auditable (executor vs human-drain vs deterministic-extractor).
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(abs, "utf8"));
  } catch {
    return { ok: false, reason: `approval_ref is not valid JSON: ${normalized}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: `approval_ref must be a JSON object: ${normalized}` };
  }
  if (parsed.decision !== "APPROVED") {
    return { ok: false, reason: `approval_ref decision must be APPROVED (got ${parsed.decision ?? "none"})` };
  }
  const source = typeof parsed.source === "string" ? parsed.source.trim() : "";
  if (!source) {
    return { ok: false, reason: "approval_ref must record a non-empty source" };
  }
  return { ok: true, path: normalized, decision: parsed.decision, source };
}

async function insertMemoryEntry({ root, targetRel, entry, kind, timestamp, sourceRef, promotionHash }) {
  const abs = path.join(root, targetRel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const existing = await fs.readFile(abs, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const next = insertIntoCurrentTruth(existing, entry, {
    targetRel,
    kind,
    timestamp,
    sourceRef,
    promotionHash,
  });
  const changed = next !== String(existing ?? "");
  if (changed) await writeProjectFile(root, targetRel, next);
  return { changed };
}

function insertIntoCurrentTruth(existing, entry, {
  targetRel = "",
  kind = "",
  timestamp = new Date().toISOString(),
  sourceRef = "",
  promotionHash = "",
} = {}) {
  const text = stampPromotedMemoryFrontmatter(
    ensureMemoryPageShape(String(existing ?? ""), { targetRel, kind, timestamp }),
    timestamp,
  );
  if (promotionHash && text.includes(promotionHash)) return text;
  const marker = "\n## Current truth";
  const markerIndex = text.indexOf(marker);
  const timelineEntry = promotionTimelineEntry({ kind, timestamp, sourceRef, promotionHash });
  if (markerIndex === -1) return insertPromotionTimeline(`${text.trimEnd()}\n\n${entry}`, timelineEntry);

  const headingEnd = text.indexOf("\n", markerIndex + 1);
  const afterHeading = headingEnd === -1 ? text.length : headingEnd + 1;
  const before = `${text.slice(0, afterHeading).trimEnd()}\n\n`;
  let after = text.slice(afterHeading).replace(/^\s+/, "");
  after = after.replace(/^No .*(?:recorded yet|have been recorded yet)\.\r?\n\r?\n?/i, "");
  return insertPromotionTimeline(`${before}${entry}\n${after}`, timelineEntry);
}

function ensureMemoryPageShape(existing, { targetRel = "", kind = "", timestamp = new Date().toISOString() } = {}) {
  const text = String(existing ?? "");
  if (text.trimStart().startsWith("---")) return text;
  const type = memoryTypeForTarget(targetRel, kind);
  const title = memoryTitleForType(type);
  const header = [
    "---",
    `type: ${type}`,
    `owner: ${MEMORY_TYPE_OWNER.get(type) ?? "engineering"}`,
    `status: ${["business-rule", "decision", "knowledge"].includes(type) ? "active" : "draft"}`,
    "last_reviewed: -",
    "---",
    "",
    `# ${title}`,
    "",
    "## Current truth",
    "",
  ].join("\n");
  if (!text.trim()) return header;
  return `${header}${text.trimStart()}`;
}

function stampPromotedMemoryFrontmatter(existing, timestamp) {
  const text = String(existing ?? "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return text;
  const updates = new Map([
    ["memory_promoted", "true"],
    ["memory_promoted_at", timestamp.slice(0, 10)],
  ]);
  const seen = new Set();
  const out = ["---"];
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field && updates.has(field[1])) {
      out.push(`${field[1]}: ${updates.get(field[1])}`);
      seen.add(field[1]);
      continue;
    }
    out.push(line);
  }
  for (const [key, value] of updates.entries()) {
    if (!seen.has(key)) out.push(`${key}: ${value}`);
  }
  out.push("---");
  return `${out.join("\n")}\n${text.slice(match[0].length)}`;
}

function promotionTimelineEntry({ kind, timestamp, sourceRef, promotionHash }) {
  return `- ${timestamp.slice(0, 10)}: Promoted ${slug(kind)} from ${sourceRef} via aipi_promote_memory (${promotionHash}).`;
}

function insertPromotionTimeline(text, timelineEntry) {
  if (!timelineEntry || text.includes(timelineEntry)) return text;
  const marker = "\n## Timeline";
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1) {
    return `${text.trimEnd()}\n\n## Timeline\n\n${timelineEntry}\n`;
  }
  const headingEnd = text.indexOf("\n", markerIndex + 1);
  const insertAt = headingEnd === -1 ? text.length : headingEnd + 1;
  return `${text.slice(0, insertAt).trimEnd()}\n\n${timelineEntry}\n${text.slice(insertAt).replace(/^\s+/, "")}`;
}

function memoryTypeForTarget(targetRel, kind) {
  const fromKind = slug(kind);
  if (MEMORY_PAGE_TYPES.has(fromKind)) return fromKind;
  if (fromKind === "business-rules") return "business-rule";
  if (fromKind === "decisions") return "decision";
  if (fromKind === "procedures") return "procedure";
  return PROJECT_MEMORY_FILE_TO_TYPE.get(path.basename(targetRel)) ?? "knowledge";
}

function memoryTitleForType(type) {
  return {
    "business-rule": "Business Rules",
    decision: "Decisions",
    deployment: "Deployment",
    environment: "Environment",
    glossary: "Glossary",
    knowledge: "Knowledge",
    procedure: "Procedures",
    project: "Project Context",
  }[type] ?? "Knowledge";
}

function extractBusinessRuleId(content) {
  return String(content ?? "").match(/\bBR-[A-Za-z0-9_-]+\b/)?.[0]?.toUpperCase() ?? null;
}

function generatedBusinessRuleId(timestamp) {
  return `BR-${timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function generatedDecisionId(timestamp) {
  return `ADR-${timestamp.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}`;
}

function firstContentLine(content) {
  return String(content ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean) ?? "";
}

function stripMarkdownHeading(content) {
  return String(content ?? "").replace(/^#{1,6}\s+.*\r?\n?/, "");
}

function extractField(content, field) {
  // Restrict the pre-value run to spaces/tabs and capture with `(.*)` (which never matches `\n`). With `\s*(.+)`
  // under the `m` flag, an EMPTY field value (`- **verify:** ` then a newline) let `\s*` swallow the line break
  // and `(.+)` capture the NEXT line — silently stealing the following field's text. `[ \t]*(.*)` keeps the
  // match on its own line, so a present-but-empty field returns "" instead of the next line.
  const pattern = new RegExp(`^- \\*\\*${escapeRegex(field)}:\\*\\*[ \\t]*(.*)$`, "im");
  return String(content ?? "").match(pattern)?.[1]?.trim() ?? null;
}

function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim() || "See source reference.";
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function writeProjectFile(root, relPath, content) {
  const abs = path.resolve(root, relPath);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error(`AIPI tool write escapes project root: ${relPath}`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function tokenize(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_/-]+/)
      .filter((token) => token.length >= 3),
  );
}

function scoreLine(line, terms) {
  const normalized = line.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += 1;
  }
  return score;
}

function excerptAround(lines, index, radius) {
  const start = Math.max(0, index - Math.floor(radius / 2));
  return lines.slice(start, start + radius).join("\n");
}

function slug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "memory";
}

function assertRoot(projectRoot) {
  if (!projectRoot) throw new Error("projectRoot is required");
  return path.resolve(projectRoot);
}

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export const __aipiTestInternals = Object.freeze({
  readReusableEmbeddingCache,
  runtimeToolProgress,
});

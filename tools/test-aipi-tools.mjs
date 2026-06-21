import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initProject } from "../extensions/aipi/runtime/project-init.js";
import {
  aipiCallers,
  aipiImpact,
  aipiKanbanUpdate,
  aipiMemoryQuery,
  aipiPromoteMemory,
  aipiRetrieve,
  aipiRuleGap,
  aipiRuleLookup,
  aipiSemanticSearch,
  checkSemanticEmbeddingReadiness,
  rebuildCodeGraph,
  registerAipiRuntimeTools,
  resolveEmbeddingDimensions,
  resolveSemanticEmbeddingConfig,
} from "../extensions/aipi/runtime/aipi-tools.js";
import {
  formatMemoryCommandResult,
  parseMemoryArgs,
  runMemoryCommand,
} from "../extensions/aipi/runtime/memory-command.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-tools-"));
const sourceRoot = path.resolve("templates/.aipi");
const embeddingCalls = [];
const semanticOptions = {
  env: { AIPI_OLLAMA_HOST: "http://ollama.test:11434" },
  embeddingFetch: fakeEmbeddingFetch(embeddingCalls),
};

try {
  await initProject({ sourceRoot, targetRoot: tempRoot });
  assert.equal(resolveEmbeddingDimensions({ model: "nomic-embed-text" }), 1024);
  assert.equal(resolveEmbeddingDimensions({ model: "bge-m3" }), 1024);
  const envPinnedConfig = await resolveSemanticEmbeddingConfig({
    root: tempRoot,
    env: { AIPI_OLLAMA_MODEL: "nomic-embed-text", AIPI_OLLAMA_DIMENSIONS: "768" },
  });
  assert.equal(envPinnedConfig.model, "bge-m3");
  assert.equal(envPinnedConfig.dimensions, 1024);
  const missingLegacyReadiness = await checkSemanticEmbeddingReadiness({
    config: { host: "http://ollama.test:11434", model: "nomic-embed-text", dimensions: 768 },
    fetchFn: fakeMissingTagsFetch(),
  });
  assert.equal(missingLegacyReadiness.status, "model_missing");
  assert.equal(missingLegacyReadiness.model, "bge-m3");
  assert.equal(missingLegacyReadiness.dimensions, 1024);
  assert.equal(missingLegacyReadiness.action, "ollama pull bge-m3");
  assert.match(missingLegacyReadiness.message, /model bge-m3 is not pulled/);
  assert.match(missingLegacyReadiness.message, /ollama pull bge-m3/);
  assert.match(missingLegacyReadiness.message, /1024-dim bge-m3/);
  assert.match(missingLegacyReadiness.message, /AIPI_OLLAMA_HOST/);
  assert.doesNotMatch(missingLegacyReadiness.message, /nomic-embed-text|768-dim/);
  assert.doesNotMatch(missingLegacyReadiness.message, /AIPI_OLLAMA_MODEL|AIPI_OLLAMA_DIMENSIONS/);

  const pristineGraph = await rebuildCodeGraph({
    projectRoot: tempRoot,
    now: () => new Date("2026-06-15T23:00:00.000Z"),
    ...semanticOptions,
  });
  assert.equal(pristineGraph.relationships.some((edge) => String(edge.source_ref).includes("business-rules.md#BR-001")), false);
  assert.equal(pristineGraph.relationships.some((edge) => String(edge.source_ref).includes("decisions.md#ADR-001")), false);
  assert.deepEqual(
    pristineGraph.files.find((file) => file.path.endsWith("business-rules.md"))?.memory_metadata,
    { type: "business-rule", owner: "product", status: "active", last_reviewed: "-" },
  );
  assert.deepEqual(
    pristineGraph.files.find((file) => file.path.endsWith("deployment.md"))?.memory_metadata,
    { type: "deployment", owner: "devops", status: "draft", last_reviewed: "-" },
  );

  await fs.appendFile(
    path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"),
    [
      "",
      "### BR-001 - Renewal price",
      "- **domain:** software",
      "- **statement:** Subscriptions renew at the current accepted price.",
      "- **scenarios:**",
      "  - Given a subscription, When it renews, Then the accepted price is preserved.",
      "- **status:** accepted",
      "- **links:** implements:[src/billing.js], relates:[BR-003], decided-by:[ADR-001]",
      "",
      "### BR-002 - Renewal discount override",
      "- **domain:** software",
      "- **statement:** Subscriptions always renew with a new discount price.",
      "- **status:** proposed",
      "- **conflicts:** BR-001",
      "",
      "### BR-003 - Assinatura recorrente",
      "- **domain:** software",
      "- **statement:** Assinaturas renovadas preservam o preco aceito na cobranca.",
      "- **status:** accepted",
      "",
      "### BR-004 - Renewal recalculation",
      "- **domain:** software",
      "- **statement:** Subscriptions renew with a new recalculated price on every renewal.",
      "- **status:** proposed",
      "",
      "### BR-005 - Refund window",
      "- **domain:** commerce",
      "- **statement:** Refund requests are accepted for 7 days after purchase.",
      "- **status:** accepted",
      "",
      "### BR-006 - Refund window extension",
      "- **domain:** commerce",
      "- **statement:** Refund requests are accepted for 30 days after purchase.",
      "- **status:** proposed",
      "",
      "### BR-007 - Enterprise invoice receipt",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoices must include tax receipt metadata for purchases.",
      "- **status:** accepted",
      "",
      "### BR-008 - Enterprise invoice receipt exception",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoices may omit tax receipt metadata for purchases.",
      "- **status:** proposed",
      "",
      "### BR-009 - Fraud approval before capture",
      "- **domain:** commerce",
      "- **statement:** Enterprise payments must capture funds after fraud approval.",
      "- **status:** accepted",
      "",
      "### BR-010 - Fraud approval late review",
      "- **domain:** commerce",
      "- **statement:** Enterprise payments must capture funds before fraud approval.",
      "- **status:** proposed",
      "",
      "### BR-011 - Low-risk refund automation",
      "- **domain:** commerce",
      "- **statement:** Low-risk refund approvals are automatic for enterprise purchases.",
      "- **status:** accepted",
      "",
      "### BR-012 - Low-risk refund manual review",
      "- **domain:** commerce",
      "- **statement:** Low-risk refund approvals require manual review for enterprise purchases.",
      "- **status:** proposed",
      "",
      "### BR-013 - Enterprise invoice late fee",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoice late payment fee is R$ 10.",
      "- **status:** accepted",
      "",
      "### BR-014 - Enterprise invoice late fee increase",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoice late payment fee is R$ 15.",
      "- **status:** proposed",
      "",
      "### BR-015 - Password reset attempt floor",
      "- **domain:** security",
      "- **statement:** Password reset code allows at least 3 attempts.",
      "- **status:** accepted",
      "",
      "### BR-016 - Password reset attempt ceiling",
      "- **domain:** security",
      "- **statement:** Password reset code allows at most 3 attempts.",
      "- **status:** proposed",
      "",
      "### BR-017 - Enterprise invoice deadline",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoice payment deadline expires on 2026-06-30.",
      "- **status:** accepted",
      "",
      "### BR-018 - Enterprise invoice deadline extension",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoice payment deadline expires on 2026-07-31.",
      "- **status:** proposed",
      "",
      "### BR-019 - Support escalation cutoff",
      "- **domain:** support",
      "- **statement:** Enterprise support ticket escalation cutoff is 17:00 local time.",
      "- **status:** accepted",
      "",
      "### BR-020 - Support escalation cutoff extension",
      "- **domain:** support",
      "- **statement:** Enterprise support ticket escalation cutoff is 18:00 local time.",
      "- **status:** proposed",
      "",
      "### BR-021 - Enterprise invoice paid status",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoice status is paid after settlement.",
      "- **status:** accepted",
      "",
      "### BR-022 - Enterprise invoice pending status",
      "- **domain:** commerce",
      "- **statement:** Enterprise invoice status is pending after settlement.",
      "- **status:** proposed",
      "",
      "### BR-023 - Admin MFA enabled",
      "- **domain:** security",
      "- **statement:** Enterprise account MFA is enabled for admin login.",
      "- **status:** accepted",
      "",
      "### BR-024 - Admin MFA disabled",
      "- **domain:** security",
      "- **statement:** Enterprise account MFA is disabled for admin login.",
      "- **status:** proposed",
      "",
      "### BR-025 - Single active subscription",
      "- **domain:** software",
      "- **statement:** Customer account has exactly one active subscription.",
      "- **status:** accepted",
      "",
      "### BR-026 - Multiple active subscriptions",
      "- **domain:** software",
      "- **statement:** Customer account supports multiple active subscriptions.",
      "- **status:** proposed",
      "",
      "### BR-027 - Public finance report visibility",
      "- **domain:** commerce",
      "- **statement:** Enterprise report visibility is public after approval.",
      "- **status:** accepted",
      "",
      "### BR-028 - Private finance report visibility",
      "- **domain:** commerce",
      "- **statement:** Enterprise report visibility is private after approval.",
      "- **status:** proposed",
      "",
      "### BR-029 - Checkout payment provider",
      "- **domain:** commerce",
      "- **statement:** Enterprise payment provider is stripe for checkout.",
      "- **status:** accepted",
      "",
      "### BR-030 - Checkout payment provider migration",
      "- **domain:** commerce",
      "- **statement:** Enterprise payment provider is adyen for checkout.",
      "- **status:** proposed",
      "",
      "### BR-031 - Bulk export retry minimum",
      "- **domain:** limits",
      "- **statement:** Bulk export queue keeps at least 3 retry attempts.",
      "- **status:** accepted",
      "",
      "### BR-032 - Bulk export retry maximum",
      "- **domain:** limits",
      "- **statement:** Bulk export queue keeps at most 5 retry attempts.",
      "- **status:** proposed",
      "",
      "### BR-033 - Notification retry minimum",
      "- **domain:** limits",
      "- **statement:** Notification queue keeps at least 3 retry attempts.",
      "- **status:** accepted",
      "",
      "### BR-034 - Notification retry raised minimum",
      "- **domain:** limits",
      "- **statement:** Notification queue keeps at least 5 retry attempts.",
      "- **status:** proposed",
      "",
    ].join("\n"),
  );
  await fs.appendFile(
    path.join(tempRoot, ".aipi", "memory", "project", "decisions.md"),
    [
      "",
      "### ADR-001 - Renewal implementation route",
      "- **status:** accepted",
      "- **context:** Billing renewal implementation.",
      "- **decision:** Keep renewal behavior in src/billing.js and tests/billing.test.js.",
      "- **consequences:** Rule traceability stays explicit.",
      "- **links:** rules:[BR-001] · code:[src/billing.js] · tests:[tests/billing.test.js]",
      "- **date:** 2026-06-16",
      "",
    ].join("\n"),
  );
  await fs.appendFile(
    path.join(tempRoot, ".aipi", "memory", "project", "deployment.md"),
    "\n## Billing deploy surface\n\nBilling deployment verifies src/billing.js before production.\n",
  );
  await fs.mkdir(path.join(tempRoot, "src"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "__generated__"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "src", "migrations"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, "tests"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, ".aipi", "runtime", "runs", "run-1", "steps", "final_verification"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, ".aipi", "runtime", "runs", "run-2", "steps", "adversarial_review"), { recursive: true });
  await fs.mkdir(path.join(tempRoot, ".aipi", "runtime", "runs", "run-3", "steps", "rule_gap"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "src", "billing.js"),
    "export function renewSubscription(account) {\n  const sharedRenewalNeedle = 'enterprise renewal vector';\n  const sharedRenewalNeedle = 'enterprise renewal vector';\n  return account.price;\n}\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "billing-copy.js"),
    "export function renewSubscription(account) {\n  const sharedRenewalNeedle = 'enterprise renewal vector';\n  const sharedRenewalNeedle = 'enterprise renewal vector';\n  return account.price;\n}\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "tests", "billing.test.js"),
    "import { renewSubscription } from '../src/billing.js';\nrenewSubscription({ price: 10 });\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "static-palette.js"),
    "export default {\n  alpha: 'cyan',\n  beta: 'magenta'\n};\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "live-hook.js"),
    "export default (account) => account.price;\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "tests", "live-hook.test.js"),
    "import liveHook from '../src/live-hook.js';\nliveHook({ price: 10 });\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "billing.css"),
    ".renewal-banner {\n  color: #224466;\n}\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "report.html"),
    "<section data-report=\"renewal\">\n  <h1>Renewal report</h1>\n</section>\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "generated-client.generated.js"),
    "export function generatedClient() {\n  return 'generated renewal client';\n}\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "__generated__", "api-client.js"),
    "export function generatedApiClient() {\n  return 'generated api renewal client';\n}\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "migrations", "001_create_billing.js"),
    "export function up() {\n  return 'create billing renewal table';\n}\n",
  );
  await fs.writeFile(
    path.join(tempRoot, "src", "generated-marker.js"),
    "// @generated by fixture\nexport function markedGeneratedClient() {\n  return 'marked generated renewal client';\n}\n",
  );
  await fs.writeFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", "run-1", "BDD-CONTRACT.md"),
    "# Renewal BDD\n\nGiven a subscription, When it renews, Then the accepted price is preserved by billing.\n",
  );
  await fs.writeFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", "run-1", "steps", "final_verification", "VERIFICATION.md"),
    "VERDICT: PASS\n\nVerified BR-001 renewal price through src/billing.js and tests/billing.test.js.\n",
  );
  await fs.writeFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", "run-2", "steps", "adversarial_review", "RESULT.json"),
    `${JSON.stringify({
      schema: "aipi.step-result.v1",
      verdict: "FAIL",
      summary: "BR-002 conflicts with BR-001 in src/billing.js because renewal discount replacement breaks accepted price preservation.",
      artifacts: ["src/billing.js"],
    })}\n`,
  );
  await fs.writeFile(
    path.join(tempRoot, ".aipi", "runtime", "runs", "run-3", "steps", "rule_gap", "BLOCKED.md"),
    "VERDICT: BLOCKED\n\nBlocked on BR-004 until business confirms whether renewal price recalculation replaces BR-001. See src/billing.js.\n",
  );
  for (const rel of [
    "node_modules/skip.js",
    ".expo/skip.js",
    ".venv/skip.py",
    "venv/skip.py",
    "__pycache__/skip.py",
    ".turbo/skip.js",
    ".gradle/skip.gradle",
    "ios/Pods/skip.m",
    "android/build/skip.gradle",
    ".aipi/runtime/skip.js",
    ".aipi/state/skip.js",
  ]) {
    await fs.mkdir(path.dirname(path.join(tempRoot, rel)), { recursive: true });
    await fs.writeFile(path.join(tempRoot, rel), "export const skipped = true;\n");
  }

  const memory = await aipiMemoryQuery({
    projectRoot: tempRoot,
    query: "renew current price",
  });
  assert.equal(memory.tool, "aipi_memory_query");
  assert.equal(memory.refs.some((ref) => ref.path.endsWith("business-rules.md")), true);
  const filteredMemory = await aipiMemoryQuery({
    projectRoot: tempRoot,
    query: "accepted business rules",
    type: "business-rule",
    owner: "product",
    status: "active",
  });
  assert.equal(filteredMemory.filters.type, "business-rule");
  assert.equal(filteredMemory.refs.length > 0, true);
  assert.equal(filteredMemory.refs.every((ref) => ref.metadata.type === "business-rule"), true);
  assert.equal(filteredMemory.refs.every((ref) => ref.metadata.owner === "product"), true);
  const staleMemory = await aipiMemoryQuery({
    projectRoot: tempRoot,
    query: "Current truth",
    stale_before: "2026-01-01",
  });
  assert.equal(staleMemory.refs.some((ref) => ref.metadata.last_reviewed === "-"), true);

  assert.deepEqual(parseMemoryArgs("query renewal price --layer all --limit 2"), {
    action: "query",
    layer: "all",
    limit: 2,
    query: "renewal price",
  });
  assert.deepEqual(parseMemoryArgs("query rules --type business-rule --owner product --status active --stale-before 2026-01-01"), {
    action: "query",
    layer: "project",
    limit: 8,
    query: "rules",
    type: "business-rule",
    owner: "product",
    status: "active",
    stale_before: "2026-01-01",
  });
  const memoryStatus = await runMemoryCommand({ projectRoot: tempRoot, args: "status" });
  assert.equal(memoryStatus.action, "status");
  assert.equal(memoryStatus.layers.project.status, "available");
  assert.equal(memoryStatus.layers.project.files > 0, true);
  assert.equal(memoryStatus.code_graph.status, "available");
  assert.match(formatMemoryCommandResult(memoryStatus), /project=available/);
  const memoryRefs = await runMemoryCommand({ projectRoot: tempRoot, args: "refs --layer project" });
  assert.equal(memoryRefs.refs.some((ref) => ref.path.endsWith("business-rules.md")), true);
  const memoryCommandQuery = await runMemoryCommand({ projectRoot: tempRoot, args: "query renew price --limit 3" });
  assert.equal(memoryCommandQuery.action, "query");
  assert.equal(memoryCommandQuery.refs.some((ref) => ref.path.endsWith("business-rules.md")), true);

  const rule = await aipiRuleLookup({
    projectRoot: tempRoot,
    query: "current accepted price",
  });
  assert.equal(rule.refs.length > 0, true);

  const covered = await aipiRuleGap({
    projectRoot: tempRoot,
    query: "renew current accepted price",
  });
  assert.equal(covered.classification, "COVERED");
  const gap = await aipiRuleGap({ projectRoot: tempRoot, query: "loyalty points expiration" });
  assert.equal(gap.classification, "GAP");
  const mechanics = await aipiRuleGap({ projectRoot: tempRoot, query: "mechanical format change" });
  assert.equal(mechanics.classification, "MECHANICS");

  const vectorProgressEvents = [];
  const graph = await rebuildCodeGraph({
    projectRoot: tempRoot,
    now: () => new Date("2026-06-16T00:00:00.000Z"),
    onProgress: (event) => vectorProgressEvents.push(event),
    ...semanticOptions,
  });
  assert.equal(graph.schema, "aipi.code-graph.v1");
  assert.match(graph.source, /^sqlite\+(.+\+)?lexical$/);
  assert.equal(graph.stale, false);
  assert.equal(graph.freshness.status, "fresh");
  assert.equal(graph.files.every((file) => typeof file.hash === "string" && file.hash.length === 64), true);
  assert.equal(graph.sqlite.path, ".aipi/state/aipi-graph.sqlite");
  if (graph.sqlite.status === "available") {
    assert.equal(await pathExists(path.join(tempRoot, graph.sqlite.path)), true);
    const sqlite = await import("node:sqlite").catch(() => null);
    if (sqlite) {
      const db = new sqlite.DatabaseSync(path.join(tempRoot, graph.sqlite.path), { readOnly: true, allowExtension: true });
      try {
        const sqliteVec = await import("sqlite-vec").catch(() => null);
        if (sqliteVec) {
          db.enableLoadExtension?.(true);
          sqliteVec.load(db);
          db.enableLoadExtension?.(false);
        }
        const vectorTable = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'code_vectors'").get()?.sql ?? "";
        if (graph.vector.status === "available") {
          assert.match(vectorTable, /float\[1024\]/);
          const cacheRows = db.prepare(`
            SELECT item_key, typeof(embedding) AS storage_type, length(embedding) AS bytes
            FROM embedding_cache
          `).all();
          const vectorRowCount = db.prepare("SELECT COUNT(*) AS count FROM code_vectors").get()?.count ?? 0;
          const vectorMapCount = db.prepare("SELECT COUNT(*) AS count FROM vector_items").get()?.count ?? 0;
          const vectorChunkCount = db.prepare("SELECT COUNT(*) AS count FROM vector_chunks").get()?.count ?? 0;
          const codeLineCount = db.prepare("SELECT COUNT(*) AS count FROM code_lines").get()?.count ?? 0;
          assert.equal(cacheRows.length, vectorRowCount);
          assert.equal(cacheRows.every((row) => String(row.item_key).startsWith("sha256:")), true);
          assert.equal(cacheRows.every((row) => row.storage_type === "blob"), true);
          assert.equal(cacheRows.every((row) => row.bytes === 1024 * 4), true);
          assert.equal(vectorRowCount, graph.vector.unique_item_count);
          assert.equal(vectorChunkCount, graph.vector.item_count);
          assert.equal(vectorMapCount, graph.vector.line_mapping_count);
          assert.equal(vectorChunkCount < codeLineCount, true);
          assert.equal(vectorMapCount > vectorChunkCount, true);
          const renewalChunk = db.prepare(`
            SELECT start_line, end_line, text, chunk_kind, symbol_name
            FROM vector_chunks
            WHERE path = ? AND chunk_kind = 'symbol' AND symbol_name = 'renewSubscription'
            ORDER BY start_line ASC
            LIMIT 1
          `).get("src/billing.js");
          assert.equal(renewalChunk.start_line, 1);
          assert.equal(renewalChunk.end_line >= 5, true);
          assert.match(renewalChunk.text, /enterprise renewal vector/);
          const vectorChunkCountForPath = (relPath) =>
            db.prepare("SELECT COUNT(*) AS count FROM vector_chunks WHERE path = ?").get(relPath)?.count ?? 0;
          const codeLineCountForPath = (relPath) =>
            db.prepare("SELECT COUNT(*) AS count FROM code_lines WHERE path = ?").get(relPath)?.count ?? 0;
          const lowSignalVectorExcludedPaths = [
            "tests/billing.test.js",
            "tests/live-hook.test.js",
            "src/billing.css",
            "src/report.html",
            "src/generated-client.generated.js",
            "src/__generated__/api-client.js",
            "src/migrations/001_create_billing.js",
            "src/generated-marker.js",
          ];
          const vectorPaths = db.prepare(`
            SELECT path, COUNT(*) AS count
            FROM vector_chunks
            GROUP BY path
            ORDER BY path ASC
          `).all();
          const vectorPathSet = new Set(vectorPaths.map((row) => row.path));
          assert.equal(vectorChunkCountForPath("src/billing.js") > 0, true);
          for (const relPath of lowSignalVectorExcludedPaths) {
            assert.equal(codeLineCountForPath(relPath) > 0, true, `${relPath} remains lexically indexed`);
            assert.equal(vectorChunkCountForPath(relPath), 0, `${relPath} must not produce vector chunks`);
          }
          assert.equal(vectorPaths.every((row) => !lowSignalVectorExcludedPaths.includes(row.path)), true);
          const preP1VectorCandidatePaths = [
            "src/billing.js",
            "src/billing-copy.js",
            ...lowSignalVectorExcludedPaths,
          ];
          assert.equal(
            preP1VectorCandidatePaths.filter((relPath) => vectorPathSet.has(relPath)).length <
              preP1VectorCandidatePaths.filter((relPath) => codeLineCountForPath(relPath) > 0).length,
            true,
          );
          assert.equal(
            db.prepare(`
              SELECT COUNT(*) AS count
              FROM relationships
              WHERE relation = 'test_covers' AND source_ref = ? AND target_ref = ?
            `).get("tests/billing.test.js", "src/billing.js")?.count > 0,
            true,
          );
          assert.equal(graph.files.some((file) => file.path === "src/static-palette.js"), true);
          assert.equal(codeLineCountForPath("src/static-palette.js") > 0, true);
          assert.equal(vectorChunkCountForPath("src/static-palette.js"), 0);
          assert.equal(graph.symbols.some((symbol) => symbol.path === "src/static-palette.js"), false);
          assert.equal(
            graph.relationships.some(
              (edge) => edge.source_ref === "src/static-palette.js" || edge.target_ref === "src/static-palette.js",
            ),
            false,
          );
          assert.equal(graph.symbols.some((symbol) => symbol.path === "src/live-hook.js"), false);
          assert.equal(
            graph.relationships.some(
              (edge) =>
                edge.relation === "test_covers" &&
                edge.source_ref === "tests/live-hook.test.js" &&
                edge.target_ref === "src/live-hook.js",
            ),
            true,
          );
          assert.equal(vectorChunkCountForPath("src/live-hook.js") > 0, true);
          const p1AllowedVectorCandidatePaths = [
            "src/billing.js",
            "src/billing-copy.js",
            "src/static-palette.js",
            "src/live-hook.js",
          ];
          assert.equal(
            p1AllowedVectorCandidatePaths.filter((relPath) => vectorPathSet.has(relPath)).length <
              p1AllowedVectorCandidatePaths.filter((relPath) => codeLineCountForPath(relPath) > 0).length,
            true,
          );
          const duplicateChunkRows = db.prepare(`
            SELECT COUNT(*) AS chunk_count, COUNT(DISTINCT vector_rowid) AS vector_count
            FROM vector_chunks
            GROUP BY item_key
            HAVING chunk_count >= 2
            ORDER BY chunk_count DESC
            LIMIT 1
          `).get();
          assert.equal(duplicateChunkRows.chunk_count >= 2, true);
          assert.equal(duplicateChunkRows.vector_count, 1);
        }
      } finally {
        db.close();
      }
    }
  }
  assert.equal(graph.vector.engine, "sqlite-vec");
  assert.equal(graph.vector.dimensions, 1024);
  assert.equal(graph.vector.embedding_model, "bge-m3");
  const semanticVectorProgress = vectorProgressEvents.filter((event) => event.phase === "semantic-vectors");
  if (graph.vector.status === "available") {
    assert.equal(semanticVectorProgress.length > 1, true);
    assert.match(semanticVectorProgress[0].message, /building semantic vectors for \d+ files/);
    assert.equal(semanticVectorProgress[0].files_embedded, 0);
    assert.equal(
      semanticVectorProgress.length <= graph.files.length + 2,
      true,
      "semantic vector progress must be per-file bounded, not per-line",
    );
    assert.equal(semanticVectorProgress.some((event) => event.files_embedded > 0), true);
    const finalVectorProgress = semanticVectorProgress[semanticVectorProgress.length - 1];
    assert.equal(finalVectorProgress.status, "done");
    assert.match(finalVectorProgress.message, /semantic vectors built \(\d+ chunks\)/);
    assert.equal(finalVectorProgress.line_count, graph.vector.item_count);
  }
  assert.equal(graph.files.some((file) => /(^|\/)(node_modules|\.expo|\.venv|venv|__pycache__|\.turbo|\.gradle)\//.test(file.path)), false);
  assert.equal(graph.files.some((file) => file.path.startsWith("ios/Pods/") || file.path.startsWith("android/build/")), false);
  assert.equal(graph.files.some((file) => file.path.startsWith(".aipi/runtime/") || file.path.startsWith(".aipi/state/")), false);
  assert.equal(graph.symbols.some((symbol) => symbol.name === "renewSubscription"), true);
  assert.equal(graph.symbols.find((symbol) => symbol.name === "renewSubscription").line, 1);
  assert.equal(graph.relationships.some((edge) => edge.relation === "test_covers"), true);
  assert.equal(graph.relationships.some((edge) => edge.relation === "defines" && edge.target_ref === "renewSubscription"), true);
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "business_rule_impacts_code" &&
        edge.source_ref.endsWith("business-rules.md#BR-001") &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "business_rule_implements_code" &&
        edge.source_ref.endsWith("business-rules.md#BR-001") &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "business_rule_relates_rule" &&
        edge.source_ref.endsWith("business-rules.md#BR-001") &&
        edge.target_ref.endsWith("business-rules.md#BR-003"),
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "business_rule_decided_by" &&
        edge.source_ref.endsWith("business-rules.md#BR-001") &&
        edge.target_ref.endsWith("decisions.md#ADR-001"),
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "decision_references_rule" &&
        edge.source_ref.endsWith("decisions.md#ADR-001") &&
        edge.target_ref.endsWith("business-rules.md#BR-001"),
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "decision_references_code" &&
        edge.source_ref.endsWith("decisions.md#ADR-001") &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "decision_references_test" &&
        edge.source_ref.endsWith("decisions.md#ADR-001") &&
        edge.target_ref === "tests/billing.test.js",
    ),
    true,
  );
  const portugueseRuleImpact = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_impacts_code" &&
      edge.source_ref.endsWith("business-rules.md#BR-003") &&
      edge.target_ref === "src/billing.js",
  );
  assert.ok(portugueseRuleImpact);
  assert.match(portugueseRuleImpact.evidence, /shared canonical domain terms/);
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "business_rule_conflicts" &&
        edge.source_ref.endsWith("business-rules.md#BR-002") &&
        edge.target_ref.endsWith("business-rules.md#BR-001"),
    ),
    true,
  );
  const implicitRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-004") &&
      edge.target_ref.endsWith("business-rules.md#BR-001"),
  );
  assert.ok(implicitRuleConflict);
  assert.match(implicitRuleConflict.evidence, /implicit preserve-vs-replace conflict/);
  const numericRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-006") &&
      edge.target_ref.endsWith("business-rules.md#BR-005"),
  );
  assert.ok(numericRuleConflict);
  assert.match(numericRuleConflict.evidence, /implicit numeric mismatch conflict/);
  const modalityRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-008") &&
      edge.target_ref.endsWith("business-rules.md#BR-007"),
  );
  assert.ok(modalityRuleConflict);
  assert.match(modalityRuleConflict.evidence, /implicit required-vs-optional conflict/);
  const sequenceRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-010") &&
      edge.target_ref.endsWith("business-rules.md#BR-009"),
  );
  assert.ok(sequenceRuleConflict);
  assert.match(sequenceRuleConflict.evidence, /implicit sequence mismatch conflict/);
  const automationRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-012") &&
      edge.target_ref.endsWith("business-rules.md#BR-011"),
  );
  assert.ok(automationRuleConflict);
  assert.match(automationRuleConflict.evidence, /implicit automatic-vs-manual conflict/);
  const monetaryRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-014") &&
      edge.target_ref.endsWith("business-rules.md#BR-013"),
  );
  assert.ok(monetaryRuleConflict);
  assert.match(monetaryRuleConflict.evidence, /implicit monetary mismatch conflict/);
  const thresholdRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-016") &&
      edge.target_ref.endsWith("business-rules.md#BR-015"),
  );
  assert.ok(thresholdRuleConflict);
  assert.match(thresholdRuleConflict.evidence, /implicit threshold direction conflict/);
  const dateRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-018") &&
      edge.target_ref.endsWith("business-rules.md#BR-017"),
  );
  assert.ok(dateRuleConflict);
  assert.match(dateRuleConflict.evidence, /implicit date mismatch conflict/);
  const timeRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-020") &&
      edge.target_ref.endsWith("business-rules.md#BR-019"),
  );
  assert.ok(timeRuleConflict);
  assert.match(timeRuleConflict.evidence, /implicit time mismatch conflict/);
  const enumRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-022") &&
      edge.target_ref.endsWith("business-rules.md#BR-021"),
  );
  assert.ok(enumRuleConflict);
  assert.match(enumRuleConflict.evidence, /implicit enum value mismatch conflict/);
  const booleanStateRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-024") &&
      edge.target_ref.endsWith("business-rules.md#BR-023"),
  );
  assert.ok(booleanStateRuleConflict);
  assert.match(booleanStateRuleConflict.evidence, /implicit boolean state mismatch conflict/);
  const cardinalityRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-026") &&
      edge.target_ref.endsWith("business-rules.md#BR-025"),
  );
  assert.ok(cardinalityRuleConflict);
  assert.match(cardinalityRuleConflict.evidence, /implicit cardinality mismatch conflict/);
  const enumVisibilityRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-028") &&
      edge.target_ref.endsWith("business-rules.md#BR-027"),
  );
  assert.ok(enumVisibilityRuleConflict);
  assert.match(enumVisibilityRuleConflict.evidence, /implicit enum value mismatch conflict/);
  const enumProviderRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-030") &&
      edge.target_ref.endsWith("business-rules.md#BR-029"),
  );
  assert.ok(enumProviderRuleConflict);
  assert.match(enumProviderRuleConflict.evidence, /implicit enum value mismatch conflict/);
  const compatibleThresholdRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-032") &&
      edge.target_ref.endsWith("business-rules.md#BR-031"),
  );
  assert.equal(compatibleThresholdRuleConflict, undefined);
  const sameDirectionThresholdRuleConflict = graph.relationships.find(
    (edge) =>
      edge.relation === "business_rule_conflicts" &&
      edge.source_ref.endsWith("business-rules.md#BR-034") &&
      edge.target_ref.endsWith("business-rules.md#BR-033"),
  );
  assert.equal(sameDirectionThresholdRuleConflict, undefined);
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "bdd_contract_impacts_code" &&
        edge.source_ref.endsWith("BDD-CONTRACT.md") &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) => edge.relation === "deployment_impacts_code" && edge.target_ref === "src/billing.js",
    ),
    true,
  );
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "run_verifies_rule" &&
        edge.source_ref.endsWith("VERIFICATION.md") &&
        edge.target_ref.endsWith("business-rules.md#BR-001"),
    ),
    true,
  );
  const failedRuleEdge = graph.relationships.find(
    (edge) =>
      edge.relation === "run_fails_rule" &&
      edge.source_ref.endsWith("RESULT.json") &&
      edge.target_ref.endsWith("business-rules.md#BR-002"),
  );
  assert.ok(failedRuleEdge);
  assert.match(failedRuleEdge.evidence, /FAIL outcome/);
  const blockedRuleEdge = graph.relationships.find(
    (edge) =>
      edge.relation === "run_blocks_rule" &&
      edge.source_ref.endsWith("BLOCKED.md") &&
      edge.target_ref.endsWith("business-rules.md#BR-004"),
  );
  assert.ok(blockedRuleEdge);
  assert.equal(
    graph.relationships.some(
      (edge) =>
        edge.relation === "run_outcome_impacts_code" &&
        edge.source_ref.endsWith("RESULT.json") &&
        edge.target_ref === "src/billing.js" &&
        /FAIL outcome/.test(edge.evidence),
    ),
    true,
  );
  assert.equal(graph.run_outcomes.some((outcome) => outcome.run_id === "run-2" && outcome.verdict === "FAIL"), true);
  assert.equal(graph.run_outcomes.some((outcome) => outcome.step_id === "rule_gap" && outcome.verdict === "BLOCKED"), true);

  const graphPath = path.join(tempRoot, ".aipi", "state", "aipi-graph.json");
  const cacheReuseCallsBefore = embeddingCalls.length;
  const graphBeforeCacheReuse = JSON.parse(await fs.readFile(graphPath, "utf8"));
  const cacheReuseGraph = await rebuildCodeGraph({
    projectRoot: tempRoot,
    previousGraph: graphBeforeCacheReuse,
    now: () => new Date("2026-06-16T00:05:00.000Z"),
    ...semanticOptions,
  });
  if (cacheReuseGraph.vector.status === "available") {
    assert.equal(embeddingCalls.length, cacheReuseCallsBefore);
    assert.equal(cacheReuseGraph.vector.unique_item_count, graph.vector.unique_item_count);
  }

  const interruptedRoot = path.join(tempRoot, "interrupted-semantic-project");
  await fs.mkdir(path.join(interruptedRoot, "src"), { recursive: true });
  await initProject({ sourceRoot, targetRoot: interruptedRoot });
  for (let index = 0; index < 5; index += 1) {
    await fs.writeFile(
      path.join(interruptedRoot, "src", `chunk-${index}.js`),
      `export function interruptedChunk${index}() {\n  return 'interrupted-${index}';\n}\n`,
    );
  }
  const interruptedCalls = [];
  const interruptedFetch = fakeEmbeddingFetchThatFailsAfter(interruptedCalls, 2);
  const interruptedGraph = await rebuildCodeGraph({
    projectRoot: interruptedRoot,
    now: () => new Date("2026-06-16T00:10:00.000Z"),
    env: semanticOptions.env,
    embeddingFetch: interruptedFetch.fetch,
  });
  assert.equal(interruptedGraph.vector.status, "unavailable");
  assert.equal(interruptedFetch.successfulInputs.length, 2);
  const interruptedSqlitePath = path.join(interruptedRoot, ".aipi", "state", "aipi-graph.sqlite");
  const sqliteForInterrupted = await import("node:sqlite").catch(() => null);
  if (sqliteForInterrupted) {
    const db = new sqliteForInterrupted.DatabaseSync(interruptedSqlitePath, { readOnly: true });
    try {
      const cachedRows = db.prepare("SELECT COUNT(*) AS count FROM embedding_cache").get()?.count ?? 0;
      assert.equal(cachedRows >= 2, true);
    } finally {
      db.close();
    }
  }
  await fs.rm(path.join(interruptedRoot, ".aipi", "state", "aipi-graph.json"), { force: true });
  const resumedCalls = [];
  const resumedGraph = await rebuildCodeGraph({
    projectRoot: interruptedRoot,
    now: () => new Date("2026-06-16T00:15:00.000Z"),
    env: semanticOptions.env,
    embeddingFetch: fakeEmbeddingFetch(resumedCalls),
  });
  if (resumedGraph.vector.status === "available") {
    assert.equal(resumedCalls.length < resumedGraph.vector.unique_item_count, true);
    for (const input of interruptedFetch.successfulInputs) {
      assert.equal(resumedCalls.some((call) => call.input === input), false);
    }
  }

  const brokenSqliteRoot = path.join(tempRoot, "broken-sqlite-project");
  await fs.mkdir(path.join(brokenSqliteRoot, "src"), { recursive: true });
  await initProject({ sourceRoot, targetRoot: brokenSqliteRoot });
  await fs.writeFile(path.join(brokenSqliteRoot, "src", "healthy.js"), "export function healthyGraph() {\n  return true;\n}\n");
  const brokenStateDir = path.join(brokenSqliteRoot, ".aipi", "state");
  await fs.mkdir(brokenStateDir, { recursive: true });
  await fs.writeFile(path.join(brokenStateDir, "aipi-graph.sqlite"), "not a sqlite database");
  await fs.writeFile(path.join(brokenStateDir, "aipi-graph.sqlite-journal"), "hot journal");
  const recoveredGraph = await rebuildCodeGraph({
    projectRoot: brokenSqliteRoot,
    now: () => new Date("2026-06-16T00:20:00.000Z"),
    ...semanticOptions,
  });
  assert.equal(await pathExists(path.join(brokenStateDir, "aipi-graph.sqlite-journal")), false);
  assert.equal(recoveredGraph.sqlite.sqlite_recovery.status, "removed");

  const oldDimGraph = JSON.parse(await fs.readFile(graphPath, "utf8"));
  const legacyVectorDimensions = 1024 - 256;
  oldDimGraph.vector = { ...(oldDimGraph.vector ?? {}), dimensions: legacyVectorDimensions, embedding_model: "legacy-embed-text" };
  if (oldDimGraph.sqlite?.vector) {
    oldDimGraph.sqlite.vector = { ...oldDimGraph.sqlite.vector, dimensions: legacyVectorDimensions, embedding_model: "legacy-embed-text" };
  }
  await fs.writeFile(graphPath, `${JSON.stringify(oldDimGraph, null, 2)}\n`);
  const dimRebuilt = await aipiCallers({
    projectRoot: tempRoot,
    symbol: "renewSubscription",
    ...semanticOptions,
  });
  assert.match(dimRebuilt.graph.rebuilt_from_stale.reason, /embedding dimension mismatch/);
  assert.equal(dimRebuilt.graph.vector.dimensions, 1024);
  assert.equal(dimRebuilt.graph.vector.embedding_model, "bge-m3");

  const callers = await aipiCallers({
    projectRoot: tempRoot,
    symbol: "renewSubscription",
    ...semanticOptions,
  });
  assert.equal(callers.refs.some((ref) => ref.path === "src/billing.js"), true);
  if (graph.sqlite.status === "available") {
    assert.equal(callers.refs.some((ref) => ref.source === "sqlite"), true);
  }
  assert.equal(callers.graph.sqlite.path, ".aipi/state/aipi-graph.sqlite");
  assert.equal(callers.graph.vector.engine, "sqlite-vec");
  assert.equal(callers.graph.freshness.status, "fresh");

  const callsBeforeStaleRebuild = embeddingCalls.length;
  await fs.appendFile(
    path.join(tempRoot, "src", "billing.js"),
    "\nexport function staleFreshFunction() {\n  return 'fresh';\n}\n",
  );
  const staleVectorProgressEvents = [];
  const staleRebuilt = await aipiCallers({
    projectRoot: tempRoot,
    symbol: "staleFreshFunction",
    onProgress: (event) => staleVectorProgressEvents.push(event),
    ...semanticOptions,
  });
  assert.equal(staleRebuilt.graph.freshness.status, "fresh");
  assert.match(staleRebuilt.graph.rebuilt_from_stale.reason, /indexed file changed: src\/billing\.js/);
  assert.equal(staleRebuilt.refs.some((ref) => ref.path === "src/billing.js"), true);
  const staleEmbeddingInputs = embeddingCalls.slice(callsBeforeStaleRebuild).map((call) => call.input);
  assert.equal(staleEmbeddingInputs.some((input) => input.includes("staleFreshFunction")), true);
  assert.equal(staleEmbeddingInputs.some((input) => input.includes("renewSubscription({ price: 10 })")), false);
  const staleVectorProgress = staleVectorProgressEvents.filter((event) => event.phase === "semantic-vectors");
  if (staleRebuilt.graph.vector.status === "available") {
    assert.equal(staleVectorProgress.length > 1, true);
    assert.equal(staleVectorProgress.length <= staleVectorProgress[0].file_count + 2, true);
    assert.match(staleVectorProgress[staleVectorProgress.length - 1].message, /semantic vectors built/);
  }

  const semantic = await aipiCallers({
    projectRoot: tempRoot,
    symbol: "subscription renewal price",
    ...semanticOptions,
  });
  if (graph.vector.status === "available") {
    assert.equal(graph.source, "sqlite+sqlite-vec+lexical");
    assert.equal(graph.vector.item_count > 0, true);
    assert.equal(semantic.refs.some((ref) => ref.source === "sqlite-vec"), true);
  }

  const impact = await aipiImpact({
    projectRoot: tempRoot,
    path: "src/billing.js",
    ...semanticOptions,
  });
  assert.equal(impact.related_tests.includes("tests/billing.test.js"), true);
  assert.equal(impact.graph.relationship_count > 0, true);
  assert.equal(
    impact.relationships.some(
      (edge) =>
        edge.relation === "test_covers" &&
        edge.source_ref === "tests/billing.test.js" &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );
  assert.equal(
    impact.relationships.some((edge) => edge.relation === "business_rule_impacts_code"),
    true,
  );
  const ruleImpact = await aipiImpact({
    projectRoot: tempRoot,
    query: "BR-001",
    ...semanticOptions,
  });
  assert.equal(ruleImpact.relationships.some((edge) => edge.relation === "run_verifies_rule"), true);
  const failedImpact = await aipiImpact({
    projectRoot: tempRoot,
    query: "BR-002",
    ...semanticOptions,
  });
  assert.equal(failedImpact.graph.run_outcome_count >= 2, true);
  assert.equal(failedImpact.relationships.some((edge) => edge.relation === "run_fails_rule"), true);

  const semanticRuleBaseline = await aipiSemanticSearch({
    projectRoot: tempRoot,
    query: ".aipi/memory/project/business-rules.md#BR-001",
    limit: 1,
    ...semanticOptions,
  });
  const hybridRuleRetrieval = await aipiRetrieve({
    projectRoot: tempRoot,
    query: ".aipi/memory/project/business-rules.md#BR-001",
    limit: 5,
    ...semanticOptions,
  });
  const hybridBillingIndex = hybridRuleRetrieval.refs.findIndex((ref) => ref.path === "src/billing.js");
  assert.equal(hybridBillingIndex >= 0, true);
  assert.equal(hybridBillingIndex < 3, true);
  const hybridBillingRef = hybridRuleRetrieval.refs[hybridBillingIndex];
  assert.equal(hybridBillingRef.source, "hybrid");
  assert.equal(hybridBillingRef.provenance.method, "reciprocal_rank_fusion");
  assert.equal(hybridBillingRef.provenance.signals.some((signal) => signal.name === "graph"), true);
  assert.equal(hybridBillingRef.provenance.signals.some((signal) => signal.name === "rules"), true);
  assert.equal(
    hybridBillingRef.governing_rules.some((edge) => edge.relation === "business_rule_impacts_code"),
    true,
  );
  assert.equal(
    hybridRuleRetrieval.relationships.some(
      (edge) =>
        edge.relation === "business_rule_impacts_code" &&
        edge.source_ref.endsWith("business-rules.md#BR-001") &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );
  assert.equal(hybridRuleRetrieval.fusion.method, "reciprocal_rank_fusion");
  if (graph.vector.status === "available") {
    assert.equal(semanticRuleBaseline.refs.some((ref) => ref.path === "tests/billing.test.js"), false);
    assert.equal(
      hybridBillingRef.score > Math.max(...hybridRuleRetrieval.refs
        .filter((ref) => ref.path.endsWith("business-rules.md"))
        .map((ref) => ref.score), 0),
      true,
    );
  }

  const semanticOnly = await aipiSemanticSearch({
    projectRoot: tempRoot,
    query: "subscription renewal price",
    ...semanticOptions,
  });
  if (graph.vector.status === "available") {
    assert.equal(semanticOnly.refs.some((ref) => ref.source === "sqlite-vec"), true);
    assert.equal(semanticOnly.refs.some((ref) => ref.path === "src/billing.js"), true);
    assert.equal(semanticOnly.refs.some((ref) => ref.path === "tests/billing.test.js"), false);
  }
  const hybridConceptRetrieval = await aipiRetrieve({
    projectRoot: tempRoot,
    query: "subscription renewal price",
    limit: 5,
    ...semanticOptions,
  });
  const hybridConceptBillingIndex = hybridConceptRetrieval.refs.findIndex((ref) => ref.path === "src/billing.js");
  const hybridConceptTestIndex = hybridConceptRetrieval.refs.findIndex((ref) => ref.path === "tests/billing.test.js");
  assert.equal(hybridConceptBillingIndex >= 0, true);
  assert.equal(hybridConceptTestIndex === -1 || hybridConceptBillingIndex < hybridConceptTestIndex, true);
  const semanticExact = await aipiSemanticSearch({
    projectRoot: tempRoot,
    query: "export function renewSubscription(account) {\n  const sharedRenewalNeedle = 'enterprise renewal vector';\n  const sharedRenewalNeedle = 'enterprise renewal vector';\n  return account.price;\n}",
    ...semanticOptions,
  });
  if (graph.vector.status === "available") {
    assert.equal(
      semanticExact.refs.some(
        (ref) =>
          ref.path === "src/billing.js" &&
          ref.span?.start_line === 1 &&
          ref.end_line >= 5 &&
          /enterprise renewal vector/.test(ref.excerpt),
      ),
      true,
    );
  }
  await assert.rejects(
    () =>
      aipiSemanticSearch({
        projectRoot: tempRoot,
        query: "subscription renewal price",
        rebuild: true,
        env: semanticOptions.env,
        embeddingFetch: async () => {
          throw new Error("ollama down");
        },
      }),
    /bge-m3|semantic memory is OFF|AIPI semantic search requires Ollama/,
  );
  const lexicalProgressEvents = [];
  const lexicalFallback = await aipiImpact({
    projectRoot: tempRoot,
    query: "renewSubscription",
    rebuild: true,
    env: semanticOptions.env,
    onProgress: (event) => lexicalProgressEvents.push(event),
    embeddingFetch: async () => {
      throw new Error("ollama down");
    },
  });
  assert.equal(lexicalFallback.refs.some((ref) => ref.path === "src/billing.js"), true);
  assert.equal(lexicalProgressEvents.some((event) => event.phase === "semantic-vectors"), false);

  const legacyRoot = path.join(tempRoot, "legacy-semantic-project");
  await fs.mkdir(path.join(legacyRoot, "src"), { recursive: true });
  await initProject({ sourceRoot, targetRoot: legacyRoot });
  await fs.writeFile(path.join(legacyRoot, "src", "legacy.js"), "export function legacySemanticProject() {\n  return true;\n}\n");
  await fs.writeFile(
    path.join(legacyRoot, ".aipi", "semantic-memory.json"),
    `${JSON.stringify({
      schema: "aipi.semantic-memory.v1",
      ollama_host: "http://localhost:11434",
      ollama_model: "nomic-embed-text",
      dimensions: 768,
      rule: "old default",
    }, null, 2)}\n`,
  );
  const legacyEmbeddingCalls = [];
  const legacyGraph = await rebuildCodeGraph({
    projectRoot: legacyRoot,
    now: () => new Date("2026-06-19T15:00:00.000Z"),
    env: {
      AIPI_OLLAMA_HOST: "http://ollama.test:11434",
      AIPI_OLLAMA_MODEL: "nomic-embed-text",
      AIPI_OLLAMA_DIMENSIONS: "768",
    },
    embeddingFetch: fakeEmbeddingFetch(legacyEmbeddingCalls),
  });
  const migratedSemanticConfigText = await fs.readFile(path.join(legacyRoot, ".aipi", "semantic-memory.json"), "utf8");
  const migratedSemanticConfig = JSON.parse(migratedSemanticConfigText);
  assert.equal(migratedSemanticConfig.ollama_model, "bge-m3");
  assert.equal(migratedSemanticConfig.dimensions, 1024);
  assert.doesNotMatch(migratedSemanticConfigText, /nomic-embed-text|768/);
  assert.equal(legacyGraph.vector.dimensions, 1024);
  assert.equal(legacyGraph.vector.embedding_model, "bge-m3");
  assert.equal(legacyGraph.vector.config_migration?.from_model, "nomic-embed-text");
  if (legacyGraph.vector.status === "available") {
    const sqlite = await import("node:sqlite").catch(() => null);
    if (sqlite) {
      const db = new sqlite.DatabaseSync(path.join(legacyRoot, ".aipi", "state", "aipi-graph.sqlite"), { readOnly: true });
      const vectorTable = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'code_vectors'").get()?.sql ?? "";
      db.close();
      assert.match(vectorTable, /float\[1024\]/);
    }
  }

  const vectorlessRoot = path.join(tempRoot, "vectorless-semantic-project");
  const vectorlessEnv = {
    AIPI_OLLAMA_HOST: "http://ollama.test:11434",
    AIPI_OLLAMA_MODEL: "nomic-embed-text",
    AIPI_OLLAMA_DIMENSIONS: "768",
  };
  await fs.mkdir(path.join(vectorlessRoot, "src"), { recursive: true });
  await initProject({ sourceRoot, targetRoot: vectorlessRoot });
  await fs.writeFile(path.join(vectorlessRoot, "src", "vectorless.js"), "export function vectorlessLookup() {\n  return 'ok';\n}\n");
  await fs.mkdir(path.join(vectorlessRoot, ".aipi", "state", "aipi-graph.sqlite"), { recursive: true });
  const vectorlessGraph = await rebuildCodeGraph({
    projectRoot: vectorlessRoot,
    now: () => new Date("2026-06-19T16:00:00.000Z"),
    env: vectorlessEnv,
    embeddingFetch: fakeAvailableTagsFetch("bge-m3"),
  });
  assert.equal(vectorlessGraph.sqlite.status, "unavailable");
  assert.equal(vectorlessGraph.vector.dimensions, 1024);
  assert.equal(vectorlessGraph.vector.embedding_model, "bge-m3");
  assert.equal(vectorlessGraph.freshness.status, "fresh");
  const vectorlessCallers = await aipiCallers({
    projectRoot: vectorlessRoot,
    symbol: "vectorlessLookup",
    env: vectorlessEnv,
    embeddingFetch: fakeAvailableTagsFetch("bge-m3"),
  });
  assert.equal(vectorlessCallers.graph.freshness.status, "fresh");
  assert.doesNotMatch(vectorlessCallers.graph.freshness.reason ?? "", /embedding dimension mismatch/);

  const currentReadRoot = path.join(tempRoot, "current-readonly-project");
  await fs.mkdir(path.join(currentReadRoot, "src"), { recursive: true });
  await initProject({ sourceRoot, targetRoot: currentReadRoot });
  await fs.writeFile(path.join(currentReadRoot, "src", "readonly.js"), "export function currentReadOnlyLookup() {\n  return 'ok';\n}\n");
  await rebuildCodeGraph({
    projectRoot: currentReadRoot,
    now: () => new Date("2026-06-19T17:00:00.000Z"),
    env: { AIPI_OLLAMA_HOST: "http://ollama.test:11434" },
    embeddingFetch: fakeEmbeddingFetch([]),
  });
  const currentConfigPath = path.join(currentReadRoot, ".aipi", "semantic-memory.json");
  const currentGraphPath = path.join(currentReadRoot, ".aipi", "state", "aipi-graph.json");
  const currentConfigBefore = await fs.readFile(currentConfigPath, "utf8");
  const currentGraphBefore = await fs.readFile(currentGraphPath, "utf8");
  const currentReadOnlyCallers = await aipiCallers({
    projectRoot: currentReadRoot,
    symbol: "currentReadOnlyLookup",
    env: { AIPI_OLLAMA_HOST: "http://ollama.test:11434" },
    embeddingFetch: fakeEmbeddingFetch([]),
  });
  assert.equal(await fs.readFile(currentConfigPath, "utf8"), currentConfigBefore);
  assert.equal(await fs.readFile(currentGraphPath, "utf8"), currentGraphBefore);
  assert.equal(currentReadOnlyCallers.graph.freshness.status, "fresh");
  assert.equal(currentReadOnlyCallers.graph.rebuilt_from_stale ?? null, null);

  const legacyReadRoot = path.join(tempRoot, "legacy-read-migrates-project");
  await fs.mkdir(path.join(legacyReadRoot, "src"), { recursive: true });
  await initProject({ sourceRoot, targetRoot: legacyReadRoot });
  await fs.writeFile(path.join(legacyReadRoot, "src", "legacy-migrate.js"), "export function legacyReadMigratesLookup() {\n  return 'ok';\n}\n");
  await fs.writeFile(
    path.join(legacyReadRoot, ".aipi", "semantic-memory.json"),
    `${JSON.stringify({
      schema: "aipi.semantic-memory.v1",
      ollama_host: "http://localhost:11434",
      ollama_model: "nomic-embed-text",
      dimensions: 768,
      rule: "old default",
    }, null, 2)}\n`,
  );
  const legacyReadGraphPath = path.join(legacyReadRoot, ".aipi", "state", "aipi-graph.json");
  await fs.mkdir(path.dirname(legacyReadGraphPath), { recursive: true });
  await fs.writeFile(
    legacyReadGraphPath,
    `${JSON.stringify({
      schema: "aipi.code-graph.v1",
      built_at: "2026-06-19T17:15:00.000Z",
      source: "sqlite+lexical",
      stale: false,
      files: [{ path: "src/legacy-migrate.js", line_count: 3, size: 65, hash: "legacy" }],
      symbols: [],
      relationships: [],
      run_outcomes: [],
      sqlite: { path: ".aipi/state/aipi-graph.sqlite", status: "unavailable" },
      vector: {
        status: "unavailable",
        engine: "sqlite-vec",
        dimensions: 768,
        embedding_model: "nomic-embed-text",
      },
      freshness: { status: "fresh" },
    }, null, 2)}\n`,
  );
  const migratedFromRead = await aipiCallers({
    projectRoot: legacyReadRoot,
    symbol: "legacyReadMigratesLookup",
    env: { AIPI_OLLAMA_HOST: "http://ollama.test:11434" },
    embeddingFetch: fakeEmbeddingFetch([]),
  });
  assert.match(migratedFromRead.graph.rebuilt_from_stale.reason, /legacy embedding config migration required|embedding dimension mismatch/);
  assert.equal(migratedFromRead.graph.vector.dimensions, 1024);
  assert.equal(migratedFromRead.graph.vector.embedding_model, "bge-m3");
  const migratedReadConfig = await fs.readFile(path.join(legacyReadRoot, ".aipi", "semantic-memory.json"), "utf8");
  assert.doesNotMatch(migratedReadConfig, /nomic-embed-text|768/);
  const migratedReadGraphAfterFirst = await fs.readFile(legacyReadGraphPath, "utf8");
  const migratedReadConfigAfterFirst = await fs.readFile(path.join(legacyReadRoot, ".aipi", "semantic-memory.json"), "utf8");
  const secondLegacyRead = await aipiCallers({
    projectRoot: legacyReadRoot,
    symbol: "legacyReadMigratesLookup",
    env: { AIPI_OLLAMA_HOST: "http://ollama.test:11434" },
    embeddingFetch: fakeEmbeddingFetch([]),
  });
  assert.equal(await fs.readFile(legacyReadGraphPath, "utf8"), migratedReadGraphAfterFirst);
  assert.equal(await fs.readFile(path.join(legacyReadRoot, ".aipi", "semantic-memory.json"), "utf8"), migratedReadConfigAfterFirst);
  assert.equal(secondLegacyRead.graph.freshness.status, "fresh");
  assert.equal(secondLegacyRead.graph.rebuilt_from_stale ?? null, null);

  const kanban = await aipiKanbanUpdate({
    projectRoot: tempRoot,
    task: "billing renewal",
    status: "in_progress",
    run_id: "run-1",
    now: () => new Date("2026-06-16T01:00:00.000Z"),
  });
  assert.equal(kanban.event.status, "in_progress");
  assert.match(await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "kanban.jsonl"), "utf8"), /billing renewal/);

  const deferred = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "decision",
    content: "Keep renewal pricing tied to accepted contract.",
    source_ref: ".aipi/runtime/runs/run-1/steps/final_verification/VERIFICATION.md",
    now: () => new Date("2026-06-16T02:00:00.000Z"),
  });
  assert.equal(deferred.status, "deferred");
  assert.equal(await pathExists(path.join(tempRoot, deferred.candidate_path)), true);

  const selfApproved = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "decision",
    content: "Self approval must not reach durable memory.",
    source_ref: ".aipi/runtime/runs/run-1/steps/final_verification/VERIFICATION.md",
    approved: true,
    now: () => new Date("2026-06-16T02:30:00.000Z"),
  });
  assert.equal(selfApproved.status, "deferred");
  assert.equal(selfApproved.approved_ignored, true);
  assert.match(selfApproved.reason, /approval_ref/);
  assert.doesNotMatch(
    await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "decisions.md"), "utf8"),
    /Self approval must not reach durable memory/,
  );

  const approvalRel = ".aipi/runtime/approvals/approved/memory-promotion.json";
  await fs.mkdir(path.dirname(path.join(tempRoot, approvalRel)), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, approvalRel),
    JSON.stringify({ schema: "aipi.approval.v1", decision: "APPROVED" }),
  );

  const promoted = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "decision",
    content: "Keep renewal pricing tied to accepted contract.",
    source_ref: ".aipi/runtime/runs/run-1/steps/final_verification/VERIFICATION.md",
    approval_ref: approvalRel,
    now: () => new Date("2026-06-16T03:00:00.000Z"),
  });
  assert.equal(promoted.status, "promoted");
  assert.equal(promoted.changed, true);
  assert.equal(promoted.already_present, false);
  const decisionsText = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "decisions.md"), "utf8");
  assert.match(decisionsText, /### ADR-20260616T030000Z - Keep renewal pricing tied to accepted contract\./);
  assert.match(decisionsText, /\*\*approval-ref:\*\* \.aipi\/runtime\/approvals\/approved\/memory-promotion\.json/);
  assert.match(decisionsText, /memory_promoted: true/);
  assert.match(decisionsText, /memory_promoted_at: 2026-06-16/);
  assert.match(decisionsText, /## Timeline/);
  assert.match(decisionsText, /Promoted decision from \.aipi\/runtime\/runs\/run-1\/steps\/final_verification\/VERIFICATION\.md via aipi_promote_memory/);
  assert.doesNotMatch(decisionsText, /No project-specific technical decisions have been recorded yet/);
  assert.equal(decisionsText.indexOf("Keep renewal pricing tied to accepted contract.") < decisionsText.indexOf("## Timeline"), true);
  const repeatedPromotion = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "decision",
    content: "Keep renewal pricing tied to accepted contract.",
    source_ref: ".aipi/runtime/runs/run-1/steps/final_verification/VERIFICATION.md",
    approval_ref: approvalRel,
    now: () => new Date("2026-06-16T03:10:00.000Z"),
  });
  assert.equal(repeatedPromotion.status, "promoted");
  assert.equal(repeatedPromotion.changed, false);
  assert.equal(repeatedPromotion.already_present, true);
  const decisionsAfterRepeat = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "decisions.md"), "utf8");
  assert.equal(countOccurrences(decisionsAfterRepeat, promoted.promotion_hash), 2);

  const promotedRule = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "business-rule",
    title: "Renewal source of truth",
    content: "- **statement:** Subscriptions renew at the accepted contract price.",
    source_ref: ".aipi/runtime/runs/run-1/BDD-CONTRACT.md",
    approval_ref: approvalRel,
    now: () => new Date("2026-06-16T03:30:00.000Z"),
  });
  assert.equal(promotedRule.status, "promoted");
  assert.equal(promotedRule.changed, true);
  const businessRulesText = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  assert.match(businessRulesText, /### BR-20260616T033000Z - Renewal source of truth/);
  assert.match(businessRulesText, /\*\*statement:\*\* Subscriptions renew at the accepted contract price\./);
  assert.match(businessRulesText, /\*\*status:\*\* accepted/);
  assert.match(businessRulesText, /memory_promoted: true/);
  assert.match(businessRulesText, /Promoted business-rule from \.aipi\/runtime\/runs\/run-1\/BDD-CONTRACT\.md via aipi_promote_memory/);

  const acceptedCandidateRule = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "business-rule",
    title: "Billing candidate acceptance",
    content: [
      "CANDIDATE: Billing renewal must preserve the accepted source price.",
      "- **statement:** Billing renewal must preserve the accepted source price.",
      "- source_ref: src/billing.js:2",
    ].join("\n"),
    source_ref: "src/billing.js:2",
    approval_ref: approvalRel,
    now: () => new Date("2026-06-16T03:40:00.000Z"),
  });
  assert.equal(acceptedCandidateRule.status, "promoted");
  assert.equal(acceptedCandidateRule.changed, true);
  const acceptedRuleId = "BR-20260616T034000Z";
  const businessRulesAfterAccepted = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  assert.match(businessRulesAfterAccepted, /### BR-20260616T034000Z - Billing candidate acceptance/);
  assert.match(businessRulesAfterAccepted, /\*\*statement:\*\* Billing renewal must preserve the accepted source price\./);
  assert.match(businessRulesAfterAccepted, /\*\*status:\*\* accepted/);
  assert.match(businessRulesAfterAccepted, /\*\*source:\*\* src\/billing\.js:2/);
  assert.match(businessRulesAfterAccepted, /\*\*links:\*\* implements:\[src\/billing\.js\], relates:\[\], decided-by:\[\]/);
  assert.equal(countOccurrences(businessRulesAfterAccepted, "Billing candidate acceptance"), 1);

  const repeatedAcceptedCandidateRule = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "business-rule",
    title: "Billing candidate acceptance",
    content: [
      "CANDIDATE: Billing renewal must preserve the accepted source price.",
      "- **statement:** Billing renewal must preserve the accepted source price.",
      "- source_ref: src/billing.js:2",
    ].join("\n"),
    source_ref: "src/billing.js:2",
    approval_ref: approvalRel,
    now: () => new Date("2026-06-16T03:50:00.000Z"),
  });
  assert.equal(repeatedAcceptedCandidateRule.status, "promoted");
  assert.equal(repeatedAcceptedCandidateRule.changed, false);
  assert.equal(repeatedAcceptedCandidateRule.already_present, true);
  const businessRulesAfterAcceptedRepeat = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8");
  assert.equal(countOccurrences(businessRulesAfterAcceptedRepeat, "### BR-20260616T034000Z - Billing candidate acceptance"), 1);

  const deferredCandidateRule = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "business-rule",
    title: "Deferred candidate rule",
    content: "- **statement:** Candidate business rule remains pending.",
    source_ref: "src/billing.js:4",
    now: () => new Date("2026-06-16T03:55:00.000Z"),
  });
  assert.equal(deferredCandidateRule.status, "deferred");
  const deferredCandidateText = await fs.readFile(path.join(tempRoot, deferredCandidateRule.candidate_path), "utf8");
  assert.match(deferredCandidateText, /\*\*status:\*\* candidate/);
  assert.doesNotMatch(
    await fs.readFile(path.join(tempRoot, ".aipi", "memory", "project", "business-rules.md"), "utf8"),
    /Candidate business rule remains pending/,
  );

  const acceptedRuleGraph = await rebuildCodeGraph({
    projectRoot: tempRoot,
    now: () => new Date("2026-06-16T04:05:00.000Z"),
    ...semanticOptions,
  });
  assert.equal(
    acceptedRuleGraph.relationships.some(
      (edge) =>
        edge.relation === "business_rule_impacts_code" &&
        edge.source_ref.endsWith(`business-rules.md#${acceptedRuleId}`) &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );
  const acceptedRuleRetrieval = await aipiRetrieve({
    projectRoot: tempRoot,
    query: "src/billing.js",
    limit: 5,
    ...semanticOptions,
  });
  const acceptedRuleBillingRef = acceptedRuleRetrieval.refs.find((ref) => ref.path === "src/billing.js");
  assert.ok(acceptedRuleBillingRef);
  assert.equal(
    acceptedRuleBillingRef.governing_rules.some(
      (edge) =>
        edge.relation === "business_rule_impacts_code" &&
        edge.source_ref.endsWith(`business-rules.md#${acceptedRuleId}`) &&
        edge.target_ref === "src/billing.js",
    ),
    true,
  );

  const promotedUserMemory = await aipiPromoteMemory({
    projectRoot: tempRoot,
    kind: "knowledge",
    content: "User prefers terse handoff summaries.",
    source_ref: ".aipi/runtime/runs/run-1/BDD-CONTRACT.md",
    approval_ref: approvalRel,
    user_memory: true,
    now: () => new Date("2026-06-16T04:00:00.000Z"),
  });
  assert.equal(promotedUserMemory.status, "promoted");
  const userMemoryText = await fs.readFile(path.join(tempRoot, ".aipi", "memory", "user.local.md"), "utf8");
  assert.match(userMemoryText, /^---\ntype: knowledge\nowner: engineering\nstatus: active\nlast_reviewed: -\nmemory_promoted: true\nmemory_promoted_at: 2026-06-16\n---/);

  const registered = [];
  registerAipiRuntimeTools(
    {
      registerTool(tool) {
        registered.push(tool.name);
      },
    },
    { projectRootResolver: () => tempRoot },
  );
  assert.deepEqual(
    new Set(registered),
    new Set([
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
    ]),
  );

  console.log("AIPI_TOOLS_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function fakeEmbeddingFetch(calls) {
  return fakeEmbeddingFetchForModel(calls, "bge-m3", 1024);
}

function fakeEmbeddingFetchThatFailsAfter(calls, successfulLimit) {
  const successfulInputs = [];
  const base = fakeEmbeddingFetch(calls);
  return {
    successfulInputs,
    async fetch(url, options = {}) {
      if (!String(url).endsWith("/api/embed")) return base(url, options);
      if (successfulInputs.length >= successfulLimit) {
        throw new Error("simulated interrupted embedding build");
      }
      const body = JSON.parse(options.body ?? "{}");
      const input = Array.isArray(body.input) ? String(body.input[0] ?? "") : String(body.input ?? "");
      successfulInputs.push(input);
      return base(url, options);
    },
  };
}

function fakeEmbeddingFetchForModel(calls, expectedModel, dimensions) {
  return async (url, options = {}) => {
    if (String(url).endsWith("/api/tags")) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { models: [{ name: expectedModel }] };
        },
      };
    }
    const body = JSON.parse(options.body ?? "{}");
    const input = Array.isArray(body.input) ? String(body.input[0] ?? "") : String(body.input ?? "");
    assert.equal(body.model, expectedModel);
    calls.push({ url: String(url), model: body.model, input });
    const vector = new Array(dimensions).fill(0);
    vector[Math.abs(hashText(input)) % vector.length] = 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return { embeddings: [vector] };
      },
    };
  };
}

function fakeMissingTagsFetch() {
  return async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return {
      ok: true,
      status: 200,
      async json() {
        return { models: [] };
      },
    };
  };
}

function fakeAvailableTagsFetch(model) {
  return async (url) => {
    assert.match(String(url), /\/api\/tags$/);
    return {
      ok: true,
      status: 200,
      async json() {
        return { models: [{ name: model }] };
      },
    };
  };
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash;
}

function countOccurrences(text, token) {
  return String(text).split(token).length - 1;
}

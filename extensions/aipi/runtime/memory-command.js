import fs from "node:fs/promises";
import path from "node:path";
import {
  aipiMemoryQuery,
  aipiPromoteMemory,
  detectBusinessRuleDrift,
  listBusinessRuleDrifts,
  parseMemoryFrontmatter,
  resolveBusinessRuleDrift,
} from "./aipi-tools.js";
import { formatMemoryDoctor, runMemoryDoctor, verifyMemory } from "./memory-doctor.js";

const VALID_LAYERS = new Set(["project", "user", "all"]);
const GRAPH_REL_PATH = ".aipi/state/aipi-graph.json";
const GRAPH_SQLITE_REL_PATH = ".aipi/state/aipi-graph.sqlite";
const CANDIDATES_DIR = ".aipi/runtime/memory-candidates";

// Candidate ids are filename stems; reject anything that could escape the candidates dir.
function safeCandidateId(id) {
  const clean = String(id ?? "").trim();
  if (!clean || /[\\/]/.test(clean) || clean.includes("..")) {
    throw new Error(`invalid candidate id: ${id}`);
  }
  return clean.replace(/\.(json|md)$/i, "");
}

export function parseMemoryArgs(args = "") {
  const tokens = String(args).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens[0] === "status") {
    return parseMemoryOptions(tokens.slice(tokens[0] === "status" ? 1 : 0), { action: "status", layer: "all" });
  }
  if (tokens[0] === "refs" || tokens[0] === "files" || tokens[0] === "list") {
    return parseMemoryOptions(tokens.slice(1), { action: "refs", layer: "all" });
  }
  if (tokens[0] === "query" || tokens[0] === "search") {
    return parseMemoryOptions(tokens.slice(1), { action: "query", layer: "project", limit: 8, query: "" });
  }
  if (tokens[0] === "candidates" || tokens[0] === "candidate") {
    return { action: "candidates" };
  }
  if (tokens[0] === "promote") {
    if (!tokens[1]) throw new Error("/aipi-memory promote requires a candidate id");
    return { action: "promote", id: tokens[1] };
  }
  if (tokens[0] === "discard") {
    if (!tokens[1]) throw new Error("/aipi-memory discard requires a candidate id");
    return { action: "discard", id: tokens[1] };
  }
  if (tokens[0] === "reconcile") {
    const sub = tokens[1];
    if (!sub || sub === "list") return { action: "reconcile" };
    if (sub === "scan") return { action: "reconcile-scan" };
    if (sub === "dismiss" || sub === "resolve") {
      if (!tokens[2]) throw new Error(`/aipi-memory reconcile ${sub} requires a drift id`);
      return { action: "reconcile-act", op: sub, id: tokens[2] };
    }
    throw new Error(`Unknown /aipi-memory reconcile subcommand: ${sub}`);
  }
  if (tokens[0] === "doctor") {
    return { action: "doctor" };
  }
  if (tokens[0] === "verify") {
    const extra = tokens.slice(1).filter((t) => t !== "--strict");
    if (extra.length) throw new Error(`Unexpected /aipi-memory verify argument: ${extra[0]}`);
    return { action: "verify", strict: tokens.includes("--strict") };
  }
  throw new Error(`Unknown /aipi-memory action: ${tokens[0]}`);
}

export async function runMemoryCommand({
  args = "",
  projectRoot,
  now = () => new Date(),
  promoteMemory = aipiPromoteMemory,
  detectDrift = detectBusinessRuleDrift,
} = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  const command = parseMemoryArgs(args);

  if (command.action === "reconcile") {
    return {
      schema: "aipi.memory-command.v1",
      action: "reconcile",
      drifts: await listBusinessRuleDrifts(root),
    };
  }

  if (command.action === "reconcile-scan") {
    const scan = await detectDrift({ root, now });
    return {
      schema: "aipi.memory-command.v1",
      action: "reconcile-scan",
      scan,
      drifts: await listBusinessRuleDrifts(root),
    };
  }

  if (command.action === "reconcile-act") {
    const result = await resolveBusinessRuleDrift({ root, id: command.id, action: command.op, now });
    return { schema: "aipi.memory-command.v1", action: "reconcile-act", op: command.op, id: result.id, status: result.status };
  }

  if (command.action === "doctor") {
    return { schema: "aipi.memory-command.v1", action: "doctor", doctor: await runMemoryDoctor({ projectRoot: root }) };
  }

  if (command.action === "verify") {
    const doctor = await runMemoryDoctor({ projectRoot: root });
    return { schema: "aipi.memory-command.v1", action: "verify", verify: verifyMemory(doctor, { strict: command.strict }), doctor };
  }

  if (command.action === "candidates") {
    return {
      schema: "aipi.memory-command.v1",
      action: "candidates",
      candidates: await listMemoryCandidates(root),
    };
  }

  if (command.action === "promote") {
    const id = safeCandidateId(command.id);
    const jsonRel = path.posix.join(CANDIDATES_DIR, `${id}.json`);
    const jsonAbs = path.join(root, jsonRel);
    if (!(await pathExists(jsonAbs))) {
      throw new Error(`no structured candidate '${id}' to promote (only .json candidates are promotable; legacy .md candidates must be re-captured)`);
    }
    const candidate = JSON.parse(await fs.readFile(jsonAbs, "utf8"));
    // Mint a HUMAN approval artifact (source: human-drain) so the hardened approval gate authorizes the write.
    const approvalRel = path.posix.join(".aipi", "runtime", "approvals", "approved", `${id}-drain.json`);
    await fs.mkdir(path.dirname(path.join(root, approvalRel)), { recursive: true });
    await fs.writeFile(
      path.join(root, approvalRel),
      `${JSON.stringify({ schema: "aipi.memory-promotion-approval.v1", decision: "APPROVED", source: "human-drain", candidate_id: id, created_at: now().toISOString() }, null, 2)}\n`,
    );
    const result = await promoteMemory({
      projectRoot: root,
      kind: candidate.kind,
      title: candidate.title ?? "",
      content: candidate.content,
      source_ref: candidate.source_ref,
      user_memory: Boolean(candidate.user_memory),
      approval_ref: approvalRel,
      now,
    });
    let drained = false;
    if (result.status === "promoted") {
      await fs.rm(jsonAbs, { force: true });
      if (candidate.md_path) await fs.rm(path.join(root, candidate.md_path), { force: true });
      drained = true;
    }
    return { schema: "aipi.memory-command.v1", action: "promote", id, result, drained };
  }

  if (command.action === "discard") {
    const id = safeCandidateId(command.id);
    const removed = [];
    for (const ext of ["json", "md"]) {
      const rel = path.posix.join(CANDIDATES_DIR, `${id}.${ext}`);
      const abs = path.join(root, rel);
      if (await pathExists(abs)) {
        await fs.rm(abs, { force: true });
        removed.push(rel);
      }
    }
    if (!removed.length) throw new Error(`no candidate '${id}' to discard`);
    return { schema: "aipi.memory-command.v1", action: "discard", id, removed };
  }

  if (command.action === "status") {
    return {
      schema: "aipi.memory-command.v1",
      action: "status",
      projectRoot: root,
      layers: {
        project: await summarizeLayer(root, "project"),
        user: await summarizeLayer(root, "user"),
      },
      code_graph: await readCodeGraphStatus(root),
    };
  }

  if (command.action === "refs") {
    return {
      schema: "aipi.memory-command.v1",
      action: "refs",
      layer: command.layer,
      refs: await listMemoryRefs(root, command.layer),
    };
  }

  if (command.action === "query") {
    const result = await aipiMemoryQuery({
      projectRoot: root,
      query: command.query,
      layer: command.layer,
      limit: command.limit,
      type: command.type,
      owner: command.owner,
      status: command.status,
      stale_before: command.stale_before,
    });
    return {
      schema: "aipi.memory-command.v1",
      action: "query",
      query: result.query,
      layer: result.layer,
      filters: result.filters,
      refs: result.refs,
    };
  }

  throw new Error(`Unknown /aipi-memory action: ${command.action}`);
}

export function formatMemoryCommandResult(result) {
  if (result.action === "status") {
    const project = result.layers.project;
    const user = result.layers.user;
    const graph = result.code_graph;
    return [
      "AIPI memory status:",
      `project=${project.status} files=${project.files} lines=${project.lines}`,
      `user=${user.status} files=${user.files} lines=${user.lines}`,
      `code_graph=${graph.status} path=${graph.path}`,
      `sqlite=${graph.sqlite?.status ?? "unknown"} path=${graph.sqlite?.path ?? GRAPH_SQLITE_REL_PATH}`,
      `vector=${graph.vector?.status ?? "unknown"} engine=${graph.vector?.engine ?? "sqlite-vec"}`,
    ].join("\n");
  }

  if (result.action === "refs") {
    if (!result.refs.length) return `AIPI memory refs: none for layer=${result.layer}`;
    return [
      `AIPI memory refs: layer=${result.layer}`,
      ...result.refs.map((ref) => {
        const metadata = ref.metadata
          ? ` type=${ref.metadata.type ?? "unknown"} owner=${ref.metadata.owner ?? "unknown"} status=${ref.metadata.status ?? "unknown"} last_reviewed=${ref.metadata.last_reviewed ?? "unknown"}`
          : "";
        return `- ${ref.layer} ${ref.path} lines=${ref.lines} bytes=${ref.bytes}${metadata}`;
      }),
    ].join("\n");
  }

  if (result.action === "query") {
    if (!result.refs.length) return `AIPI memory query: no refs for "${result.query}" layer=${result.layer}`;
    const filters = result.filters && Object.keys(result.filters).length
      ? ` filters=${JSON.stringify(result.filters)}`
      : "";
    return [
      `AIPI memory query: "${result.query}" layer=${result.layer}${filters}`,
      ...result.refs.map((ref) => `- ${ref.path}:${ref.line} score=${ref.score} ${singleLine(ref.text)}`),
    ].join("\n");
  }

  if (result.action === "candidates") {
    if (!result.candidates.length) return "AIPI memory candidates: none pending.";
    return [
      `AIPI memory candidates: ${result.candidates.length} pending`,
      ...result.candidates.map((c) => `- ${c.id} [${c.kind ?? "?"}]${c.structured ? "" : " (legacy)"}${c.title ? ` ${c.title}` : ""}${c.source_ref ? ` (${c.source_ref})` : ""}`),
      "Promote with /aipi-memory promote <id> or discard with /aipi-memory discard <id>.",
    ].join("\n");
  }

  if (result.action === "promote") {
    return result.drained
      ? `AIPI memory promoted: ${result.id} -> ${result.result.path}${result.result.committed ? " (committed)" : ""}`
      : `AIPI memory promote did NOT land for ${result.id}: ${result.result.reason ?? result.result.status}`;
  }

  if (result.action === "discard") {
    return `AIPI memory candidate discarded: ${result.id} (${result.removed.length} file(s))`;
  }

  if (result.action === "reconcile" || result.action === "reconcile-scan") {
    const drifts = result.drifts ?? [];
    const header = result.action === "reconcile-scan"
      ? `AIPI memory reconcile scan: ${result.scan?.in_scope ?? 0} in-scope of ${result.scan?.checked ?? 0} rule(s); ${drifts.length} open drift(s)`
      : `AIPI memory reconcile: ${drifts.length} open drift(s)`;
    if (!drifts.length) return `${header} — business rules are in sync with code.`;
    return [
      header,
      ...drifts.map((d) => `- ${d.id} [${d.severity ?? "?"}/${d.signal ?? "?"}]${d.title ? ` ${d.title}` : ""}${Array.isArray(d.changed) && d.changed.length ? ` (changed: ${d.changed.join(", ")})` : ""}`),
      "Edit the rule, then /aipi-memory reconcile resolve <id> — or dismiss a false positive with /aipi-memory reconcile dismiss <id>.",
    ].join("\n");
  }

  if (result.action === "reconcile-act") {
    return `AIPI memory drift ${result.op === "resolve" ? "resolved" : "dismissed"}: ${result.id}`;
  }

  if (result.action === "doctor") {
    return formatMemoryDoctor(result.doctor);
  }

  if (result.action === "verify") {
    const v = result.verify;
    return `AIPI memory verify${v.strict ? " --strict" : ""}: ${v.ok ? "OK" : "FAIL"} (${v.errors} error, ${v.warnings} warn)\n${formatMemoryDoctor(result.doctor)}`;
  }

  return "AIPI memory command completed.";
}

function parseMemoryOptions(tokens, initial) {
  const options = { ...initial };
  const queryTerms = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--layer") {
      const layer = tokens[index + 1];
      if (!VALID_LAYERS.has(layer)) throw new Error("aipi memory --layer must be project, user, or all");
      options.layer = layer;
      index += 1;
      continue;
    }
    if (token === "--limit") {
      const value = Number.parseInt(tokens[index + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1) throw new Error("aipi memory --limit must be a positive integer");
      options.limit = value;
      index += 1;
      continue;
    }
    if (token === "--type" || token === "--owner" || token === "--status" || token === "--stale-before") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`aipi memory ${token} requires a value`);
      const key = token.slice(2).replaceAll("-", "_");
      options[key] = value;
      index += 1;
      continue;
    }
    if (token.startsWith("--")) throw new Error(`Unknown /aipi-memory option: ${token}`);
    if (options.action === "query") {
      queryTerms.push(token);
      continue;
    }
    throw new Error(`Unexpected /aipi-memory argument: ${token}`);
  }

  if (options.action === "query") {
    options.query = queryTerms.join(" ").trim();
    if (!options.query) throw new Error("aipi memory query requires search terms");
  }

  return options;
}

async function summarizeLayer(root, layer) {
  const refs = await listMemoryRefs(root, layer);
  return {
    source: layer === "project" ? ".aipi/memory/project" : ".aipi/memory/user.local.md",
    status: refs.length ? "available" : "missing",
    files: refs.length,
    lines: refs.reduce((sum, ref) => sum + ref.lines, 0),
    bytes: refs.reduce((sum, ref) => sum + ref.bytes, 0),
  };
}

async function listMemoryRefs(root, layer = "all") {
  if (!VALID_LAYERS.has(layer)) throw new Error("memory layer must be project, user, or all");
  const refs = [];
  if (layer === "project" || layer === "all") {
    const projectRoot = path.join(root, ".aipi", "memory", "project");
    for (const file of await listMarkdownFiles(projectRoot)) {
      refs.push(await describeMemoryFile(root, file, "project"));
    }
  }
  if (layer === "user" || layer === "all") {
    const userLocal = path.join(root, ".aipi", "memory", "user.local.md");
    if (await pathExists(userLocal)) refs.push(await describeMemoryFile(root, userLocal, "user"));
  }
  return refs.sort((a, b) => a.path.localeCompare(b.path));
}

async function describeMemoryFile(root, file, layer) {
  const [stat, text] = await Promise.all([fs.stat(file), fs.readFile(file, "utf8")]);
  return {
    layer,
    path: path.relative(root, file).replaceAll("\\", "/"),
    lines: text.split(/\r?\n/).length,
    bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    metadata: parseMemoryFrontmatter(text),
  };
}

async function readCodeGraphStatus(root) {
  const graphPath = path.join(root, GRAPH_REL_PATH);
  const parsed = await readJson(graphPath);
  if (!parsed) {
    return {
      status: "missing",
      path: GRAPH_REL_PATH,
      sqlite: { path: GRAPH_SQLITE_REL_PATH, status: "missing" },
      vector: { status: "unknown", engine: "sqlite-vec" },
      note: "Run aipi_retrieve, aipi_impact, or aipi_callers to rebuild the JSON/SQLite graph index.",
    };
  }
  return {
    path: GRAPH_REL_PATH,
    status: parsed.schema === "aipi.code-graph.v1" ? (parsed.stale ? "stale" : "available") : "unknown-schema",
    source: parsed.source ?? "unknown",
    stale: parsed.stale ?? null,
    freshness: parsed.freshness ?? null,
    file_count: parsed.files?.length ?? parsed.file_count ?? 0,
    symbol_count: parsed.symbols?.length ?? parsed.symbol_count ?? 0,
    relationship_count: parsed.relationships?.length ?? parsed.sqlite?.relationship_count ?? 0,
    sqlite: parsed.sqlite ?? { path: GRAPH_SQLITE_REL_PATH, status: "unknown" },
    vector: parsed.vector ?? parsed.sqlite?.vector ?? { status: "unknown", engine: "sqlite-vec" },
  };
}

async function listMarkdownFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(full)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
  return files;
}

async function listMemoryCandidates(root) {
  const dir = path.join(root, CANDIDATES_DIR);
  const entries = await fs.readdir(dir).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const jsonIds = new Set();
  const candidates = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const id = name.replace(/\.json$/, "");
    jsonIds.add(id);
    try {
      const c = JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
      candidates.push({ id, structured: true, kind: c.kind ?? null, title: c.title ?? null, source_ref: c.source_ref ?? null, status: c.status ?? "candidate", created_at: c.created_at ?? null });
    } catch {
      candidates.push({ id, structured: true, kind: null, title: null, source_ref: null, status: "unreadable" });
    }
  }
  // Legacy .md-only candidates (written before the structured sidecar) are listed but not promotable.
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const id = name.replace(/\.md$/, "");
    if (jsonIds.has(id)) continue;
    const inferredKind = id.replace(/^[0-9TZ:.\-]+-/, "") || null;
    candidates.push({ id, structured: false, kind: inferredKind, title: null, source_ref: null, status: "legacy" });
  }
  return candidates.sort((a, b) => a.id.localeCompare(b.id));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function singleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

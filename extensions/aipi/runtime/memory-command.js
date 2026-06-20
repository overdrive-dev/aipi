import fs from "node:fs/promises";
import path from "node:path";
import { aipiMemoryQuery, parseMemoryFrontmatter } from "./aipi-tools.js";

const VALID_LAYERS = new Set(["project", "user", "all"]);
const GRAPH_REL_PATH = ".aipi/state/aipi-graph.json";
const GRAPH_SQLITE_REL_PATH = ".aipi/state/aipi-graph.sqlite";

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
  throw new Error(`Unknown /aipi-memory action: ${tokens[0]}`);
}

export async function runMemoryCommand({ args = "", projectRoot } = {}) {
  if (!projectRoot) throw new Error("projectRoot is required");
  const root = path.resolve(projectRoot);
  const command = parseMemoryArgs(args);

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

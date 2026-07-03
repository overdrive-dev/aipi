import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Environment doctor: verifies the workstation can run software projects the
// way AIPI drives them — Node/Git/Pi always, Docker/Playwright/Ollama according
// to a per-project requirements declaration (.aipi/environment.json). Pure and
// injectable (spawnSyncFn/fetchFn/existsSync/env/platform) per repo convention;
// every check is wrapped so the doctor itself never throws.

export const ENVIRONMENT_DOCTOR_SCHEMA = "aipi.environment-doctor.v1";
export const ENVIRONMENT_REQUIREMENTS_SCHEMA = "aipi.environment-requirements.v1";
export const ENVIRONMENT_REQUIREMENTS_REL_PATH = ".aipi/environment.json";

// The engine's semantic memory pins this model/width (sqlite-vec table width
// depends on it); the doctor must verify the SAME model the engine will call.
export const REQUIRED_EMBEDDING_MODEL = "bge-m3";
export const REQUIRED_EMBEDDING_DIMENSIONS = 1024;
const MIN_NODE_VERSION = "22.19.0";

const REQUIREMENT_LEVELS = new Set(["required", "optional", "off"]);
const DEFAULT_REQUIREMENTS = Object.freeze({
  docker: "optional",
  playwright: "off",
  ollama_embeddings: "optional",
});

export function loadEnvironmentRequirements({
  targetDir = process.cwd(),
  readFileSync = fsSync.readFileSync,
} = {}) {
  try {
    const raw = JSON.parse(readFileSync(path.join(targetDir, ENVIRONMENT_REQUIREMENTS_REL_PATH), "utf8"));
    const requirements = { ...DEFAULT_REQUIREMENTS };
    for (const key of Object.keys(DEFAULT_REQUIREMENTS)) {
      if (REQUIREMENT_LEVELS.has(raw?.[key])) requirements[key] = raw[key];
    }
    return { requirements, source: ENVIRONMENT_REQUIREMENTS_REL_PATH };
  } catch {
    return { requirements: { ...DEFAULT_REQUIREMENTS }, source: "defaults" };
  }
}

export async function buildEnvironmentReport({
  targetDir = process.cwd(),
  requirements = null,
  piProbe = null,
  env = process.env,
  platform = process.platform,
  nodeVersion = process.versions.node,
  homeDir = null,
  spawnSyncFn = spawnSync,
  fetchFn = globalThis.fetch,
  existsSync = fsSync.existsSync,
  readFileSync = fsSync.readFileSync,
  readdirSync = fsSync.readdirSync,
} = {}) {
  const resolvedRequirements = requirements
    ?? loadEnvironmentRequirements({ targetDir, readFileSync }).requirements;
  const checks = [];
  const deps = { env, platform, spawnSyncFn, fetchFn, existsSync, readFileSync, readdirSync, homeDir, targetDir };

  checks.push(await safeCheck(() => checkNode({ nodeVersion })));
  checks.push(await safeCheck(() => checkGit(deps)));
  checks.push(await safeCheck(() => checkPi({ piProbe })));
  if (resolvedRequirements.docker !== "off") {
    checks.push(await safeCheck(() => checkDocker(deps, resolvedRequirements.docker)));
  }
  if (resolvedRequirements.playwright !== "off") {
    checks.push(await safeCheck(() => checkPlaywright(deps, resolvedRequirements.playwright)));
  }
  if (resolvedRequirements.ollama_embeddings !== "off") {
    checks.push(await safeCheck(() => checkOllamaEmbeddings(deps, resolvedRequirements.ollama_embeddings)));
  }

  const blockers = checks.filter((check) => check.state === "block");
  const warnings = checks.filter((check) => check.state === "warn");
  return {
    schema: ENVIRONMENT_DOCTOR_SCHEMA,
    checked_at: new Date().toISOString(),
    target: targetDir,
    requirements: resolvedRequirements,
    checks,
    blockers: blockers.map((check) => check.id),
    warnings: warnings.map((check) => check.id),
    ok: blockers.length === 0,
  };
}

async function safeCheck(run) {
  try {
    return await run();
  } catch (error) {
    return {
      id: "env.internal",
      state: "warn",
      required: false,
      evidence: `doctor check threw: ${String(error?.message ?? error)}`,
      next_action: "report this as an aipi engine bug",
      fix_available: false,
    };
  }
}

function checkResult(id, { state, required, evidence, nextAction = null, fixAvailable = false }) {
  return { id, state, required, evidence, next_action: nextAction, fix_available: fixAvailable };
}

// Maps a probe failure to the requirement level: required -> block, optional -> warn.
function failState(level) {
  return level === "required" ? "block" : "warn";
}

function compareVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function checkNode({ nodeVersion }) {
  const ok = compareVersions(nodeVersion, MIN_NODE_VERSION) >= 0;
  return checkResult("env.node", {
    state: ok ? "pass" : "block",
    required: true,
    evidence: `node ${nodeVersion} (minimum ${MIN_NODE_VERSION}, required by the pinned Pi runtime)`,
    nextAction: ok ? null : `install Node >= ${MIN_NODE_VERSION} (https://nodejs.org)`,
  });
}

function checkGit({ spawnSyncFn }) {
  const result = trySpawn(spawnSyncFn, "git", ["--version"]);
  const ok = result.status === 0 && /git version/i.test(result.stdout ?? "");
  return checkResult("env.git", {
    state: ok ? "pass" : "block",
    required: true,
    evidence: ok ? String(result.stdout).trim() : describeSpawnFailure(result, "git"),
    nextAction: ok ? null : "install Git (https://git-scm.com) and ensure it is on PATH",
  });
}

function checkPi({ piProbe }) {
  const probe = typeof piProbe === "function" ? piProbe() : piProbe;
  if (!probe) {
    return checkResult("env.pi", {
      state: "warn",
      required: true,
      evidence: "no Pi probe provided to the doctor",
      nextAction: "run through `aipi setup` so the wrapper's Pi resolution is used",
    });
  }
  if (probe.ok) {
    return checkResult("env.pi", {
      state: "pass",
      required: true,
      evidence: `pi ${probe.version ?? "?"} resolved from ${probe.source ?? "unknown source"}`,
    });
  }
  return checkResult("env.pi", {
    state: "block",
    required: true,
    evidence: probe.error ?? "pi runtime not resolvable",
    nextAction: "run `npm install` in the aipi package (the pinned Pi ships as a dependency), or set AIPI_PI_BIN/AIPI_PI_CLI_JS",
  });
}

function checkDocker({ spawnSyncFn, platform }, level) {
  const info = trySpawn(spawnSyncFn, "docker", ["info", "--format", "{{json .ServerVersion}}"]);
  if (info.status === 0) {
    const version = String(info.stdout ?? "").trim().replaceAll('"', "");
    return checkResult("env.docker", {
      state: "pass",
      required: level === "required",
      evidence: `docker daemon reachable (server ${version || "unknown"})`,
    });
  }
  const missing = info.error?.code === "ENOENT";
  const remediation = missing
    ? {
        win32: "install Docker Desktop (WSL2 backend): https://docs.docker.com/desktop/install/windows-install/",
        darwin: "install Docker Desktop: https://docs.docker.com/desktop/install/mac-install/",
        linux: "install Docker Engine: https://docs.docker.com/engine/install/",
      }[platform] ?? "install Docker"
    : {
        win32: "start Docker Desktop; if running inside WSL, enable the distro under Settings > Resources > WSL Integration",
        darwin: "start Docker Desktop (open -a Docker)",
        linux: "start the daemon: sudo systemctl start docker (and add your user to the docker group)",
      }[platform] ?? "start the Docker daemon";
  return checkResult("env.docker", {
    state: failState(level),
    required: level === "required",
    evidence: missing ? "docker CLI not found on PATH" : `docker CLI present but daemon unreachable (${describeSpawnFailure(info, "docker")})`,
    nextAction: remediation,
  });
}

function checkPlaywright({ existsSync, readFileSync, readdirSync, env, platform, homeDir, targetDir }, level) {
  const packagePresent = ["playwright", "@playwright/test", "playwright-core"].some((name) =>
    existsSync(path.join(targetDir, "node_modules", ...name.split("/"))));
  let declaredInPackageJson = false;
  try {
    const pkg = JSON.parse(readFileSync(path.join(targetDir, "package.json"), "utf8"));
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    declaredInPackageJson = Boolean(all.playwright ?? all["@playwright/test"]);
  } catch {
    /* no package.json is fine */
  }
  if (!packagePresent && !declaredInPackageJson) {
    return checkResult("env.playwright", {
      state: failState(level),
      required: level === "required",
      evidence: "playwright is neither installed under node_modules nor declared in package.json",
      nextAction: "npm install -D @playwright/test && npx playwright install",
      fixAvailable: false,
    });
  }

  const browsersDir = env.PLAYWRIGHT_BROWSERS_PATH?.trim()
    ? env.PLAYWRIGHT_BROWSERS_PATH.trim()
    : defaultPlaywrightCacheDir({ platform, homeDir, env });
  let browsersInstalled = false;
  try {
    browsersInstalled = Boolean(browsersDir) && existsSync(browsersDir) && readdirSync(browsersDir).length > 0;
  } catch {
    browsersInstalled = false;
  }
  if (browsersInstalled) {
    return checkResult("env.playwright", {
      state: "pass",
      required: level === "required",
      evidence: `playwright package present; browsers cache at ${browsersDir}`,
    });
  }
  return checkResult("env.playwright", {
    state: failState(level),
    required: level === "required",
    evidence: `playwright package present but no browsers found at ${browsersDir ?? "the default cache"} (no JSON listing exists upstream; directory heuristics only)`,
    nextAction: "npx playwright install",
    fixAvailable: true,
  });
}

function defaultPlaywrightCacheDir({ platform, homeDir, env }) {
  if (platform === "win32") {
    const base = env.LOCALAPPDATA ?? (homeDir ? path.join(homeDir, "AppData", "Local") : null);
    return base ? path.join(base, "ms-playwright") : null;
  }
  if (platform === "darwin") {
    return homeDir ? path.join(homeDir, "Library", "Caches", "ms-playwright") : null;
  }
  return homeDir ? path.join(homeDir, ".cache", "ms-playwright") : null;
}

export function resolveOllamaHost({ env = process.env, targetDir = process.cwd(), readFileSync = fsSync.readFileSync } = {}) {
  if (env.AIPI_OLLAMA_HOST?.trim()) return normalizeHost(env.AIPI_OLLAMA_HOST.trim());
  try {
    const config = JSON.parse(readFileSync(path.join(targetDir, ".aipi", "semantic-memory.json"), "utf8"));
    if (typeof config?.ollama_host === "string" && config.ollama_host.trim()) {
      return normalizeHost(config.ollama_host.trim());
    }
  } catch {
    /* config optional */
  }
  if (env.OLLAMA_HOST?.trim()) return normalizeHost(env.OLLAMA_HOST.trim());
  return "http://localhost:11434";
}

function normalizeHost(value) {
  if (/^https?:\/\//i.test(value)) return value.replace(/\/$/, "");
  return `http://${value.replace(/\/$/, "")}`;
}

async function checkOllamaEmbeddings({ spawnSyncFn, fetchFn, env, readFileSync, targetDir }, level) {
  const host = resolveOllamaHost({ env, targetDir, readFileSync });
  const tags = await tryFetchJson(fetchFn, `${host}/api/tags`, { timeoutMs: 3_000 });
  if (!tags.ok) {
    const binary = trySpawn(spawnSyncFn, "ollama", ["--version"]);
    const installed = binary.status === 0;
    return checkResult("env.ollama.embeddings", {
      state: failState(level),
      required: level === "required",
      evidence: installed
        ? `ollama binary present but the server at ${host} is unreachable (${tags.error})`
        : `ollama is not installed and ${host} is unreachable`,
      nextAction: installed
        ? "start the Ollama server (`ollama serve` or launch the Ollama app)"
        : "install Ollama (https://ollama.com/download), then `ollama pull bge-m3`",
    });
  }

  const models = Array.isArray(tags.body?.models) ? tags.body.models : [];
  const hasModel = models.some((model) => String(model?.name ?? "").startsWith(REQUIRED_EMBEDDING_MODEL));
  if (!hasModel) {
    return checkResult("env.ollama.embeddings", {
      state: failState(level),
      required: level === "required",
      evidence: `ollama server at ${host} is up, but the embedding model ${REQUIRED_EMBEDDING_MODEL} is not pulled (${models.length} models present)`,
      nextAction: `ollama pull ${REQUIRED_EMBEDDING_MODEL}  (~1.2GB download)`,
      fixAvailable: true,
    });
  }

  const probe = await tryFetchJson(fetchFn, `${host}/api/embed`, {
    timeoutMs: 20_000,
    method: "POST",
    body: { model: REQUIRED_EMBEDDING_MODEL, input: ["aipi doctor probe"] },
  });
  const dimensions = probe.ok ? probe.body?.embeddings?.[0]?.length ?? null : null;
  if (!probe.ok || dimensions == null) {
    return checkResult("env.ollama.embeddings", {
      state: failState(level),
      required: level === "required",
      evidence: `model ${REQUIRED_EMBEDDING_MODEL} is pulled but the embed probe failed (${probe.error ?? "no embeddings returned"})`,
      nextAction: `re-pull the model: ollama pull ${REQUIRED_EMBEDDING_MODEL}`,
      fixAvailable: true,
    });
  }
  if (dimensions !== REQUIRED_EMBEDDING_DIMENSIONS) {
    // Wrong width corrupts the sqlite-vec table the engine builds — always block.
    return checkResult("env.ollama.embeddings", {
      state: "block",
      required: level === "required",
      evidence: `embed probe returned ${dimensions} dimensions; the engine's vector store requires ${REQUIRED_EMBEDDING_DIMENSIONS}`,
      nextAction: `re-pull the canonical model: ollama pull ${REQUIRED_EMBEDDING_MODEL}`,
    });
  }
  return checkResult("env.ollama.embeddings", {
    state: "pass",
    required: level === "required",
    evidence: `ollama at ${host}: ${REQUIRED_EMBEDDING_MODEL} embeds at ${dimensions} dimensions (semantic memory ready)`,
  });
}

function trySpawn(spawnSyncFn, command, args) {
  try {
    const result = spawnSyncFn(command, args, { encoding: "utf8", windowsHide: true, timeout: 15_000, shell: false });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error ?? null };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", error };
  }
}

function describeSpawnFailure(result, command) {
  if (result.error?.code === "ENOENT") return `${command} not found on PATH`;
  if (result.error) return String(result.error.message ?? result.error);
  const stderr = String(result.stderr ?? "").trim().split(/\r?\n/)[0];
  return stderr || `exit ${result.status}`;
}

async function tryFetchJson(fetchFn, url, { timeoutMs, method = "GET", body = null } = {}) {
  if (typeof fetchFn !== "function") return { ok: false, error: "fetch unavailable" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, {
      method,
      signal: controller.signal,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

export function formatEnvironmentReport(report) {
  const lines = [`AIPI environment doctor — ${report.ok ? "OK" : "BLOCKED"} (requirements: ${JSON.stringify(report.requirements)})`];
  for (const check of report.checks) {
    const marker = check.state === "pass" ? "ok " : check.state === "warn" ? "warn" : "BLOCK";
    lines.push(`  [${marker}] ${check.id} — ${check.evidence}`);
    if (check.next_action) lines.push(`         -> ${check.next_action}${check.fix_available ? "  (aipi setup --fix can run this)" : ""}`);
  }
  return lines.join("\n");
}

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultTemplateRoot = path.join(packageRoot, "templates", ".aipi");

const knownProjectRootKeys = [
  ["project", "root"],
  ["project", "path"],
  ["workspace", "root"],
  ["workspace", "path"],
  ["session", "cwd"],
  ["session", "root"],
  ["cwd"],
  ["root"],
  ["workspaceRoot"],
  ["projectRoot"],
];

export function parseInitArgs(args = "") {
  const tokens = String(args)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const options = {
    dryRun: false,
    force: false,
    resetMemory: false,
    noOnboard: false,
    noPullEmbeddings: false,
    targetRoot: null,
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--force") {
      options.force = true;
      continue;
    }
    if (token === "--reset-memory") {
      options.resetMemory = true;
      continue;
    }
    if (token === "--no-onboard") {
      options.noOnboard = true;
      continue;
    }
    if (token === "--no-pull-embeddings") {
      options.noPullEmbeddings = true;
      continue;
    }
    if (token === "--target") {
      const value = tokens[index + 1];
      if (!value) throw new Error("Missing value after --target");
      options.targetRoot = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown /aipi-init option: ${token}`);
  }

  if (options.resetMemory && !options.force) {
    throw new Error("/aipi-init --reset-memory requires --force");
  }

  return options;
}

export function resolveProjectRoot(ctx, explicitTargetRoot) {
  if (explicitTargetRoot) return path.resolve(explicitTargetRoot);

  for (const keyPath of knownProjectRootKeys) {
    let value = ctx;
    for (const key of keyPath) value = value?.[key];
    if (typeof value === "string" && value.trim()) return path.resolve(value);
  }

  return process.cwd();
}

export async function initProject({
  sourceRoot = defaultTemplateRoot,
  targetRoot,
  dryRun = false,
  force = false,
  resetMemory = false,
} = {}) {
  if (!targetRoot) throw new Error("targetRoot is required");

  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot, ".aipi");
  const summary = {
    source,
    target,
    dryRun,
    force,
    resetMemory,
    createdDirectories: 0,
    copiedFiles: 0,
    skippedFiles: 0,
    protectedFiles: 0,
    overwrittenFiles: 0,
  };

  await assertDirectory(source, "AIPI template source");

  const sourceFromTarget = path.relative(target, source);
  if (
    sourceFromTarget === "" ||
    (!sourceFromTarget.startsWith("..") && !path.isAbsolute(sourceFromTarget))
  ) {
    throw new Error("Refusing to initialize from a source inside the target .aipi tree");
  }

  await copyTree(source, target, summary);
  return summary;
}

export function formatInitSummary(summary) {
  const mode = summary.dryRun ? "dry-run" : "applied";
  const overwrite = summary.force
    ? summary.resetMemory
      ? "overwrite enabled, memory reset enabled"
      : "overwrite enabled, project memory protected"
    : "preserved existing files";
  return [
    `AIPI init ${mode}: ${summary.target}`,
    `${summary.copiedFiles} copied, ${summary.overwrittenFiles} overwritten, ` +
      `${summary.skippedFiles} skipped, ${summary.protectedFiles} protected, ` +
      `${summary.createdDirectories} directories created (${overwrite}).`,
  ].join("\n");
}

async function copyTree(sourceDir, targetDir, summary) {
  await ensureDirectory(targetDir, summary);
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      await copyTree(sourcePath, targetPath, summary);
      continue;
    }

    if (!entry.isFile()) continue;

    const exists = await pathExists(targetPath);
    const relTarget = path.relative(summary.target, targetPath);
    if (exists && summary.force && !summary.resetMemory && isProjectMemoryPath(relTarget)) {
      summary.protectedFiles += 1;
      continue;
    }

    if (exists && !summary.force) {
      summary.skippedFiles += 1;
      continue;
    }

    if (!summary.dryRun) {
      await ensureDirectory(path.dirname(targetPath), summary);
      await fs.copyFile(sourcePath, targetPath);
    }

    if (exists) summary.overwrittenFiles += 1;
    else summary.copiedFiles += 1;
  }
}

function isProjectMemoryPath(relPath) {
  const parts = relPath.split(/[\\/]+/);
  return parts[0] === "memory" && parts[1] === "project";
}

async function ensureDirectory(dir, summary) {
  if (await pathExists(dir)) return;
  if (!summary.dryRun) await fs.mkdir(dir, { recursive: true });
  summary.createdDirectories += 1;
}

async function assertDirectory(dir, label) {
  const stat = await fs.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`${label} does not exist: ${dir}`);
}

async function pathExists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

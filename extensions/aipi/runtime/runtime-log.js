import fsPromises from "node:fs/promises";
import path from "node:path";

// Size-capped JSONL appends for everything under .aipi/runtime. Evidence from a
// real project: 50MB of unbounded appends in two weeks (discipline-audit.jsonl
// alone 15MB), all syncing through OneDrive. Rotation is pre-append: when the
// next line would push the live file past maxBytes, generations shift to
// <name>.1..N (oldest dropped) and the live file starts fresh. Every rename is
// best-effort — a rotation race must never drop the event being appended.

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_GENERATIONS = 2;

export function resolveRuntimeLogCaps({ maxBytes = null, maxGenerations = null, env = process.env } = {}) {
  return {
    maxBytes: nonNegativeInteger(maxBytes ?? env?.AIPI_RUNTIME_LOG_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxGenerations: nonNegativeInteger(maxGenerations ?? env?.AIPI_RUNTIME_LOG_MAX_GENERATIONS, DEFAULT_MAX_GENERATIONS),
  };
}

export async function appendRotatedJsonlLine(absPath, entry, {
  maxBytes = null,
  maxGenerations = null,
  env = process.env,
  fsImpl = fsPromises,
} = {}) {
  const caps = resolveRuntimeLogCaps({ maxBytes, maxGenerations, env });
  const line = `${JSON.stringify(entry)}\n`;
  await fsImpl.mkdir(path.dirname(absPath), { recursive: true });
  if (caps.maxBytes > 0) {
    await rotateIfNeeded(absPath, line.length, caps, fsImpl);
  }
  await fsImpl.appendFile(absPath, line);
}

async function rotateIfNeeded(absPath, incomingBytes, caps, fsImpl) {
  let size = 0;
  try {
    size = (await fsImpl.stat(absPath)).size;
  } catch {
    return; // first write, nothing to rotate
  }
  if (size + incomingBytes <= caps.maxBytes) return;

  // Shift generations oldest-first so <name>.1 is always the newest archive.
  try {
    if (caps.maxGenerations <= 0) {
      await fsImpl.rm(absPath, { force: true });
      return;
    }
    await fsImpl.rm(`${absPath}.${caps.maxGenerations}`, { force: true });
    for (let generation = caps.maxGenerations - 1; generation >= 1; generation -= 1) {
      try {
        await fsImpl.rename(`${absPath}.${generation}`, `${absPath}.${generation + 1}`);
      } catch {
        /* generation gap is fine */
      }
    }
    await fsImpl.rename(absPath, `${absPath}.1`);
  } catch {
    /* rotation is best-effort: on any failure the append below still lands */
  }
}

function nonNegativeInteger(value, fallback) {
  if (value == null || value === "") return fallback;
  const numeric = Number.parseInt(String(value), 10);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return numeric;
}

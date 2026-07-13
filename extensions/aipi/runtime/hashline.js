// AIPI loader for the vendored `@oh-my-pi/hashline` package (content-hash
// anchored editing). Mirrors the `pi-subagents.js` pattern: the vendored
// TypeScript source is executed on the Node host via `jiti`, and AIPI's stable
// surface re-exports a small, Node-native API instead of loading the upstream
// package as a separate Pi extension.
//
// Why vendored + jiti: upstream ships TS source (`main: src/index.ts`) and
// declares `engines.bun`. AIPI runs on Node, so the two Bun-only touch points
// (`computeFileHash` in `format.ts`, the disk `NodeFilesystem` in `fs.ts`) are
// patched to Node equivalents in-place — see `vendor/hashline/VENDOR.md`.
//
// hashline binds every edit to a 4-hex, store-internal content hash carried in
// each section header (`[PATH#TAG]`). The `Patcher` re-hashes the live file and
// refuses (or 3-way-merge recovers) a stale anchor before any write, and a
// multi-section patch is preflighted all-or-nothing. See `HASHLINE_PROMPT_PATH`
// for the model-facing edit format.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

export const HASHLINE_PACKAGE = "@oh-my-pi/hashline@16.4.8";
export const HASHLINE_VENDOR_ROOT = "extensions/aipi/runtime/vendor/hashline";
export const HASHLINE_LICENSE = "MIT";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const vendorRoot = path.join(currentDir, "vendor", "hashline");
const indexEntrypoint = path.join(vendorRoot, "src", "index.ts");

/** Absolute path to the model-facing hashline edit-format prompt (`prompt.md`). */
export const HASHLINE_PROMPT_PATH = path.join(vendorRoot, "src", "prompt.md");
/** Absolute path to the formal hashline grammar (`grammar.lark`). */
export const HASHLINE_GRAMMAR_PATH = path.join(vendorRoot, "src", "grammar.lark");

let cachedJiti = null;
let cachedModule = null;

function getJiti() {
  if (!cachedJiti) {
    // Default module cache ON: hashline is stateless library code (unlike the
    // realm-isolated forked-run loader, which needs moduleCache:false).
    cachedJiti = createJiti(import.meta.url, { interopDefault: true });
  }
  return cachedJiti;
}

/**
 * Load the vendored hashline module (all named exports: `Patcher`, `Patch`,
 * `SnapshotStore`, `InMemorySnapshotStore`, `Filesystem`, `InMemoryFilesystem`,
 * `NodeFilesystem`, `computeFileHash`, `MismatchError`, ...). Cached after the
 * first jiti transpile.
 */
export function loadHashline() {
  if (!cachedModule) cachedModule = getJiti()(indexEntrypoint);
  return cachedModule;
}

/** Read the model-facing hashline edit-format prompt. */
export function readHashlinePrompt() {
  return fs.readFileSync(HASHLINE_PROMPT_PATH, "utf8");
}

/**
 * Build a `Patcher` wired to a filesystem and snapshot store. Defaults to the
 * disk-backed `NodeFilesystem` + a fresh `InMemorySnapshotStore`; pass
 * `overrides.fs` (e.g. an owned-file-scoped subclass) or `overrides.snapshots`
 * to compose with AIPI's write guard.
 *
 * @param {{ fs?: object, snapshots?: object, snapshotOptions?: object, blockResolver?: Function }} [overrides]
 * @returns {{ patcher: object, fs: object, snapshots: object, hl: object }}
 */
export function createHashlinePatcher(overrides = {}) {
  const hl = loadHashline();
  const filesystem = overrides.fs ?? new hl.NodeFilesystem();
  const snapshots = overrides.snapshots ?? new hl.InMemorySnapshotStore(overrides.snapshotOptions ?? {});
  const options = { fs: filesystem, snapshots };
  if (overrides.blockResolver) options.blockResolver = overrides.blockResolver;
  const patcher = new hl.Patcher(options);
  return { patcher, fs: filesystem, snapshots, hl };
}

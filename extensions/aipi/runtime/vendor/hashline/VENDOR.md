# hashline vendor snapshot

Source: `can1357/oh-my-pi` (monorepo package `packages/hashline`)
Repository: `https://github.com/can1357/oh-my-pi`
Package: `@oh-my-pi/hashline@16.4.8`
Tarball: `https://registry.npmjs.org/@oh-my-pi/hashline/-/hashline-16.4.8.tgz`
Integrity: `sha512-aJlyuyeK2mqx210UITj9O2ZXFwfLAEHXFtvVT1R2aYaRjUR85oWqh/I/z1owQcMoVs6FuR8a1RE5o1O7rPb+GQ==`
License: MIT, declared in upstream `package.json`.

## What hashline is

Content-hash-anchored editing. Every patch section is headed `[PATH#TAG]`,
where `TAG` is a 4-hex fingerprint of the whole file's normalized text minted by
a `SnapshotStore` on read. Before any write, the `Patcher` re-hashes the live
file: if it no longer matches the tag the edit is refused (or 3-way-merge
recovered), and a multi-section patch is preflighted all-or-nothing. This is the
reliability win AIPI is evaluating for worker write/edit — stale anchors are
rejected instead of silently corrupting a file, and edits ride line-anchored
ops instead of full-file rewrites.

## Copied

This directory contains the npm tarball contents for `@oh-my-pi/hashline@16.4.8`:

- `src/` the hashline core: parser (`input.ts`/`parser.ts`/`tokenizer.ts`),
  applier (`apply.ts`/`block.ts`), patcher (`patcher.ts`), snapshot store
  (`snapshots.ts`), recovery (`recovery.ts`), filesystem seam (`fs.ts`), format
  primitives (`format.ts`), plus `grammar.lark` (formal grammar) and `prompt.md`
  (the model-facing edit format).
- `dist/types/` upstream `.d.ts` declarations, for API reference only (not loaded
  at runtime).
- Upstream `README.md`, `CHANGELOG.md`, and `package.json` for provenance.
- `LICENSE`, added here from the upstream package's declared MIT license because
  the npm tarball does not ship a standalone license file.

## Omitted

- Upstream `test/`, `bench/`, and `tsconfig*.json` not included in the published
  npm tarball / not needed at runtime.

## Runtime loading

AIPI does not load hashline as a separate Pi extension or `npm install` the
package. The stable AIPI surface is `extensions/aipi/runtime/hashline.js`, which
uses `jiti` to execute this vendored TypeScript entrypoint:

`extensions/aipi/runtime/vendor/hashline/src/index.ts`

The two runtime npm dependencies (`diff`, `lru-cache`) are declared directly in
root `package.json` and resolved from the host `node_modules`.

## AIPI local patches (MUST be re-applied on every re-sync)

Upstream targets the Bun runtime (`engines.bun`, `main: src/index.ts`). AIPI runs
on Node, so the two Bun-only touch points are patched in place. Replacing this
directory with a fresh tarball silently drops these; re-apply each one and keep
this list current:

1. `src/format.ts` — `computeFileHash` replaces `Bun.hash.xxHash32(...)` with a
   pure-JS 32-bit FNV-1a + avalanche folded to 16 bits. The tag is store-internal
   ("not meaningful outside that store"), so only determinism matters; the 4-hex
   tag shape is preserved. Guarded by the `computeFileHash` assertions in
   `tools/test-hashline.mjs`.
2. `src/fs.ts` — `NodeFilesystem` replaces `Bun.file` / `Bun.write` with
   `node:fs/promises` (already imported in the module). Behavior preserved:
   UTF-8 decode, `NotFoundError` on ENOENT, patcher owns BOM/line-ending work.
   Guarded by the disk round-trip in `tools/test-hashline.mjs`.

## Re-sync procedure

1. Review the target upstream release and its changelog.
2. Run `npm pack @oh-my-pi/hashline@<version> --json`.
3. Verify the tarball integrity from npm metadata.
4. Replace this directory with the new tarball contents (`src/`, `dist/`,
   `README.md`, `CHANGELOG.md`, `package.json`).
5. Restore this `VENDOR.md` and `LICENSE`, and re-apply every patch in "AIPI
   local patches" above (re-grep the tree for `Bun.` — only the two patch
   comments should remain).
6. Update pinned `diff` / `lru-cache` versions in root `package.json` if the new
   upstream `package.json` bumps them.
7. Run `npm install --ignore-scripts --legacy-peer-deps`.
8. Run `npm run test:hashline` and the full `npm test`.

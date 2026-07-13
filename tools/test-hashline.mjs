// Verifies the vendored `@oh-my-pi/hashline` package loads and runs on the Node
// host (the two Bun-only touch points are patched to Node — see
// vendor/hashline/VENDOR.md) and that its content-hash-anchored patching
// behaves: happy-path SWAP/INS/DEL, stale-anchor rejection, all-or-nothing
// multi-section apply, and the create-guard.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadHashline,
  createHashlinePatcher,
  readHashlinePrompt,
  HASHLINE_PACKAGE,
  HASHLINE_PROMPT_PATH,
} from "../extensions/aipi/runtime/hashline.js";

const hl = loadHashline();

// --- the vendored module loads via jiti and exposes the documented API ---
{
  for (const name of [
    "Patcher",
    "Patch",
    "SnapshotStore",
    "InMemorySnapshotStore",
    "Filesystem",
    "InMemoryFilesystem",
    "NodeFilesystem",
    "computeFileHash",
    "MismatchError",
  ]) {
    assert.equal(typeof hl[name], "function", `hashline export ${name} must be a constructor/function`);
  }
  assert.equal(HASHLINE_PACKAGE, "@oh-my-pi/hashline@16.4.8");
  assert.ok(readHashlinePrompt().includes("[PATH#TAG]"), "prompt.md must document the [PATH#TAG] header");
  assert.ok(HASHLINE_PROMPT_PATH.endsWith("prompt.md"));
}

// --- computeFileHash: deterministic, 4-uppercase-hex, sensitive to content ---
{
  const a = hl.computeFileHash("alpha\nbeta\ngamma\n");
  const b = hl.computeFileHash("alpha\nbeta\ngamma\n");
  const c = hl.computeFileHash("alpha\nBETA\ngamma\n");
  assert.equal(a, b, "same content mints the same tag");
  assert.match(a, /^[0-9A-F]{4}$/, "tag is 4 uppercase hex");
  assert.notEqual(a, c, "content change mints a different tag");
  // Trailing-whitespace normalization: display-trimmed / CRLF variants fuse.
  assert.equal(hl.computeFileHash("x\ny\n"), hl.computeFileHash("x  \ny\t\n"), "trailing ws normalized before hashing");
}

// --- helper: build a single-section patch string ---
function section(filePath, tag, body) {
  return `[${filePath}#${tag}]\n${body}`;
}

// --- happy path (SWAP) on the in-memory filesystem ---
{
  const content = "alpha\nbeta\ngamma\n";
  const imfs = new hl.InMemoryFilesystem([["foo.txt", content]]);
  const { patcher, snapshots } = createHashlinePatcher({ fs: imfs });
  const tag = snapshots.record("foo.txt", content); // snapshot-on-read
  assert.equal(tag, hl.computeFileHash(content));

  const patch = hl.Patch.parse(section("foo.txt", tag, "SWAP 2.=2:\n+BETA"));
  const result = await patcher.apply(patch);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].op, "update");
  const after = imfs.get("foo.txt");
  assert.equal(after, "alpha\nBETA\ngamma\n", "line 2 replaced, neighbors preserved");
  assert.notEqual(result.sections[0].fileHash, tag, "a fresh tag is minted for the post-edit content");
  assert.equal(result.sections[0].fileHash, hl.computeFileHash(after));
}

// --- INS.POST inserts after an anchor without touching kept lines ---
{
  const content = "alpha\nbeta\ngamma\n";
  const imfs = new hl.InMemoryFilesystem([["foo.txt", content]]);
  const { patcher, snapshots } = createHashlinePatcher({ fs: imfs });
  const tag = snapshots.record("foo.txt", content);
  await patcher.apply(hl.Patch.parse(section("foo.txt", tag, "INS.POST 1:\n+inserted")));
  assert.equal(imfs.get("foo.txt"), "alpha\ninserted\nbeta\ngamma\n");
}

// --- DEL removes the anchored line ---
{
  const content = "alpha\nbeta\ngamma\n";
  const imfs = new hl.InMemoryFilesystem([["foo.txt", content]]);
  const { patcher, snapshots } = createHashlinePatcher({ fs: imfs });
  const tag = snapshots.record("foo.txt", content);
  await patcher.apply(hl.Patch.parse(section("foo.txt", tag, "DEL 2")));
  assert.equal(imfs.get("foo.txt"), "alpha\ngamma\n");
}

// --- stale-anchor rejection: a tag that does not match the live content and was
//     never recorded cannot be recovered, so an anchored edit is refused and the
//     file is left untouched (the core reliability win over raw string edits) ---
{
  const content = "alpha\nbeta\ngamma\n";
  const imfs = new hl.InMemoryFilesystem([["foo.txt", content]]);
  const { patcher } = createHashlinePatcher({ fs: imfs });
  const realTag = hl.computeFileHash(content);
  const staleTag = realTag === "0000" ? "1111" : "0000";
  await assert.rejects(
    () => patcher.apply(hl.Patch.parse(section("foo.txt", staleTag, "SWAP 2.=2:\n+BETA"))),
    (err) => err instanceof hl.MismatchError,
    "a stale anchored edit must throw MismatchError",
  );
  assert.equal(imfs.get("foo.txt"), content, "the file is unchanged after a rejected edit");
}

// --- all-or-nothing: a multi-section patch where one section is stale writes
//     NEITHER file (every section is preflighted before any commit) ---
{
  const a = "a1\na2\na3\n";
  const b = "b1\nb2\nb3\n";
  const imfs = new hl.InMemoryFilesystem([
    ["a.txt", a],
    ["b.txt", b],
  ]);
  const { patcher } = createHashlinePatcher({ fs: imfs });
  const tagA = hl.computeFileHash(a);
  const staleB = "0000" === hl.computeFileHash(b) ? "1111" : "0000";
  const patch = hl.Patch.parse(
    `${section("a.txt", tagA, "SWAP 1.=1:\n+A1")}\n${section("b.txt", staleB, "SWAP 1.=1:\n+B1")}`,
  );
  await assert.rejects(() => patcher.apply(patch), "a batch with a stale section must reject as a whole");
  assert.equal(imfs.get("a.txt"), a, "the valid section is NOT written when a sibling section fails preflight");
  assert.equal(imfs.get("b.txt"), b, "the stale section is not written");
}

// --- create-guard: hashline edits existing files only; a missing target is
//     refused with guidance to use the write tool ---
{
  const imfs = new hl.InMemoryFilesystem();
  const { patcher } = createHashlinePatcher({ fs: imfs });
  await assert.rejects(
    () => patcher.apply(hl.Patch.parse(section("new.txt", "0000", "INS.HEAD:\n+hello"))),
    /File not found/,
    "editing a non-existent file must be refused",
  );
}

// --- disk round-trip on the real NodeFilesystem (proves the Bun->Node fs patch) ---
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-hashline-"));
  const prevCwd = process.cwd();
  try {
    process.chdir(dir);
    const content = "one\ntwo\nthree\n";
    await fs.writeFile("disk.txt", content);
    const { patcher, snapshots, fs: nodeFs } = createHashlinePatcher(); // real NodeFilesystem
    assert.ok(nodeFs instanceof hl.NodeFilesystem);
    const canonical = nodeFs.canonicalPath("disk.txt");
    const tag = snapshots.record(canonical, content);
    const result = await patcher.apply(hl.Patch.parse(section("disk.txt", tag, "SWAP 2.=2:\n+TWO")));
    assert.equal(result.sections[0].op, "update");
    assert.equal(await fs.readFile("disk.txt", "utf8"), "one\nTWO\nthree\n", "the edit landed on disk");
  } finally {
    process.chdir(prevCwd);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

console.log("hashline: ok");

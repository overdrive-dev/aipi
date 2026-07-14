// Verifies the flag-gated hashline worker tools: config gating in
// createAipiWorkerAgentConfig, and the aipi_read_hashline / aipi_edit child
// tools enforcing owned-file scope + content-hash-anchored (stale-rejecting)
// edits against a real temp project.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import registerAipiHashlineEditChild from "../extensions/aipi/runtime/aipi-hashline-edit-child.js";
import { loadHashline } from "../extensions/aipi/runtime/hashline.js";
import {
  createAipiWorkerAgentConfig,
  HASHLINE_WORKER_EDIT_ENABLED,
} from "../extensions/aipi/runtime/pi-subagents.js";

const hl = loadHashline();

function collectTools(register) {
  const tools = {};
  register({ registerTool: (def) => { tools[def.name] = def; } });
  return tools;
}
const text = (result) => (result?.content ?? []).map((part) => part.text).join("\n");

// --- default is ON: every worker gets hashline editing with no param ---
{
  assert.equal(HASHLINE_WORKER_EDIT_ENABLED, true, "hashline worker editing ships ON by default");
  const on = createAipiWorkerAgentConfig({});
  assert.ok(on.tools.includes("aipi_read_hashline"), "default: aipi_read_hashline listed");
  assert.ok(on.tools.includes("aipi_edit"), "default: aipi_edit listed");
  assert.ok(
    on.tools.some((tool) => String(tool).includes("aipi-hashline-edit-child")),
    "default: hashline extension path loaded",
  );
  assert.match(on.systemPrompt, /hashline flow/, "default: prompt teaches the hashline flow");
  assert.match(on.systemPrompt, /\[PATH#TAG\]/, "default: prompt embeds the hashline format");
  // aipi_edit has no tree-sitter block resolver, so the prompt must OVERRIDE the format doc's block-op guidance.
  assert.match(on.systemPrompt, /block ops.*NOT available/i, "default: prompt disables the unsupported block ops");
  assert.ok(on.tools.includes("write"), "guarded write always present");
  // Fanout (shell-less) workers also get it — aipi_edit self-guards owned scope.
  const fanout = createAipiWorkerAgentConfig({ allowShell: false });
  assert.ok(fanout.tools.includes("aipi_edit"), "default: fanout worker also gets aipi_edit");
  assert.ok(!fanout.tools.includes("aipi_shell"), "fanout worker still has no shell");
}

// --- explicit opt-out (hashlineEdit:false) still strips the tools + prompt for a specific spawn ---
{
  const off = createAipiWorkerAgentConfig({ hashlineEdit: false });
  assert.ok(!off.tools.includes("aipi_edit"), "opt-out: no aipi_edit tool");
  assert.ok(!off.tools.includes("aipi_read_hashline"), "opt-out: no aipi_read_hashline tool");
  assert.ok(
    !off.tools.some((tool) => String(tool).includes("aipi-hashline-edit-child")),
    "opt-out: hashline extension not loaded",
  );
  assert.ok(!/hashline flow/.test(off.systemPrompt), "opt-out: no hashline prompt block");
  assert.ok(off.tools.includes("write"), "guarded write still present");
}

// --- the child tools, exercised against a real temp project with env scope ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-hl-worker-"));
  const saved = {
    root: process.env.AIPI_SUBAGENTS_PROJECT_ROOT,
    owned: process.env.AIPI_SUBAGENTS_OWNED_FILES,
    id: process.env.AIPI_SUBAGENTS_AGENT_ID,
    scope: process.env.AIPI_SUBAGENTS_WRITE_SCOPE,
  };
  try {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    const fooBody = "alpha\nbeta\ngamma\n";
    await fs.writeFile(path.join(root, "src", "foo.txt"), fooBody);
    await fs.writeFile(path.join(root, "src", "stale.txt"), "x\ny\nz\n");
    await fs.writeFile(path.join(root, "src", "other.txt"), "not\nowned\n"); // exists, NOT owned

    process.env.AIPI_SUBAGENTS_PROJECT_ROOT = root;
    process.env.AIPI_SUBAGENTS_OWNED_FILES = JSON.stringify(["src/foo.txt", "src/stale.txt", "src/new.txt"]);
    process.env.AIPI_SUBAGENTS_AGENT_ID = "worker-x";
    process.env.AIPI_SUBAGENTS_WRITE_SCOPE = "artifacts";

    const tools = collectTools(registerAipiHashlineEditChild);
    assert.ok(tools.aipi_read_hashline && tools.aipi_edit, "child registers both tools");

    // read renders [PATH#TAG] + numbered rows, and the TAG matches the content hash.
    const readRes = await tools.aipi_read_hashline.execute("r1", { path: "src/foo.txt" });
    assert.ok(!readRes.isError, "read succeeds for an in-root file");
    const readOut = text(readRes);
    const tag = hl.computeFileHash(fooBody);
    assert.ok(readOut.startsWith(`[src/foo.txt#${tag}]`), "read header carries the content-hash tag");
    assert.match(readOut, /\n2:beta/, "read shows numbered lines");

    // a valid, correctly-anchored edit lands on disk and reports a fresh tag.
    const editRes = await tools.aipi_edit.execute("e1", {
      patch: `[src/foo.txt#${tag}]\nSWAP 2.=2:\n+BETA`,
    });
    assert.ok(!editRes.isError, `valid edit should apply: ${text(editRes)}`);
    assert.equal(await fs.readFile(path.join(root, "src", "foo.txt"), "utf8"), "alpha\nBETA\ngamma\n");
    assert.match(text(editRes), /update src\/foo\.txt -> \[src\/foo\.txt#[0-9A-F]{4}\]/, "reports the new anchor");

    // an edit to a file OUTSIDE the owned scope is refused, and the file is untouched.
    const scopeRes = await tools.aipi_edit.execute("e2", {
      patch: `[src/other.txt#0000]\nSWAP 1.=1:\n+hacked`,
    });
    assert.ok(scopeRes.isError, "out-of-scope edit must be refused");
    assert.match(text(scopeRes), /owned-file scope/, "refusal cites owned-file scope");
    assert.equal(await fs.readFile(path.join(root, "src", "other.txt"), "utf8"), "not\nowned\n", "unowned file untouched");

    // a stale anchor (tag != live content) is rejected instead of corrupting the file.
    const staleBody = "x\ny\nz\n";
    const staleTag = hl.computeFileHash(staleBody) === "0000" ? "1111" : "0000";
    const staleRes = await tools.aipi_edit.execute("e3", {
      patch: `[src/stale.txt#${staleTag}]\nSWAP 2.=2:\n+Y`,
    });
    assert.ok(staleRes.isError, "stale-anchored edit must be rejected");
    assert.equal(await fs.readFile(path.join(root, "src", "stale.txt"), "utf8"), staleBody, "stale target untouched");

    // hashline edits existing files only: an owned-but-missing file is refused with write guidance.
    const createRes = await tools.aipi_edit.execute("e4", {
      patch: `[src/new.txt#0000]\nINS.HEAD:\n+hello`,
    });
    assert.ok(createRes.isError, "editing a non-existent file is refused");
    assert.match(text(createRes), /not found|write/i, "refusal points to the write tool");
  } finally {
    for (const [key, value] of Object.entries({
      AIPI_SUBAGENTS_PROJECT_ROOT: saved.root,
      AIPI_SUBAGENTS_OWNED_FILES: saved.owned,
      AIPI_SUBAGENTS_AGENT_ID: saved.id,
      AIPI_SUBAGENTS_WRITE_SCOPE: saved.scope,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

// --- the exact ops the format prompt teaches, exercised end-to-end through the real worker tools: the plain
//     line ops apply; the tree-sitter block ops are cleanly rejected (aipi wires no block resolver) ---
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-hl-prompt-"));
  const saved = {
    root: process.env.AIPI_SUBAGENTS_PROJECT_ROOT,
    owned: process.env.AIPI_SUBAGENTS_OWNED_FILES,
    id: process.env.AIPI_SUBAGENTS_AGENT_ID,
    scope: process.env.AIPI_SUBAGENTS_WRITE_SCOPE,
  };
  try {
    // The prompt.md greet.py example, verbatim.
    const greet = 'def greet(name):\n    msg = "Hello, " + name\n    print(msg)\ngreet("world")\n';
    await fs.writeFile(path.join(root, "greet.py"), greet);
    process.env.AIPI_SUBAGENTS_PROJECT_ROOT = root;
    process.env.AIPI_SUBAGENTS_OWNED_FILES = JSON.stringify(["greet.py"]);
    process.env.AIPI_SUBAGENTS_AGENT_ID = "worker-prompt";
    process.env.AIPI_SUBAGENTS_WRITE_SCOPE = "artifacts";
    const tools = collectTools(registerAipiHashlineEditChild);

    // The tag from aipi_read_hashline is what the model would anchor on.
    const readOut = text(await tools.aipi_read_hashline.execute("r", { path: "greet.py" }));
    const tag = readOut.match(/\[greet\.py#([0-9A-F]{4})\]/)[1];

    // INS.POST (prompt example: insert a guard after line 1).
    const ins = await tools.aipi_edit.execute("i", { patch: `[greet.py#${tag}]\nINS.POST 1:\n+    if not name: name = "stranger"` });
    assert.ok(!ins.isError, `INS.POST applies: ${text(ins)}`);
    assert.match(await fs.readFile(path.join(root, "greet.py"), "utf8"), /if not name: name = "stranger"/);

    // SWAP over a whole construct's line range (the aipi-supported alternative to SWAP.BLK).
    const foo = "line1\nline2\nline3\n";
    await fs.writeFile(path.join(root, "greet.py"), foo);
    const swap = await tools.aipi_edit.execute("s", { patch: `[greet.py#${hl.computeFileHash(foo)}]\nSWAP 1.=2:\n+A\n+B\n+C` });
    assert.ok(!swap.isError, `SWAP applies: ${text(swap)}`);
    assert.equal(await fs.readFile(path.join(root, "greet.py"), "utf8"), "A\nB\nC\nline3\n");

    // DEL (prompt example).
    const cur = await fs.readFile(path.join(root, "greet.py"), "utf8");
    const del = await tools.aipi_edit.execute("d", { patch: `[greet.py#${hl.computeFileHash(cur)}]\nDEL 2` });
    assert.ok(!del.isError, `DEL applies: ${text(del)}`);
    assert.equal(await fs.readFile(path.join(root, "greet.py"), "utf8"), "A\nC\nline3\n");

    // Block ops are unsupported here (no tree-sitter resolver) — the error is clear, not a corruption.
    const cur2 = await fs.readFile(path.join(root, "greet.py"), "utf8");
    const blk = await tools.aipi_edit.execute("b", { patch: `[greet.py#${hl.computeFileHash(cur2)}]\nSWAP.BLK 1:\n+X` });
    assert.ok(blk.isError, "SWAP.BLK is rejected (aipi wires no block resolver)");
    assert.match(text(blk), /block|not available|resolver/i, "the block-op rejection is explicit");
    assert.equal(await fs.readFile(path.join(root, "greet.py"), "utf8"), cur2, "a rejected block op leaves the file untouched");
  } finally {
    for (const [key, value] of Object.entries({
      AIPI_SUBAGENTS_PROJECT_ROOT: saved.root,
      AIPI_SUBAGENTS_OWNED_FILES: saved.owned,
      AIPI_SUBAGENTS_AGENT_ID: saved.id,
      AIPI_SUBAGENTS_WRITE_SCOPE: saved.scope,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

console.log("hashline-worker: ok");

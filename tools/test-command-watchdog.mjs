import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerAipiRuntimeTools, AIPI_RUNTIME_TOOL_NAMES } from "../extensions/aipi/runtime/aipi-tools.js";
import {
  detectInteractiveTrap,
  isAmbiguousLongRunningCommand,
  piStreamingUpdate,
  runGuardedCommand,
} from "../extensions/aipi/runtime/command-watchdog.js";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aipi-command-watchdog-"));

try {
  assert.equal(AIPI_RUNTIME_TOOL_NAMES.includes("aipi_guarded_bash"), true);

  const traps = [
    ["python3 -", "python_repl"],
    ["python", "python_repl"],
    ["node", "node_repl"],
    ["psql mydb", "psql_interactive"],
    ["git rebase -i HEAD~2", "git_rebase_interactive"],
    ["git commit", "git_commit_editor"],
  ];
  for (const [command, pattern] of traps) {
    const result = detectInteractiveTrap(command);
    assert.equal(result.action, "refuse", command);
    assert.equal(result.pattern, pattern, command);
    assert.match(result.recommendation, /\S/);
  }
  assert.equal(detectInteractiveTrap("psql -c \"select 1\"").action, "allow");
  assert.equal(detectInteractiveTrap("git commit -m \"ok\"").action, "allow");
  assert.equal(
    detectInteractiveTrap("python3 - << 'PY'\nprint(1)\nPY", { platform: "win32" }).pattern,
    "python_stdin_heredoc_windows",
  );
  const heavySearch = detectInteractiveTrap("grep -rn \"login\" . --include=*.js | grep -v node_modules | head");
  assert.equal(heavySearch.action, "refuse");
  assert.equal(heavySearch.pattern, "recursive_search_heavy_dirs");
  assert.match(heavySearch.recommendation, /--glob|exclude/);
  assert.equal(
    detectInteractiveTrap("grep -rn --exclude-dir=node_modules \"login\" .").pattern,
    "recursive_search_heavy_dirs",
  );
  assert.equal(detectInteractiveTrap("grep -rn --exclude-dir={node_modules,.git,.aipi} \"login\" .").action, "allow");
  const internalSearch = detectInteractiveTrap("grep -rn \"no executable adapter is configured\" . --include=*.js");
  assert.equal(internalSearch.action, "refuse");
  assert.equal(internalSearch.pattern, "aipi_internal_search");
  assert.match(internalSearch.recommendation, /extensions\/aipi\/runtime|aipi_retrieve/);
  assert.equal(isAmbiguousLongRunningCommand("npm test"), true);
  assert.equal(isAmbiguousLongRunningCommand(nodeCommand("setInterval(()=>{},1000)")), false);

  const refused = await runGuardedCommand({
    projectRoot: tempRoot,
    cwd: tempRoot,
    command: "node",
    minRuntimeMs: 10,
    silenceTimeoutMs: 20,
    hardCapMs: 200,
  });
  assert.equal(refused.status, "refused");
  assert.equal(refused.verdict, "interactive_trap");
  assert.equal(refused.diagnose_note.schema, "aipi.command-watchdog-diagnose.v1");

  const hang = await runGuardedCommand({
    projectRoot: tempRoot,
    cwd: tempRoot,
    command: nodeCommand("setInterval(()=>{},1000);"),
    minRuntimeMs: 20,
    silenceTimeoutMs: 60,
    hardCapMs: 1_000,
    killGraceMs: 100,
  });
  assert.equal(hang.status, "killed");
  assert.equal(hang.verdict, "stuck");
  assert.equal(hang.killed, true);
  assert.equal(hang.diagnose_note.schema, "aipi.command-watchdog-diagnose.v1");
  assert.equal(await eventuallyDead(hang.pid), true);

  const outputting = await runGuardedCommand({
    projectRoot: tempRoot,
    cwd: tempRoot,
    command: nodeCommand("let i=0;const timer=setInterval(function(){console.log('tick '+(++i));if(i===5){clearInterval(timer);setTimeout(function(){process.exit(0);},20);}},30);"),
    minRuntimeMs: 120,
    silenceTimeoutMs: 1_500,
    hardCapMs: 4_000,
    killGraceMs: 100,
  });
  assert.equal(outputting.status, "completed");
  assert.equal(outputting.killed, false);
  assert.match(outputting.stdout, /tick 5/);

  let nonAmbiguousChecks = 0;
  const nonAmbiguous = await runGuardedCommand({
    projectRoot: tempRoot,
    cwd: tempRoot,
    command: nodeCommand("setInterval(()=>{},1000);"),
    minRuntimeMs: 20,
    silenceTimeoutMs: 50,
    hardCapMs: 1_000,
    killGraceMs: 100,
    checkAgent: async () => {
      nonAmbiguousChecks += 1;
      return { verdict: "working", reason: "should not run" };
    },
  });
  assert.equal(nonAmbiguous.status, "killed");
  assert.equal(nonAmbiguousChecks, 0);

  let stuckChecks = 0;
  const ambiguousStuck = await runGuardedCommand({
    projectRoot: tempRoot,
    cwd: tempRoot,
    command: `${nodeCommand("setInterval(()=>{},1000);", ["npm test"])}`,
    minRuntimeMs: 20,
    silenceTimeoutMs: 50,
    hardCapMs: 1_000,
    killGraceMs: 100,
    checkAgent: async (input) => {
      stuckChecks += 1;
      assert.equal(input.schema, "aipi.command-watchdog-check.v1");
      assert.match(input.command, /npm test/);
      return { verdict: "stuck", reason: "fixture silent and waiting" };
    },
  });
  assert.equal(ambiguousStuck.status, "killed");
  assert.equal(stuckChecks, 1);
  assert.match(ambiguousStuck.reason, /check_agent_stuck/);

  let workingChecks = 0;
  const ambiguousWorking = await runGuardedCommand({
    projectRoot: tempRoot,
    cwd: tempRoot,
    command: `${nodeCommand("setTimeout(() => process.exit(0), 170);", ["npm test"])}`,
    minRuntimeMs: 20,
    silenceTimeoutMs: 50,
    hardCapMs: 1_000,
    killGraceMs: 100,
    checkAgent: async () => {
      workingChecks += 1;
      return { verdict: "working", reason: "fixture build still progressing" };
    },
  });
  assert.equal(ambiguousWorking.status, "completed");
  assert.equal(ambiguousWorking.killed, false);
  assert.equal(workingChecks > 0, true);

  const childPidPath = path.join(tempRoot, "child.pid");
  const tree = await runGuardedCommand({
    projectRoot: tempRoot,
    cwd: tempRoot,
    command: nodeCommand("const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(function(){},1000);'],{stdio:'ignore'});fs.writeFileSync(process.argv[1],String(child.pid));setInterval(function(){},1000);", [childPidPath]),
    minRuntimeMs: 300,
    silenceTimeoutMs: 500,
    hardCapMs: 2_000,
    killGraceMs: 150,
  });
  assert.equal(tree.status, "killed");
  const childPid = Number(await fs.readFile(childPidPath, "utf8"));
  assert.equal(Number.isInteger(childPid) && childPid > 0, true);
  assert.equal(await eventuallyDead(childPid), true);

  const traceLog = await fs.readFile(path.join(tempRoot, ".aipi", "runtime", "command-watchdog.jsonl"), "utf8");
  assert.match(traceLog, /"schema":"aipi.command-watchdog.v1"/);
  assert.match(traceLog, /"status":"killed"/);

  const registeredTools = new Map();
  registerAipiRuntimeTools({
    registerTool(tool) {
      registeredTools.set(tool.name, tool);
    },
  }, { projectRootResolver: () => tempRoot });
  assert.equal(registeredTools.has("aipi_guarded_bash"), true);
  const toolResult = await registeredTools.get("aipi_guarded_bash").execute(
    "tool-1",
    {
      command: nodeCommand("console.log('guarded tool ok');"),
      cwd: tempRoot,
      min_runtime_ms: 10,
      silence_timeout_ms: 1_500,
      hard_cap_ms: 4_000,
    },
    null,
    null,
    { cwd: tempRoot },
  );
  const parsedToolResult = JSON.parse(toolResult.content[0].text);
  assert.equal(parsedToolResult.status, "completed");
  assert.match(parsedToolResult.stdout, /guarded tool ok/);

  // piStreamingUpdate adapts raw {type,text} chunks into Pi's partial-result {content:[...]} shape. A chunk
  // without `content` crashes the host renderer (getTextOutput -> result.content.filter) — an uncaught
  // TypeError that took the whole session down on a verbose run. Every streamed update MUST carry content.
  {
    const partials = [];
    const adapted = piStreamingUpdate((partial) => partials.push(partial));
    adapted({ type: "stdout", text: "line 1\n" });
    adapted({ type: "stderr", text: "warn\n" });
    assert.equal(partials.length, 2);
    for (const p of partials) {
      assert.ok(Array.isArray(p.content), "every streamed partial carries a content array");
      assert.equal(p.content[0].type, "text");
    }
    // Accumulates (so the live display grows) — the 2nd partial includes the 1st.
    assert.match(partials[1].content[0].text, /line 1[\s\S]*warn/);
    // Tail-capped so a flood of output can't grow unbounded in the closure.
    const flood = piStreamingUpdate((p) => partials.push(p));
    flood({ type: "stdout", text: "x".repeat(40_000) });
    assert.ok(partials.at(-1).content[0].text.length <= 32_768, "streamed display is tail-capped");
    // No host onUpdate -> null (forked/headless: runGuardedCommand simply won't stream).
    assert.equal(piStreamingUpdate(null), null);
    assert.equal(piStreamingUpdate(undefined), null);
    // A throwing host onUpdate is swallowed (a render failure must not break the command).
    const safe = piStreamingUpdate(() => { throw new Error("render boom"); });
    safe({ type: "stdout", text: "hi" }); // must not throw
  }

  // Regression: a real guarded command streams content-shaped partials, never a bare {type,text}.
  {
    const streamed = [];
    await runGuardedCommand({
      projectRoot: tempRoot,
      command: process.platform === "win32" ? "echo streamed-line" : "echo streamed-line",
      minRuntimeMs: 0,
      onUpdate: piStreamingUpdate((p) => streamed.push(p)),
    });
    for (const p of streamed) {
      assert.ok(Array.isArray(p?.content), "guarded command streams only content-shaped partials");
    }
  }

  console.log("AIPI_COMMAND_WATCHDOG_TEST_OK");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function nodeCommand(source, args = []) {
  return [quoteShell(process.execPath), "-e", quoteShell(source), ...args.map(quoteShell)].join(" ");
}

function quoteShell(value) {
  return JSON.stringify(String(value));
}

async function eventuallyDead(pid, timeoutMs = 2_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

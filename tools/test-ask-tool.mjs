import assert from "node:assert/strict";
import { registerAskTool, runAskTool } from "../extensions/aipi/runtime/ask-tool.js";

const parse = (result) => JSON.parse(result.content[0].text);

// --- guards ---
assert.equal(parse(await runAskTool({ question: "q", options: ["a"] }, {})).ok, false, "needs >= 2 options");
assert.equal(parse(await runAskTool({ question: "", options: ["a", "b"] }, {})).ok, false, "needs a question");

// --- headless fallback: no dialog-capable UI -> hand the question back as data ---
const headless = parse(await runAskTool({ question: "Escolha", options: ["A", "B"] }, { hasUI: false }));
assert.equal(headless.ok, true);
assert.equal(headless.interactive, false);
assert.deepEqual(headless.options, ["A", "B"]);

// --- interactive: the native selector's pick is returned ---
{
  const seen = [];
  const ctx = { hasUI: true, ui: { select: async (question, opts) => { seen.push({ question, opts }); return opts[1]; } } };
  const res = parse(await runAskTool(
    { question: "Até quando aceitar checkout tardio?", options: ["A — 30 dias", "B — sem limite", "C — 7 dias"] },
    ctx,
  ));
  assert.equal(res.ok, true);
  assert.equal(res.answered, true);
  assert.equal(res.answer, "B — sem limite", "returns the chosen option");
  assert.equal(seen[0].opts.length, 3, "all options passed to the selector");
}

// --- recommended option is marked in the selector but maps back to the plain original ---
{
  const ctx = { hasUI: true, ui: { select: async (_q, opts) => opts.find((o) => o.includes("recomendado")) } };
  const res = parse(await runAskTool({ question: "q", options: ["A", "B", "C"], recommended: "A" }, ctx));
  assert.equal(res.answered, true);
  assert.equal(res.answer, "A", "the recommended mark is stripped on the way back");
}

// --- a dismissed selector -> answered:false (not an error) ---
{
  const ctx = { hasUI: true, ui: { select: async () => undefined } };
  const res = parse(await runAskTool({ question: "q", options: ["A", "B"] }, ctx));
  assert.equal(res.ok, true);
  assert.equal(res.answered, false);
}

// --- registration + guidelines + execute delegates to runAskTool ---
{
  const tools = new Map();
  registerAskTool({ registerTool: (def) => tools.set(def.name, def) });
  const tool = tools.get("aipi_ask");
  assert.ok(tool, "aipi_ask registered");
  assert.ok((tool.promptGuidelines ?? []).length >= 1, "carries the model nudge");
  const res = parse(await tool.execute("id", { question: "q", options: ["A", "B"] }, null, null, { hasUI: false }));
  assert.equal(res.interactive, false);
}

console.log("AIPI_ASK_TOOL_TEST_OK");

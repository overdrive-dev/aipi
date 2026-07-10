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

// --- free-text escape hatch: the selector always offers a free-text option when the UI has input ---
{
  const seen = [];
  const ctx = {
    hasUI: true,
    ui: {
      select: async (_q, opts) => { seen.push(opts); return opts[0]; },
      input: async () => "",
    },
  };
  await runAskTool({ question: "q", options: ["A", "B"] }, ctx);
  assert.ok(seen[0].some((o) => /texto livre/.test(o)), "free-text option is offered when input is available");
}

// --- picking free text opens an input and returns the typed answer with free_text:true ---
{
  const inputs = [];
  const ctx = {
    hasUI: true,
    ui: {
      select: async (_q, opts) => opts.find((o) => o.includes("texto livre")),
      input: async (question, placeholder) => { inputs.push({ question, placeholder }); return "prefiro uma abordagem híbrida"; },
    },
  };
  const res = parse(await runAskTool({ question: "Qual estratégia?", options: ["A — X", "B — Y"] }, ctx));
  assert.equal(res.answered, true);
  assert.equal(res.free_text, true);
  assert.equal(res.answer, "prefiro uma abordagem híbrida", "the typed answer is returned verbatim");
  assert.equal(inputs.length, 1, "free text opened a text input");
}

// --- with NO input capability, no free-text option is appended (pick-only) ---
{
  const seen = [];
  const ctx = { hasUI: true, ui: { select: async (_q, opts) => { seen.push(opts); return opts[0]; } } };
  await runAskTool({ question: "q", options: ["A", "B"] }, ctx);
  assert.ok(!seen[0].some((o) => /texto livre/.test(o)), "no free-text option without a text input");
}

console.log("AIPI_ASK_TOOL_TEST_OK");

// Interactive question tool. Surfaces a multiple-choice question through the native TUI selector
// (ctx.ui.select) instead of letting the model render A/B/C options as prose in the chat. The tool's execute
// ctx is the full ExtensionContext, so ui.select + hasUI are available. When the UI is non-interactive
// (headless / print), the tool hands the question back so the model can ask in prose. Returns the picked option.

const RECOMMENDED_MARK = "  ⭐ recomendado";

export function registerAskTool(pi) {
  pi.registerTool({
    name: "aipi_ask",
    description:
      "Ask the USER a multiple-choice question through the interactive TUI selector instead of writing the options as prose in the chat. Use it whenever the user must choose between options — a plan discovery question, an ambiguous requirement, or confirming a recommendation. Returns the option the user picked.",
    promptSnippet: "aipi_ask - ask the user an A/B/C question via the native TUI selector; returns their pick.",
    promptGuidelines: [
      "When you need the user to choose between options (a discovery question, an ambiguous decision, a recommendation to confirm), call aipi_ask with the question + options INSTEAD of writing an A/B/C list as prose. Put your recommended option in `recommended` so it is marked in the selector.",
      "Only fall back to asking in prose when aipi_ask reports the UI is unavailable, or when the answer is genuinely free-form (then ask a plain open question instead).",
    ],
    parameters: {
      type: "object",
      required: ["question", "options"],
      properties: {
        question: { type: "string", description: "The question to ask the user." },
        options: {
          type: "array",
          items: { type: "string" },
          description: "The choices — each a short self-contained label (add the consequence if it helps the user decide).",
        },
        recommended: {
          type: "string",
          description: "Optional: the option you recommend (must equal one of options); it is marked in the selector.",
        },
      },
    },
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return runAskTool(params, ctx);
    },
  });
}

// Exported for testing. Resolves a question via ctx.ui.select, with a headless fallback that returns the
// question as data so the model can still ask in prose. Never throws.
export async function runAskTool(params, ctx) {
  try {
    const question = String(params?.question ?? "").trim();
    const options = normalizeOptions(params?.options);
    if (!question) return toolJson({ ok: false, error: "aipi_ask needs a question" });
    if (options.length < 2) return toolJson({ ok: false, error: "aipi_ask needs at least two options" });

    // Interactive dialogs exist only where the UI is dialog-capable (TUI / RPC). Otherwise hand the question
    // back so the model asks in prose and records the answer itself.
    if (!ctx?.hasUI || typeof ctx?.ui?.select !== "function") {
      return toolJson({
        ok: true,
        interactive: false,
        question,
        options,
        note: "No interactive UI available here; ask the user in prose and record their answer.",
      });
    }

    const recommended = params?.recommended != null ? String(params.recommended).trim() : "";
    const display = options.map((opt) => (recommended && opt === recommended ? `${opt}${RECOMMENDED_MARK}` : opt));
    const picked = await ctx.ui.select(question, display);
    if (picked === undefined || picked === null) {
      return toolJson({ ok: true, answered: false, note: "The user dismissed the selector without choosing." });
    }
    // Map the display label (which may carry the recommended mark) back to the original option.
    const index = display.indexOf(picked);
    const answer = index >= 0 ? options[index] : String(picked);
    return toolJson({ ok: true, answered: true, answer });
  } catch (error) {
    return toolJson({ ok: false, error: String(error?.message ?? error) });
  }
}

function normalizeOptions(options) {
  const list = Array.isArray(options) ? options : options != null ? [options] : [];
  return list.map((option) => String(option ?? "").trim()).filter(Boolean);
}

function toolJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

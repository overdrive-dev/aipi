// The worker's live back-channel to the orchestrator, registered inside the forked worker's pi run.
// When a running worker hits an ambiguity it cannot resolve from its own context (a missing decision,
// an underspecified requirement, a "which of these" choice, missing access/info), it calls
// aipi_ask_orchestrator instead of guessing. The tool BLOCKS on the in-process ask bridge until the
// orchestrator answers (via aipi_answer_agent) and returns that answer as the tool result — the worker
// keeps its full context and resumes exactly where it paused. The user only ever talks to the
// orchestrator; workers talk to the orchestrator through this channel.
//
// The worker's foreground run executes IN THIS SAME PROCESS/REALM (jiti-loaded with moduleCache:false),
// so a module-level singleton would NOT be shared with the coordinator — but globalThis is. The
// coordinator installs globalThis.__AIPI_ASK_BRIDGE__ (see subagents.js aipiAskBridge); this tool reads
// it. No IPC.

const AGENT_ID_ENV = "AIPI_SUBAGENTS_AGENT_ID";

export default function registerAipiAskOrchestratorChild(pi) {
  pi.registerTool?.({
    name: "aipi_ask_orchestrator",
    label: "Ask the orchestrator",
    description:
      "Ask the orchestrator ONE focused question and BLOCK until it answers. Use this when you hit an " +
      "ambiguity you genuinely cannot resolve from your task context — a missing or contradictory decision, " +
      "an underspecified requirement, a 'which option' choice, or missing access/information — instead of " +
      "guessing. You will receive the orchestrator's answer and continue where you paused. Do NOT use it for " +
      "anything you can determine yourself from the code, the context packet, or aipi_retrieve.",
    parameters: {
      type: "object",
      required: ["question"],
      properties: {
        question: { type: "string", description: "A single, focused question for the orchestrator." },
      },
      additionalProperties: false,
    },
    async execute(_id, params = {}, signal) {
      const agentId = process.env[AGENT_ID_ENV] || null;
      const question = String(params.question ?? "").trim();
      if (!question) {
        return { content: [{ type: "text", text: "aipi_ask_orchestrator requires a non-empty question." }], isError: true };
      }
      const bridge = globalThis.__AIPI_ASK_BRIDGE__;
      if (!bridge || typeof bridge.ask !== "function" || !agentId) {
        // No live orchestrator channel (e.g. running standalone) — degrade gracefully so the worker
        // proceeds on its best judgment rather than failing.
        return {
          content: [{
            type: "text",
            text: "No orchestrator channel is available. Proceed using your best judgment and record the assumption you made in your result.",
          }],
        };
      }
      try {
        const answer = await raceAbort(bridge.ask(agentId, question), signal);
        const text = String(answer ?? "").trim();
        return {
          content: [{
            type: "text",
            text: text || "(the orchestrator returned an empty answer — proceed on your best judgment and note the assumption in your result)",
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: "text",
            text: `No answer from the orchestrator (${String(error?.message ?? error)}). Proceed using your best judgment and note the assumption in your result.`,
          }],
        };
      }
    },
  });
}

// Resolve when the bridge answers; reject if the worker is aborted (budget/cancel) while waiting, so the
// tool never hangs past the worker's own lifetime.
function raceAbort(promise, signal) {
  if (!signal || typeof signal.addEventListener !== "function") return promise;
  if (signal.aborted) return Promise.reject(new Error("worker aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("worker aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

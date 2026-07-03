import { SubagentCoordinator, registerSubagentTools } from "./runtime/subagents.js";
import {
  formatInitSummary,
  initProject,
  parseInitArgs,
  resolveProjectRoot,
} from "./runtime/project-init.js";
import {
  aipiStatusKind,
  buildAipiStatusReport,
  formatAipiStatus,
} from "./runtime/provider-auth.js";
import {
  formatWorkflowCommandResult,
  runWorkflowCommand,
} from "./runtime/run-state.js";
import { createSubagentWorkflowAdapter } from "./runtime/workflow-executor.js";
import {
  formatPlanCommandResult,
  runPlanCommand,
} from "./runtime/plan-command.js";
import { resolveStepModel } from "./runtime/model-router.js";
import { registerAipiRuntimeTools } from "./runtime/aipi-tools.js";
import {
  formatMemoryCommandResult,
  runMemoryCommand,
} from "./runtime/memory-command.js";
import {
  formatModelsCommandResult,
  runModelsCommand,
} from "./runtime/models-command.js";
import {
  formatOnboardingResult,
  maybeRunPostInitOnboarding,
  parseOnboardArgs,
  runProjectOnboarding,
} from "./runtime/onboarding.js";
import {
  formatDiagnoseCommandResult,
  runDiagnoseCommand,
} from "./runtime/diagnose.js";
import {
  formatPiSubagentsLiveSpike,
  runPiSubagentsLiveSpike,
} from "./runtime/pi-subagents.js";
import { makeProgressNotifier, registerAipiLifecycleHooks } from "./runtime/lifecycle-hooks.js";
import {
  formatProbeAResult,
  ProbeAController,
} from "./runtime/probe-a.js";
import {
  formatProbeAPrimeResult,
  runProbeAPrime,
} from "./runtime/probe-a-prime.js";
import {
  buildEnvironmentReport,
  formatEnvironmentReport,
} from "./runtime/environment-doctor.js";

export default function aipiExtension(pi, { workflowCommandRunner = runWorkflowCommand, planCommandRunner = runPlanCommand } = {}) {
  const coordinator = new SubagentCoordinator(pi);
  const probeA = new ProbeAController(pi);

  // Stable AIPI tool surface (aipi_spawn_agent, _status, _collect, _cancel, _steer).
  // The S0 Pi SDK spawn backend is wired for single in-process session workers;
  // the workflow executor and reconciliation layer decide when to call it.
  registerSubagentTools(pi, coordinator);
  registerAipiRuntimeTools(pi, { projectRootResolver: (ctx) => resolveProjectRoot(ctx) });
  registerAipiLifecycleHooks(pi, { projectRootResolver: (ctx) => resolveProjectRoot(ctx), coordinator });
  probeA.registerHooks();

  pi.registerCommand("aipi-init", {
    description: "Install the AIPI project memory, workflow, agent, and protocol templates into the current repository.",
    handler: async (args, ctx) => {
      try {
        const options = parseInitArgs(args ?? "");
        const targetRoot = resolveProjectRoot(ctx, options.targetRoot);
        const summary = await initProject({ ...options, targetRoot });
        ctx.ui.notify(formatInitSummary(summary), "info");
        const onboarding = await maybeRunPostInitOnboarding({
          projectRoot: targetRoot,
          ctx,
          coordinator,
          skip: options.noOnboard || options.dryRun,
          onProgress: (event) => ctx.ui.notify(event.message, "info"),
          pullEmbeddings: !options.noPullEmbeddings,
        });
        ctx.ui.notify(formatOnboardingResult(onboarding), onboarding.action === "onboard" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`AIPI init failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-onboard", {
    description: "Inventory the repository and seed AIPI project memory pages.",
    handler: async (args, ctx) => {
      try {
        const options = parseOnboardArgs(args ?? "");
        const projectRoot = resolveProjectRoot(ctx, options.targetRoot);
        const hostModel = ctx?.model ?? ctx?.current_model ?? ctx?.currentModel ?? coordinator.getHostModel?.();
        const result = await runProjectOnboarding({
          projectRoot,
          ctx,
          coordinator,
          hostModel,
          askUser: !options.noQuestions,
          runWorker: Boolean(hostModel),
          onProgress: (event) => ctx.ui.notify(event.message, "info"),
          pullEmbeddings: !options.noPullEmbeddings,
        });
        ctx.ui.notify(formatOnboardingResult(result), "info");
      } catch (error) {
        ctx.ui.notify(`AIPI onboarding failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-workflow", {
    description: "List, inspect, or start an AIPI workflow run.",
    handler: async (args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const adapter = createSubagentWorkflowAdapter(coordinator, {
          modelResolver: (modelArgs) => resolveStepModel({ ...modelArgs, ctx }),
          // Real agentic workers take minutes; the 120s spike default timed them out mid-step (BLOCKED).
          collectTimeoutMs: 20 * 60_000,
        });
        const result = await workflowCommandRunner({
          args: args ?? "",
          projectRoot,
          adapter,
          parentInteractiveToolCallHook: "registered_parent_interactive_tool_call_hook",
          // CR-59-3 / ADV-58-3: surface per-step progress on the explicit /aipi-workflow surface
          // (not only the auto-dispatch path) so a long `run`/`execute` is never a silent "hung vs
          // processing" black box. Reuses the same notifier the lifecycle auto-dispatch path uses.
          notify: makeProgressNotifier(ctx),
        });
        ctx.ui.notify(formatWorkflowCommandResult(result), "info");
      } catch (error) {
        ctx.ui.notify(`AIPI workflow failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-plan", {
    description: "Plan and autonomously execute a BATCH of tasks (multi-task pipeline): create | status | answer <q> <text> | cadence [checkpoint|autonomous] | settle | execute | cancel.",
    handler: async (args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const adapter = createSubagentWorkflowAdapter(coordinator, {
          modelResolver: (modelArgs) => resolveStepModel({ ...modelArgs, ctx }),
          // Real agentic workers take minutes; match the /aipi-workflow ceiling so plan tasks are not
          // timed out mid-step.
          collectTimeoutMs: 20 * 60_000,
        });
        const result = await planCommandRunner({
          args: args ?? "",
          projectRoot,
          adapter,
          notify: makeProgressNotifier(ctx),
        });
        ctx.ui.notify(formatPlanCommandResult(result), "info");
      } catch (error) {
        ctx.ui.notify(`AIPI plan failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-memory", {
    description: "Inspect AIPI memory: status | refs | query <terms> | candidates | promote <id> | discard <id> | reconcile [scan|dismiss <id>|resolve <id>] | doctor | verify [--strict].",
    handler: async (args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const result = await runMemoryCommand({ args: args ?? "", projectRoot });
        ctx.ui.notify(formatMemoryCommandResult(result), "info");
      } catch (error) {
        ctx.ui.notify(`AIPI memory failed: ${error.message}`, "error");
      }
    },
  });

  // `aipi effort` configures the 4-bucket (planner/adversarial/doer/mover) provider-agnostic
  // model topology. `aipi models` is kept as an alias to the same handler.
  const effortCommandHandler = async (args, ctx) => {
    try {
      const projectRoot = resolveProjectRoot(ctx);
      const result = await runModelsCommand({ args: args ?? "", projectRoot, ui: ctx?.ui });
      ctx.ui.notify(formatModelsCommandResult(result), result.state === "ready" ? "info" : "warning");
    } catch (error) {
      ctx.ui.notify(`AIPI effort failed: ${error.message}`, "error");
    }
  };
  pi.registerCommand("aipi-effort", {
    description: "Configure the AIPI 4-bucket (planner/adversarial/doer/mover) provider-agnostic model topology.",
    handler: effortCommandHandler,
  });
  pi.registerCommand("aipi-models", {
    description: "Alias of /aipi-effort: configure the AIPI 4-bucket model topology.",
    handler: effortCommandHandler,
  });

  pi.registerCommand("aipi-diagnose", {
    description: "Explain the most recent failed or blocked AIPI run and write a redacted diagnostic report.",
    handler: async (args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const result = await runDiagnoseCommand({ args: args ?? "", projectRoot });
        ctx.ui.notify(formatDiagnoseCommandResult(result), result.help ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`AIPI diagnose failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-pi-subagents-spike", {
    description: "Run the phase-1 pi-subagents provider-inheritance spike inside a live AIPI/Pi session.",
    handler: async (_args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const result = await runPiSubagentsLiveSpike({ pi, projectRoot });
        ctx.ui.notify(formatPiSubagentsLiveSpike(result), result.go_no_go === "GO_CANDIDATE" ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`AIPI pi-subagents spike failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-probe-a", {
    description: "Run Probe A: check whether spawned worker tool_call events are attributable to a worker/session.",
    handler: async (args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const result = await probeA.run({ projectRoot, ctx, args: args ?? "" });
        const kind = result.verdict === "PASS" ? "info" : result.verdict === "RUNNING" ? "info" : "warning";
        ctx.ui.notify(formatProbeAResult(result), kind);
      } catch (error) {
        ctx.ui.notify(`AIPI Probe A failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-probe-a-prime", {
    description: "Run Probe A': check whether wrapped worker write tools enforce owned-file scope in-process.",
    handler: async (_args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const result = await runProbeAPrime({ projectRoot });
        const kind = result.verdict === "IN_PROCESS_VIABLE" ? "info" : "warning";
        ctx.ui.notify(formatProbeAPrimeResult(result), kind);
      } catch (error) {
        ctx.ui.notify(`AIPI Probe A' failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-status", {
    description: "Show AIPI package status.",
    handler: async (_args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const report = await buildAipiStatusReport({ projectRoot });
        ctx.ui.notify(formatAipiStatus(report), aipiStatusKind(report));
      } catch (error) {
        ctx.ui.notify(`AIPI status failed: ${error.message}`, "error");
      }
    },
  });

  pi.registerCommand("aipi-setup", {
    description: "Verify the workstation environment (Node, Git, Pi, Docker, Playwright, Ollama embedding model) per .aipi/environment.json. Fixes run from the console: aipi setup --fix.",
    handler: async (_args, ctx) => {
      try {
        const projectRoot = resolveProjectRoot(ctx);
        const report = await buildEnvironmentReport({
          targetDir: projectRoot,
          // Running inside an interactive Pi session IS the proof Pi resolves.
          piProbe: () => ({ ok: true, version: null, source: "this interactive Pi session" }),
        });
        ctx.ui.notify(formatEnvironmentReport(report), report.ok ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`AIPI setup failed: ${error.message}`, "error");
      }
    },
  });
}

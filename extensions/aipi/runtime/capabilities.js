export function buildRuntimeCapabilityReport({ contract = {} } = {}) {
  const specOnlyTools = contract.aipiToolSurface?.specificationOnly ?? [];
  const implementedTools = contract.aipiToolSurface?.implemented ?? [];

  const capabilities = [
    {
      id: "workflow.executor.quick",
      state: "verified",
      evidence: ["test:workflow-executor"],
      summary: "quick workflow regression covers YAML gates, run limits, required artifacts, executor-owned writes, and S0 quick_change handoff",
    },
    {
      id: "workflow.executor.generic",
      state: "verified",
      evidence: ["test:workflow-executor"],
      summary: "non-quick workflow regression covers deterministic controller execution of installed workflow YAML, not unattended production autonomy",
    },
    {
      id: "context.builder",
      state: "verified",
      evidence: ["test:context-builder"],
      summary: "context packet regression covers prior results, artifact excerpts, Markdown memory refs, graph status, fused retrieval refs, and provenance fields",
    },
    {
      id: "aipi.tool.surface",
      state: specOnlyTools.length ? "wired" : "verified",
      evidence: ["validate", "test:aipi-tools"],
      summary: `${implementedTools.length} AIPI tools implemented; ${specOnlyTools.length} still specification-only`,
    },
    {
      id: "subagent.s0",
      state: "verified",
      evidence: ["test:subagents", "test:subagents-real-sdk", "test:workflow-executor"],
      summary: "local regressions cover default forked pi_subagents spawn, project-scoped runtime paths, host-model restriction, read-only child tools plus the owned-file guarded write extension, budget timeout/tool count enforcement, coordinator traces, and clean-boundary redispatch",
    },
    {
      id: "subagent.fanout",
      state: "verified",
      evidence: ["test:workflow-executor"],
      summary: "configured fan-out regression covers multiple worker dispatch and structured step-result reconciliation",
    },
    {
      id: "permission_policy.removed",
      state: "verified",
      evidence: ["test:permission-removal"],
      summary: "parent-session permission profiles and tool-call approval gates were intentionally removed so local interactive source edits are not blocked",
    },
    {
      id: "runtime.lifecycle_hooks",
      state: "verified",
      evidence: ["test:lifecycle-hooks"],
      summary: "lifecycle-hook regression covers active run pointers, recognized natural-language routing, blocker answers, interrupted subagent snapshots, context pointers, model/thinking policy, compaction summaries, user_bash observation without permission blocking, provider redaction, usage/cost metadata, budget telemetry, and tool/provider event normalization inside Pi hook surfaces",
    },
    {
      id: "memory.graph.sqlite",
      state: "verified",
      evidence: ["test:aipi-tools"],
      summary: "rebuildable JSON graph manifest plus node:sqlite sidecar backs callers and impact tools with SQLite/vector refs, code edges, and BDD/business/deployment/run relationship edges",
    },
    {
      id: "memory.graph.vector",
      state: "verified",
      evidence: ["test:aipi-tools"],
      summary: "sqlite-vec vec0 is loaded when available and stores 1024-dimensional Ollama bge-m3 symbol/window chunk embeddings by default, with loud readiness warnings, lexical fallback, and fused aipi_retrieve context",
    },
  ];

  return {
    schema: "aipi.capability-report.v1",
    states: summarizeStates(capabilities),
    capabilities,
  };
}

export function formatCapabilityReport(report) {
  return [
    `Capabilities: verified=${report.states.verified} wired=${report.states.wired} specification=${report.states.specification}`,
    ...report.capabilities.map(
      (capability) =>
        `- ${capability.id}: ${capability.state} (${capability.evidence.join(", ")}) - ${capability.summary}`,
    ),
  ].join("\n");
}

function summarizeStates(capabilities) {
  const states = { verified: 0, wired: 0, specification: 0 };
  for (const capability of capabilities) {
    states[capability.state] = (states[capability.state] ?? 0) + 1;
  }
  return states;
}

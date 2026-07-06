#!/usr/bin/env node
// AIPI worktree-isolation audit.
//
// Run this from a project where you trialed AIPI_WORKER_ISOLATION=per_worker_worktree.
// It reports the things that matter for auditing the isolation + merge-back slice:
//   - leaked worktrees / branches (cleanup failures)  [git]
//   - leftover worktree dirs under the temp dir        [fs]
//   - merged / uncommitted working-tree changes        [git]
//   - whether the tree is currently clean (would allow new worktree jobs)
//   - worktree_* lifecycle traces, if a session/events source is found
//
// Git + filesystem signals are always gathered. Trace enrichment is best-effort:
// pass --events <session.jsonl | dir>, or it auto-scans common Pi session locations.
// Exits non-zero when issues are found.
//
// Usage: node tools/aipi-worktree-audit.mjs [--root <dir>] [--events <path>] [--json]

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WORKTREE_EVENTS = new Set([
  "worktree_provisioned",
  "worktree_diff",
  "worktree_merged",
  "worktree_merge_skipped",
  "worktree_merge_empty",
  "worktree_merge_conflict",
  "worktree_cleanup_failed",
  "worktree_isolation_fallback",
]);
const ISSUE_EVENTS = new Set(["worktree_merge_conflict", "worktree_cleanup_failed"]);

export function resolveGit() {
  if (spawnSync("git", ["--version"], { encoding: "utf-8" }).status === 0) return "git";
  for (const candidate of ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "git";
}

export function makeGitRunner(bin = resolveGit()) {
  return (root, args) => {
    const res = spawnSync(bin, ["-C", root, ...args], { encoding: "utf-8" });
    return { status: res.status, out: (res.stdout ?? "").trim(), err: (res.stderr ?? "").trim() };
  };
}

export function runGitAudit(root, git = makeGitRunner()) {
  if (git(root, ["rev-parse", "--is-inside-work-tree"]).out !== "true") {
    return { isRepo: false };
  }
  const worktreeLines = git(root, ["worktree", "list", "--porcelain"]).out.split("\n");
  const leakedWorktrees = worktreeLines
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter((p) => /aipi-worktree-/.test(p));
  const leakedBranches = git(root, ["branch", "--list", "aipi-worker-*"]).out
    .split("\n")
    .map((line) => line.replace(/^[*+]?\s*/, "").trim())
    .filter(Boolean);
  const dirty = git(root, ["status", "--porcelain"]).out.split("\n").filter(Boolean);
  const trackedDirty = git(root, ["status", "--porcelain", "--untracked-files=no"]).out.split("\n").filter(Boolean);
  const recentLog = git(root, ["log", "--oneline", "-n", "15"]).out.split("\n").filter(Boolean);
  return {
    isRepo: true,
    leakedWorktrees,
    leakedBranches,
    dirtyCount: dirty.length,
    trackedDirty,
    cleanTracked: trackedDirty.length === 0,
    recentLog,
  };
}

export function findTempLeftovers(tmpDir = os.tmpdir()) {
  try {
    return fs.readdirSync(tmpDir).filter((name) => name.startsWith("aipi-worktree-")).map((name) => path.join(tmpDir, name));
  } catch {
    return [];
  }
}

function collectJsonlFiles(source, depth = 0, acc = []) {
  let stat;
  try { stat = fs.statSync(source); } catch { return acc; }
  if (stat.isFile()) {
    if (source.endsWith(".jsonl") || source.endsWith(".json")) acc.push(source);
    return acc;
  }
  if (depth > 4) return acc;
  let entries;
  try { entries = fs.readdirSync(source, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    collectJsonlFiles(path.join(source, entry.name), depth + 1, acc);
  }
  return acc;
}

export function discoverEventSources(root, explicit) {
  const sources = [];
  const add = (p) => { if (p && fs.existsSync(p) && !sources.includes(p)) sources.push(p); };
  if (explicit) add(explicit);
  if (process.env.PI_CODING_AGENT_DIR) add(path.join(process.env.PI_CODING_AGENT_DIR, "sessions"));
  add(path.join(os.homedir(), ".pi", "agent", "sessions"));
  add(path.join(root, ".aipi"));
  return sources;
}

export function scanWorktreeEvents(sources) {
  const events = [];
  const seen = new Set();
  for (const source of sources) {
    for (const file of collectJsonlFiles(source)) {
      if (seen.has(file)) continue;
      seen.add(file);
      let content;
      try { content = fs.readFileSync(file, "utf-8"); } catch { continue; }
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.includes("aipi.subagent-event")) continue;
        let obj;
        try { obj = JSON.parse(trimmed); } catch { continue; }
        const ev = obj?.value ?? obj?.data ?? obj?.payload ?? obj;
        if (ev?.schema === "aipi.subagent-event.v1" && WORKTREE_EVENTS.has(ev.event)) {
          events.push({ file, event: ev.event, agent_id: ev.agent_id ?? null, recorded_at: ev.recorded_at ?? null, branch: ev.branch ?? null, reason: ev.reason ?? null });
        }
      }
    }
  }
  return events;
}

export function summarizeEvents(events) {
  const counts = {};
  const perAgent = {};
  for (const ev of events) {
    counts[ev.event] = (counts[ev.event] ?? 0) + 1;
    const id = ev.agent_id ?? "unknown";
    (perAgent[id] ??= []).push(ev.event);
  }
  const issues = events.filter((ev) => ISSUE_EVENTS.has(ev.event));
  return { total: events.length, counts, perAgent, issues };
}

export function buildReport({ root, git = runGitAudit, events, tmpLeftovers }) {
  const gitAudit = typeof git === "function" ? git(root) : git;
  const eventSummary = summarizeEvents(events ?? []);
  const problems = [];
  if (gitAudit.isRepo) {
    if (gitAudit.leakedWorktrees.length) problems.push(`${gitAudit.leakedWorktrees.length} leaked worktree(s) still registered`);
    if (gitAudit.leakedBranches.length) problems.push(`${gitAudit.leakedBranches.length} leaked aipi-worker-* branch(es)`);
  } else {
    problems.push("not a git repository (worktree isolation cannot run here)");
  }
  if (tmpLeftovers.length) problems.push(`${tmpLeftovers.length} leftover worktree dir(s) under the temp dir`);
  if (eventSummary.issues.length) problems.push(`${eventSummary.issues.length} merge-conflict/cleanup-failure trace event(s)`);
  return { root, git: gitAudit, tmpLeftovers, events: eventSummary, problems, ok: problems.length === 0 };
}

function renderText(report) {
  const lines = [];
  lines.push(`AIPI worktree-isolation audit — ${report.root}`);
  lines.push("─".repeat(60));
  const g = report.git;
  if (!g.isRepo) {
    lines.push("git: NOT a repository");
  } else {
    lines.push(`git tree clean (tracked): ${g.cleanTracked ? "yes" : `no — ${g.trackedDirty.length} tracked change(s)`}`);
    lines.push(`leaked worktrees: ${g.leakedWorktrees.length ? g.leakedWorktrees.join(", ") : "none"}`);
    lines.push(`leaked aipi-worker-* branches: ${g.leakedBranches.length ? g.leakedBranches.join(", ") : "none"}`);
    lines.push(`working-tree changes (any): ${g.dirtyCount}`);
    if (g.recentLog.length) lines.push(`recent commits:\n  ${g.recentLog.slice(0, 5).join("\n  ")}`);
  }
  lines.push(`temp-dir leftover worktrees: ${report.tmpLeftovers.length ? report.tmpLeftovers.join(", ") : "none"}`);
  lines.push("");
  const e = report.events;
  if (e.total === 0) {
    lines.push("traces: no worktree_* events found (pass --events <session.jsonl> to include them)");
  } else {
    lines.push(`traces: ${e.total} worktree_* event(s)`);
    for (const [name, count] of Object.entries(e.counts)) lines.push(`  ${name}: ${count}`);
    if (e.issues.length) {
      lines.push("  ⚠ issues:");
      for (const iss of e.issues) lines.push(`    ${iss.event} (${iss.agent_id ?? "?"})${iss.reason ? `: ${iss.reason}` : ""}`);
    }
  }
  lines.push("");
  lines.push(report.ok ? "VERDICT: OK — no leaks or conflicts detected." : `VERDICT: ISSUES — ${report.problems.join("; ")}`);
  return lines.join("\n");
}

function main(argv) {
  const args = { root: process.cwd(), events: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") args.root = argv[++i];
    else if (argv[i] === "--events") args.events = argv[++i];
    else if (argv[i] === "--json") args.json = true;
  }
  const sources = discoverEventSources(args.root, args.events);
  const events = scanWorktreeEvents(sources);
  const report = buildReport({ root: args.root, git: (r) => runGitAudit(r), events, tmpLeftovers: findTempLeftovers() });
  report.eventSources = sources;
  console.log(args.json ? JSON.stringify(report, null, 2) : renderText(report));
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}

/**
 * Durable snapshots of terminal async subagent runs.
 *
 * The live async run directories live under os.tmpdir() (ASYNC_DIR) and their
 * result files are deleted once processed, so finished runs are not durably
 * visible. This module snapshots each run's structured summary (plus its result
 * payload, if still present) into a durable, agent-scoped directory the moment it
 * reaches a terminal state, so the subagent view can show recently finished runs
 * across the in-memory retention window, tmp cleanup, and restarts.
 *
 * All operations are best-effort: history is an observability aid and must never
 * disrupt the run lifecycle.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/utils.ts";
import { type AsyncRunSummary, listAsyncRuns, sortAsyncRunsByRecency, summarizeAsyncRunDir } from "./async-status.ts";

export const HISTORY_DIR = path.join(getAgentDir(), "async-subagent-history");

/** Keep at most this many snapshots; oldest are pruned by mtime. */
const HISTORY_KEEP = 200;

interface HistorySnapshot {
	summary: AsyncRunSummary;
	result?: unknown;
	snapshotAt: number;
}

function safeMtimeMs(filePath: string): number {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return 0;
	}
}

function pruneHistory(historyDir: string): void {
	let files: string[];
	try {
		files = fs.readdirSync(historyDir).filter((file) => file.endsWith(".json"));
	} catch {
		return;
	}
	if (files.length <= HISTORY_KEEP) return;
	const ranked = files
		.map((file) => ({ file, mtime: safeMtimeMs(path.join(historyDir, file)) }))
		.sort((a, b) => b.mtime - a.mtime);
	for (const stale of ranked.slice(HISTORY_KEEP)) {
		try {
			fs.rmSync(path.join(historyDir, stale.file), { force: true });
		} catch {
			// Best-effort pruning.
		}
	}
}

/**
 * Snapshot a terminal run into the durable history dir. Best-effort: never throws.
 * No-op for non-terminal runs (queued/running) — the current status is re-read so
 * a still-running run is never captured even if called speculatively.
 */
export function snapshotRunToHistory(input: {
	asyncDir: string;
	runId: string;
	resultsDir: string;
	now?: () => number;
	historyDir?: string;
}): void {
	try {
		const summary = summarizeAsyncRunDir(input.asyncDir, { reconcile: false, resultsDir: input.resultsDir });
		if (!summary) return;
		if (summary.state === "queued" || summary.state === "running") return;
		const historyDir = input.historyDir ?? HISTORY_DIR;
		let result: unknown;
		const resultPath = path.join(input.resultsDir, `${input.runId}.json`);
		try {
			if (fs.existsSync(resultPath)) result = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
		} catch {
			// The result file may already be consumed/deleted; the summary alone is still useful.
		}
		const snapshot: HistorySnapshot = {
			summary,
			...(result !== undefined ? { result } : {}),
			snapshotAt: (input.now ?? Date.now)(),
		};
		writeAtomicJson(path.join(historyDir, `${input.runId}.json`), snapshot);
		pruneHistory(historyDir);
	} catch {
		// History is best-effort; never disrupt the run lifecycle.
	}
}

/** Load durable history snapshots as run summaries, newest-first. */
export function listHistoryRuns(historyDir: string = HISTORY_DIR): AsyncRunSummary[] {
	let files: string[];
	try {
		files = fs.readdirSync(historyDir).filter((file) => file.endsWith(".json"));
	} catch {
		return [];
	}
	const runs: AsyncRunSummary[] = [];
	for (const file of files) {
		try {
			const snapshot = JSON.parse(fs.readFileSync(path.join(historyDir, file), "utf-8")) as HistorySnapshot;
			if (snapshot?.summary?.id) runs.push(snapshot.summary);
		} catch {
			// Skip corrupt snapshots.
		}
	}
	return sortAsyncRunsByRecency(runs);
}

/**
 * Merged run list for the subagent view: live runs (active-first) followed by
 * durable-history runs not already present live (de-duped by id).
 */
export function loadSubagentRuns(asyncDirRoot: string = ASYNC_DIR, resultsDir: string = RESULTS_DIR): AsyncRunSummary[] {
	const live = listAsyncRuns(asyncDirRoot, { resultsDir });
	const liveIds = new Set(live.map((run) => run.id));
	const history = listHistoryRuns().filter((run) => !liveIds.has(run.id));
	return [...live, ...history];
}

/**
 * Subagent drilldown TUI component.
 *
 * A focusable, keyboard-navigable overlay shown via `ctx.ui.custom()`:
 *   - List view: all runs (live active-first, then durable history), select with ↑↓.
 *   - Detail view: the selected run's step tree, nested children, and output paths,
 *     scrollable with ↑↓ / PageUp / PageDown.
 * Polls the data layer (`loadSubagentRuns`) every 500ms so the pane stays live.
 *
 * Factory signature matches ctx.ui.custom: (tui, theme, kb, done) => Component
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type AsyncRunSummary, formatAsyncRunList, formatAsyncRunProgressLabel } from "../runs/background/async-status.ts";
import { formatActivityLabel } from "../shared/status-format.ts";

type RunState = AsyncRunSummary["state"];

const STATE_GLYPH: Record<RunState, string> = {
	running: "●",
	queued: "◦",
	complete: "✓",
	failed: "✗",
	paused: "■",
};

const STATE_COLOR: Record<RunState, string> = {
	running: "accent",
	queued: "muted",
	complete: "success",
	failed: "error",
	paused: "warning",
};

const REFRESH_INTERVAL_MS = 500;

export class SubagentViewComponent implements Component {
	readonly width: number;

	private runs: AsyncRunSummary[] = [];
	private selected = 0;
	private view: "list" | "detail" = "list";
	private detailRunId: string | undefined;
	private detailScroll = 0;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;
	private readonly viewport = 18;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly load: () => AsyncRunSummary[];
	private readonly done: () => void;

	constructor(tui: TUI, theme: Theme, load: () => AsyncRunSummary[], done: () => void, width = 104) {
		this.tui = tui;
		this.theme = theme;
		this.load = load;
		this.done = done;
		this.width = width;
		this.refresh();
		this.refreshTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
		this.refreshTimer.unref?.();
	}

	private refresh(): void {
		try {
			this.runs = this.load();
		} catch {
			// Keep the prior snapshot on transient read errors.
		}
		if (this.selected >= this.runs.length) this.selected = Math.max(0, this.runs.length - 1);
		this.tui.requestRender();
	}

	private detailRun(): AsyncRunSummary | undefined {
		if (!this.detailRunId) return undefined;
		return this.runs.find((run) => run.id === this.detailRunId);
	}

	private glyph(state: RunState): string {
		return this.theme.fg(STATE_COLOR[state], STATE_GLYPH[state]);
	}

	// ── Input ──────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (this.view === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.selected = Math.max(0, this.selected - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.selected = Math.min(Math.max(0, this.runs.length - 1), this.selected + 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "right") || data === "l") {
			const run = this.runs[this.selected];
			if (run) {
				this.detailRunId = run.id;
				this.detailScroll = 0;
				this.view = "detail";
				this.tui.requestRender();
			}
			return;
		}
		if (data === "r") this.refresh();
	}

	private handleDetailInput(data: string): void {
		if (data === "q") {
			this.done();
			return;
		}
		if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "h") {
			this.view = "list";
			this.detailScroll = 0;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up") || data === "k") {
			this.detailScroll = Math.max(0, this.detailScroll - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			this.detailScroll += 1;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageup")) {
			this.detailScroll = Math.max(0, this.detailScroll - this.viewport);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pagedown")) {
			this.detailScroll += this.viewport;
			this.tui.requestRender();
			return;
		}
		if (data === "r") this.refresh();
	}

	// ── Render ─────────────────────────────────────────────────────────────────

	render(width: number): string[] {
		const w = Math.max(48, Math.min(this.width, width || this.width));
		return this.view === "detail" ? this.renderDetail(w) : this.renderList(w);
	}

	private renderList(w: number): string[] {
		const th = this.theme;
		const active = this.runs.filter((run) => run.state === "running" || run.state === "queued").length;
		const lines: string[] = [
			th.fg("accent", "Subagents") + th.fg("dim", `  ${this.runs.length} runs · ${active} active`),
			th.fg("dim", "─".repeat(w)),
		];

		if (this.runs.length === 0) {
			lines.push(th.fg("dim", "  No subagent runs yet. Launch with /run, /chain, or /parallel (add --bg)."));
		} else {
			let start = 0;
			if (this.runs.length > this.viewport) {
				start = Math.max(0, Math.min(this.selected - Math.floor(this.viewport / 2), this.runs.length - this.viewport));
			}
			const end = Math.min(start + this.viewport, this.runs.length);
			if (start > 0) lines.push(th.fg("dim", `  ↑ ${start} more`));
			for (let i = start; i < end; i++) {
				const run = this.runs[i]!;
				const selected = i === this.selected;
				const prefix = selected ? th.fg("accent", "▶ ") : "  ";
				const name = selected ? th.fg("accent", run.id) : run.id;
				const progress = formatAsyncRunProgressLabel(run);
				const activity = run.state === "running" ? formatActivityLabel(run.lastActivityAt, run.activityState) : "";
				const meta = th.fg("dim", `${run.state} · ${run.mode} · ${progress}${activity ? ` · ${activity}` : ""}`);
				lines.push(truncateToWidth(`${prefix}${this.glyph(run.state)} ${name}  ${meta}`, w));
			}
			if (end < this.runs.length) lines.push(th.fg("dim", `  ↓ ${this.runs.length - end} more`));
		}

		lines.push(th.fg("dim", "─".repeat(w)));
		lines.push(th.fg("dim", " ↑↓ select · →/Enter drill in · r refresh · Esc/q close"));
		return lines;
	}

	private renderDetail(w: number): string[] {
		const th = this.theme;
		const run = this.detailRun();
		if (!run) {
			// The run aged out of the list; fall back to the list view.
			this.view = "list";
			return this.renderList(w);
		}

		// Reuse the shared per-run formatter; drop its "heading: N" + blank preamble.
		const body = formatAsyncRunList([run], run.id).split("\n").slice(2);
		const total = body.length;
		const maxScroll = Math.max(0, total - this.viewport);
		if (this.detailScroll > maxScroll) this.detailScroll = maxScroll;
		const start = this.detailScroll;
		const end = Math.min(start + this.viewport, total);

		const lines: string[] = [
			th.fg("accent", `Run ${run.id}`) + th.fg("dim", `  ${run.state} · ${run.mode}`),
			th.fg("dim", "─".repeat(w)),
		];
		if (start > 0) lines.push(th.fg("dim", `  ↑ ${start} more`));
		for (let i = start; i < end; i++) lines.push(truncateToWidth(body[i] ?? "", w));
		if (end < total) lines.push(th.fg("dim", `  ↓ ${total - end} more`));
		lines.push(th.fg("dim", "─".repeat(w)));
		lines.push(th.fg("dim", " ↑↓ scroll · PgUp/PgDn page · ←/Esc back · q close"));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}
}

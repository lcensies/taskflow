/**
 * Live inspector for an in-flight run (`ctrl+alt+t`).
 *
 * List view: the run's phases. Detail view: one phase's recent activity, its
 * partial output, and its accounting. Read-only except for `s`, which asks the
 * host to steer that phase (the host owns the text prompt so this component
 * stays a renderer).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { PhaseState, RunState } from "taskflow-core";
import { renderProgress } from "./render.ts";

export interface InspectorResult {
	action: "steer";
	phaseId: string;
}

/** Phases whose subagent can still receive a message. */
export function isSteerable(ps: PhaseState | undefined): boolean {
	const status = ps?.status ?? "pending";
	return status === "running" || status === "pending";
}

function phaseLine(ps: PhaseState | undefined, id: string, theme: Theme): string {
	const status = ps?.status ?? "pending";
	const badge =
		status === "done"
			? theme.fg("success", "✓")
			: status === "failed"
				? theme.fg("error", "✗")
				: status === "running"
					? theme.fg("warning", "◐")
					: status === "skipped"
						? theme.fg("muted", "⊘")
						: theme.fg("dim", "○");
	const steered = ps?.steered ? theme.fg("accent", " ⇢") : "";
	return `${badge} ${id}${steered}`;
}

export class InspectorComponent {
	private selected = 0;
	private mode: "list" | "detail" = "list";
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private timer?: ReturnType<typeof setInterval>;

	private state: RunState;
	private theme: Theme;
	private onDone: (result?: InspectorResult) => void;
	/** False when this host/run has no steering channel. */
	private steerAvailable: boolean;

	constructor(
		state: RunState,
		theme: Theme,
		onDone: (result?: InspectorResult) => void,
		steerAvailable: boolean,
		requestRender?: () => void,
	) {
		this.state = state;
		this.theme = theme;
		this.onDone = onDone;
		this.steerAvailable = steerAvailable;
		if (requestRender) {
			// The runtime mutates `state` in place; repaint on a timer rather than
			// subscribing, so the inspector never perturbs the run.
			this.timer = setInterval(() => {
				this.invalidate();
				requestRender();
			}, 250);
			(this.timer as { unref?: () => void }).unref?.();
		}
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private phaseIds(): string[] {
		return (this.state.def.phases ?? []).map((p) => p.id);
	}

	handleInput(data: string): void {
		this.invalidate();
		const ids = this.phaseIds();
		if (this.mode === "detail") {
			if (matchesKey(data, "escape")) {
				this.mode = "list";
				this.scroll = 0;
				return;
			}
			if (matchesKey(data, "up")) {
				this.scroll = Math.max(0, this.scroll - 1);
				return;
			}
			if (matchesKey(data, "down")) {
				this.scroll += 1;
				return;
			}
			if (data === "s") this.requestSteer(ids[this.selected]);
			return;
		}
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "ctrl+c")) {
			this.onDone();
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = (this.selected - 1 + ids.length) % ids.length;
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = (this.selected + 1) % ids.length;
			return;
		}
		if (matchesKey(data, "return")) {
			this.mode = "detail";
			this.scroll = 0;
			return;
		}
		if (data === "s") this.requestSteer(ids[this.selected]);
	}

	private requestSteer(phaseId: string | undefined): void {
		if (!phaseId || !this.steerAvailable) return;
		if (!isSteerable(this.state.phases[phaseId])) return;
		this.onDone({ action: "steer", phaseId });
	}

	private detailLines(width: number): string[] {
		const th = this.theme;
		const id = this.phaseIds()[this.selected];
		const ps = this.state.phases[id];
		const lines: string[] = [];
		lines.push(truncateToWidth(`  ${th.fg("accent", id)} ${th.fg("dim", ps?.status ?? "pending")}`, width));
		const meta: string[] = [];
		if (ps?.model) meta.push(ps.model);
		if (ps?.usage) meta.push(`${ps.usage.input + ps.usage.output} tok`);
		if (ps?.attempts && ps.attempts > 1) meta.push(`${ps.attempts} attempts`);
		if (ps?.steered) meta.push("steered");
		if (meta.length) lines.push(truncateToWidth(`  ${th.fg("dim", meta.join(" · "))}`, width));
		lines.push("");

		const body: string[] = [];
		const log = ps?.liveLog ?? [];
		body.push(th.fg("muted", "─── activity ───"));
		if (log.length === 0) body.push(th.fg("dim", "(no activity recorded)"));
		for (const line of log) body.push(`${th.fg("dim", "› ")}${line}`);
		if (ps?.output) {
			body.push("");
			body.push(th.fg("muted", "─── output ───"));
			for (const line of ps.output.split("\n")) body.push(line);
		}
		if (ps?.error) {
			body.push("");
			body.push(th.fg("error", ps.error));
		}
		// Clamp so scrolling past the end cannot blank the view.
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - 1)));
		for (const line of body.slice(this.scroll)) lines.push(truncateToWidth(`  ${line}`, width));
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [""];
		const steerHint = this.steerAvailable ? "s steer · " : "";

		if (this.mode === "detail") {
			lines.push(...this.detailLines(width));
			lines.push("");
			lines.push(truncateToWidth(`  ${th.fg("dim", `↑↓ scroll · ${steerHint}Esc back`)}`, width));
		} else {
			const header =
				th.fg("borderMuted", "───") +
				th.fg("accent", ` Taskflow ${this.state.flowName} `) +
				th.fg("borderMuted", "─".repeat(Math.max(0, width - 14 - this.state.flowName.length)));
			lines.push(truncateToWidth(header, width));
			lines.push("");
			for (const l of renderProgress(this.state, th).split("\n")) lines.push(truncateToWidth(l, width));
			lines.push("");
			const ids = this.phaseIds();
			const id = ids[this.selected];
			lines.push(
				truncateToWidth(`  ${th.fg("accent", "❯ ")}${phaseLine(this.state.phases[id], id ?? "?", th)}`, width),
			);
			lines.push("");
			const unavailable = this.steerAvailable ? "" : th.fg("dim", " · steering unavailable");
			lines.push(
				truncateToWidth(
					`  ${th.fg("dim", `↑↓ select · Enter detail · ${steerHint}q close`)}${unavailable}`,
					width,
				),
			);
		}
		lines.push("");
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

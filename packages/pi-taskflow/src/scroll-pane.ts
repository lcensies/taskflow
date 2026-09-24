/**
 * Keyboard scroll state for a viewport over a list of pre-rendered lines.
 *
 * Same key set as `approval-view.ts` (↑↓/j/k, PgUp/PgDn, Home/End, g/G), but
 * reusable: the owner renders lines, asks for the visible slice, and forwards
 * key data. `follow` sticks the window to the bottom (live tailing); any
 * manual upward scroll drops it, End/G restores it.
 */

import { matchesKey } from "@earendil-works/pi-tui";

const FALLBACK_VISIBLE = 10;

export class ScrollPane {
	/** First visible line index into the last `view()` input. */
	offset = 0;
	/** While true, `view()` pins the window to the last line. */
	follow = true;
	private lastVisible = FALLBACK_VISIBLE;

	/** Returns true when the key was a scroll key (and was consumed). */
	handleKey(data: string): boolean {
		const page = Math.max(1, this.lastVisible - 1);
		if (matchesKey(data, "up") || data === "k") {
			this.scrollBy(-1);
		} else if (matchesKey(data, "down") || data === "j") {
			this.scrollBy(1);
		} else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
			this.scrollBy(-page);
		} else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
			this.scrollBy(page);
		} else if (matchesKey(data, "home") || data === "g") {
			this.offset = 0;
			this.follow = false;
		} else if (matchesKey(data, "end") || data === "G") {
			this.follow = true;
		} else {
			return false;
		}
		return true;
	}

	private scrollBy(delta: number): void {
		this.follow = false;
		this.offset = Math.max(0, this.offset + delta);
	}

	/**
	 * The clamped window into `lines`, plus a trailing `↑ N more · ↓ N more`
	 * indicator line whenever content is cut off (the indicator costs one of
	 * the `visible` rows, so the returned array never exceeds `visible`).
	 */
	view(lines: string[], visible: number): string[] {
		const rows = Math.max(1, Math.floor(visible));
		this.lastVisible = rows;
		if (lines.length <= rows) {
			this.offset = 0;
			return lines.slice();
		}
		const body = Math.max(1, rows - 1);
		const max = lines.length - body;
		this.offset = this.follow ? max : Math.max(0, Math.min(this.offset, max));
		const below = lines.length - this.offset - body;
		const parts: string[] = [];
		if (this.offset > 0) parts.push(`↑ ${this.offset} more`);
		if (below > 0) parts.push(`↓ ${below} more`);
		return [...lines.slice(this.offset, this.offset + body), parts.join(" · ")];
	}
}

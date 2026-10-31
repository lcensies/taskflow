/** Small shape guards shared by the host normalisers. */

export const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const obj = (v: unknown): Record<string, unknown> | undefined =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** Text of a tool result payload: a string, an MCP-style `[{type:"text",text}]`
 * block list (or an object wrapping one in `content`); anything else is
 * JSON-encoded so no result is silently blank. */
export function contentText(v: unknown): string {
	if (v === undefined || v === null) return "";
	if (typeof v === "string") return v;
	if (Array.isArray(v)) {
		return v
			.map((b) => (typeof b === "string" ? b : (str(obj(b)?.text) ?? "")))
			.filter(Boolean)
			.join("\n");
	}
	const content = obj(v)?.content;
	if (Array.isArray(content)) return contentText(content);
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

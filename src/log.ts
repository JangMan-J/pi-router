/** Decision log: one JSON line per routed user turn (and per retry that switches). No message text. */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type LogLine = Record<string, unknown>;

export function fileLogger(path: string): (line: LogLine) => void {
	let dirReady = false;
	return (line) => {
		try {
			if (!dirReady) {
				mkdirSync(dirname(path), { recursive: true });
				dirReady = true;
			}
			appendFileSync(path, `${JSON.stringify(line)}\n`);
		} catch {
			/* logging must never break routing */
		}
	};
}

/** JSON with sorted keys, for hashing and equality. */
export function stableStringify(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	if (v && typeof v === "object") {
		return `{${Object.keys(v)
			.filter((k) => (v as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(v ?? null);
}

export const stateHash = (state: unknown): string => createHash("sha256").update(stableStringify(state)).digest("hex").slice(0, 12);

/**
 * Calibration: the only reason the ids exist.
 *
 * Two joins are possible, and they answer different questions:
 *
 *   1. decisions x later outcomes. Every row the router decided gets the same assignment id as the
 *      pi turn it came from, so a saved abort, rejection, switch or user verdict lands on the
 *      decision that caused it. This measures the router's own track record.
 *   2. actual dispatch x later outcomes. The historical model that really ran each turn, scored by
 *      the same rules. This is what outcomes/REPORT.md already prints, but computed from the record
 *      store, so a future router's decisions and the old dispatch share one vocabulary.
 *
 * Neither is a causal effect. A model's bad rate mixes quality with the work it was given.
 */
import { readFileSync } from "node:fs";
import { insert, type Db } from "./db.ts";
import { type Db as DB, openDb } from "./db.ts";
import { admissionKey, id as ids, wilson } from "./ids.ts";

export interface OutcomeRow {
	host?: string;
	session?: string;
	entry_id?: string;
	model?: string;
	thinking?: string;
	label?: string;
	reasons?: unknown;
	task?: string | null;
	difficulty?: number | string | null;
	timestamp?: string;
	cost?: number | string | null;
	run_seconds?: number | string | null;
	excluded?: string | null;
	aborted?: boolean | string;
	error_stop?: boolean | string;
	switched_after?: string | null;
	tool_errors?: number | string;
	interrupted?: boolean | string;
	interjected?: boolean | string;
	abandoned_branch?: boolean | string;
}

const truthy = (v: unknown): boolean => v === true || v === "True" || v === "true" || v === 1;
const present = (v: unknown): boolean => v != null && v !== "" && v !== "None" && v !== "none";

/**
 * Hard outcome: computed from the session structure alone, never from a model's reading.
 * bad = the run was stopped by the user (an interrupt followed by a message within 1s is steering,
 * not rejection), the run ended on an error stop, the user switched model right after, one tool
 * error repeated 3+ times, or the turn sits on a branch that was later abandoned.
 */
export function hardOutcome(row: OutcomeRow): { bad: boolean; why: string[] } {
	const why: string[] = [];
	const interjected = truthy(row.interjected);
	if (truthy(row.aborted) && !interjected) why.push("aborted");
	if (truthy(row.error_stop)) why.push("error_stop");
	if (present(row.switched_after)) why.push("switched_away");
	if (Number(row.tool_errors ?? 0) >= 3) why.push("repeated_tool_error");
	if (truthy(row.abandoned_branch)) why.push("abandoned_branch");
	return { bad: why.length > 0, why };
}

export function ingestOutcomes(db: DB, path: string, method = "labels.py"): { read: number; joined: number; skipped: number } {
	const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
	let joined = 0;
	let skipped = 0;
	for (const line of lines) {
		let row: OutcomeRow;
		try {
			row = JSON.parse(line) as OutcomeRow;
		} catch {
			skipped++;
			continue;
		}
		if (!row.session || !row.entry_id) {
			skipped++;
			continue;
		}
		const assignmentId = ids.assignment(admissionKey({ origin: row.host, session: row.session, entryId: row.entry_id }));
		insert(db, "assignments", {
			assignment_id: assignmentId,
			admission_key: admissionKey({ origin: row.host, session: row.session, entryId: row.entry_id }),
			origin: row.host ?? null,
			session: row.session,
			entry_id: row.entry_id,
			project_id: null,
			parent_assignment_id: null,
			request_text: null,
			request_sha256: null,
			created_utc: row.timestamp ?? new Date().toISOString(),
			config_id: "route-prior-outcomes",
		});
		const at = row.timestamp ?? new Date().toISOString();
		insert(db, "observations", {
			observation_id: ids.observation(assignmentId, "outcome", "route-prior/labelled.jsonl", at, row.label ?? null),
			assignment_id: assignmentId,
			kind: "outcome",
			source: "route-prior/labelled.jsonl",
			method,
			at_utc: at,
			value_json: JSON.stringify({
				label: row.label ?? null,
				reasons: row.reasons ?? null,
				task: row.task ?? null,
				difficulty: row.difficulty ?? null,
				excluded: row.excluded ?? null,
			}),
		});
		const hard = hardOutcome(row);
		insert(db, "observations", {
			observation_id: ids.observation(assignmentId, "hard_outcome", "route-prior/labelled.jsonl", at, hard),
			assignment_id: assignmentId,
			kind: "hard_outcome",
			source: "route-prior/labelled.jsonl",
			method: "structure:aborted|error_stop|switched_after|tool_errors|abandoned_branch",
			at_utc: at,
			value_json: JSON.stringify(hard),
		});
		insert(db, "observations", {
			observation_id: ids.observation(assignmentId, "actual_dispatch", "route-prior/labelled.jsonl", at, row.model ?? null),
			assignment_id: assignmentId,
			kind: "actual_dispatch",
			source: "route-prior/labelled.jsonl",
			method,
			at_utc: at,
			value_json: JSON.stringify({
				model: row.model ?? null,
				thinking: row.thinking ?? null,
				cost: row.cost ?? null,
				run_seconds: row.run_seconds ?? null,
			}),
		});
		joined++;
	}
	return { read: lines.length, joined, skipped };
}

export interface Rate {
	key: string;
	n: number;
	bad: number;
	lo: number;
	hi: number;
}

function rate(key: string, n: number, bad: number): Rate {
	const [lo, hi] = wilson(bad, n);
	return { key, n, bad, lo, hi };
}

export interface DecisionReport {
	decisions: number;
	withOutcome: number;
	rows: Rate[];
	tierRows: Rate[];
	agreeRows: Rate[];
	switched: number;
	agree: number;
	offPolicy: number;
}

export function reportDecisions(db: DB, since?: string): DecisionReport {
	const cut = since ?? "0000";
	const rows = db
		.prepare(
			`select d.model as model, d.tier as tier, d.action as action,
              o.value_json as outcome, a.value_json as actual
       from decisions d
       join (select assignment_id, max(rowid) as last from decisions where created_utc >= ? group by assignment_id) latest
         on latest.assignment_id = d.assignment_id and latest.last = d.rowid
       left join observations o on o.assignment_id = d.assignment_id and o.kind = 'outcome' and o.at_utc >= ?
       left join observations a on a.assignment_id = d.assignment_id and a.kind = 'actual_dispatch' and a.at_utc >= ?`,
		)
		.all(cut, cut, cut) as { model: string; tier: string; action: string; outcome: string | null; actual: string | null }[];
	const byModel = new Map<string, { n: number; bad: number }>();
	const byTier = new Map<string, { n: number; bad: number }>();
	const byAgree = new Map<string, { n: number; bad: number }>();
	let withOutcome = 0;
	let switched = 0;
	let agree = 0;
	let offPolicy = 0;
	for (const r of rows) {
		if (!r.outcome) continue;
		let label: string | null = null;
		try {
			label = (JSON.parse(r.outcome) as { label?: string }).label ?? null;
		} catch {
			continue;
		}
		if (!label) continue;
		withOutcome++;
		const bad = label === "bad" ? 1 : 0;
		const actualModel = r.actual ? ((JSON.parse(r.actual) as { model?: string }).model ?? null) : null;
		const same = actualModel === r.model;
		if (same) agree++;
		else offPolicy++;
		for (const [map, key] of [
			[byModel, r.model],
			[byTier, r.tier],
		] as const) {
			const cur = map.get(key) ?? { n: 0, bad: 0 };
			cur.n++;
			cur.bad += bad;
			map.set(key, cur);
		}
		// Only the turns where the router and the actual dispatch agree carry evidence about the
		// chosen model's outcome. The rest are off-policy: the observed result belongs to whatever
		// really ran.
		if (same) {
			const cur = byAgree.get(r.model) ?? { n: 0, bad: 0 };
			cur.n++;
			cur.bad += bad;
			byAgree.set(r.model, cur);
		}
		if (r.action !== "keep") switched++;
	}
	const sort = (m: Map<string, { n: number; bad: number }>) =>
		[...m.entries()].map(([k, v]) => rate(k, v.n, v.bad)).sort((a, b) => b.n - a.n);
	return {
		decisions: rows.length,
		withOutcome,
		rows: sort(byModel),
		tierRows: [...byTier.entries()].map(([k, v]) => rate(`tier:${k}`, v.n, v.bad)),
		agreeRows: sort(byAgree),
		switched,
		agree,
		offPolicy,
	};
}

export type OutcomeKind = "outcome" | "hard_outcome";

export function reportActual(db: DB, groupBy: "model" | "task" = "model", kind: OutcomeKind = "outcome", since?: string): Rate[] {
	const rows = db
		.prepare(
			`select o.value_json as outcome, a.value_json as actual
       from observations o
       left join observations a on a.assignment_id = o.assignment_id and a.kind = 'actual_dispatch'
       where o.kind = ? and o.at_utc >= ?`,
		)
		.all(kind, since ?? "0000") as { outcome: string; actual: string | null }[];
	const groups = new Map<string, { n: number; bad: number }>();
	for (const r of rows) {
		let label: "good" | "bad" | null = null;
		let task: string | null = null;
		try {
			const v = JSON.parse(r.outcome) as { label?: string; task?: string; bad?: boolean };
			label = v.bad === undefined ? ((v.label as "good" | "bad") ?? null) : v.bad ? "bad" : "good";
			task = v.task ?? null;
		} catch {
			continue;
		}
		if (!label) continue;
		let key = "unknown";
		if (groupBy === "task") key = task ?? "unknown";
		else if (r.actual) {
			try {
				key = (JSON.parse(r.actual) as { model?: string }).model ?? "unknown";
			} catch {
				key = "unknown";
			}
		}
		const cur = groups.get(key) ?? { n: 0, bad: 0 };
		cur.n++;
		cur.bad += label === "bad" ? 1 : 0;
		groups.set(key, cur);
	}
	return [...groups.entries()]
		.map(([k, v]) => rate(k, v.n, v.bad))
		.sort((a, b) => b.n - a.n);
}

export type { DB };
export const openPipelineDb = openDb;

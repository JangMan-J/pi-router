#!/usr/bin/env node
/**
 * CLI. Every command is a thin wrapper over the same record store, so the store, not the CLI, is
 * the product: a future router in another language reads the same tables.
 *
 *   route      admit -> assess -> decide -> record -> embed, and time it
 *   ingest     attach saved pi outcomes to assignments by their stable ids
 *   calibrate  join decisions (and historical dispatch) to those outcomes
 *   consult    retrieve similar prior assignments, dense and sparse kept separate
 *   verify     check the store's ids, hashes and joins
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
// Anything this process creates (db, -wal, -shm, dirs) stays private: the store holds session text.
process.umask(0o077);
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { openDb, type Db } from "./db.ts";
import { ingestOutcomes, reportActual, reportDecisions } from "./calibrate.ts";
import { consult } from "./consult.ts";
import { drain } from "./jobs.ts";
import type { Card } from "./route.ts";
import { loadContracts, loadCatalogue, loadPipelineConfig, loadRouterConfig, makeAvailable, realAsk, routeCard, type PipelineConfig } from "./route.ts";
import { wilson } from "./ids.ts";

interface Args {
	cmd: string;
	flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
	const [cmd = "help", ...rest] = argv;
	const flags = new Map<string, string | true>();
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = rest[i + 1];
		if (next && !next.startsWith("--")) {
			flags.set(key, next);
			i++;
		} else flags.set(key, true);
	}
	return { cmd, flags };
}

const expand = (p: string | true | undefined, dflt: string): string => {
	const s = typeof p === "string" ? p : dflt;
	return s.startsWith("~/") ? resolve(homedir(), s.slice(2)) : resolve(s);
};

function dbFrom(cfg: PipelineConfig, flags: Map<string, string | true>): Db {
	const path = expand(flags.get("db"), cfg.db);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	return openDb(path);
}

function pct(xs: number[], p: number): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function cmdRoute(flags: Map<string, string | true>): Promise<void> {
	const cfg = loadPipelineConfig();
	const routerConfig = loadRouterConfig(cfg);
	const contracts = loadContracts(cfg);
	const db = dbFrom(cfg, flags);
	const catalogue = loadCatalogue(cfg.catalogue);
	const available = makeAvailable(routerConfig, catalogue);
	const ask = realAsk(cfg, routerConfig, contracts);
	const cardsPath = expand(flags.get("cards"), "");
	if (!existsSync(cardsPath)) throw new Error(`route: --cards not found: ${cardsPath}`);
	const limit = Number(typeof flags.get("limit") === "string" ? flags.get("limit") : 20);
	const cards = readFileSync(cardsPath, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.slice(0, limit)
		.map((l) => JSON.parse(l) as Card);
	const level = (typeof flags.get("level") === "string" ? flags.get("level") : "medium") as "low" | "medium" | "high";
	const embed = !flags.has("no-embed");
	let summary: string | null = null;
	if (typeof flags.get("summary") === "string") summary = readFileSync(expand(flags.get("summary"), ""), "utf8");
	const json = flags.has("json");

	const decisionMs: number[] = [];
	const embedMs: number[] = [];
	let cached = 0;
	let encoded = 0;
	let failed = 0;
	const t0 = performance.now();
	for (const card of cards) {
		const r = await routeCard(card, {
			db,
			cfg,
			routerConfig,
			contracts,
			ask,
			available,
			embed,
			level,
			projectSummary: summary ? { text: summary } : null,
		});
		decisionMs.push(r.decisionMs);
		embedMs.push(r.embedMs);
		cached += r.representations.filter((x) => x.cached).length;
		encoded += r.representations.filter((x) => !x.cached).length;
		if (r.assessments.some((a) => !a.ok)) failed++;
		if (json) {
			console.log(JSON.stringify(r));
		} else {
			const assess = r.assessments.map((a) => `${a.role}:${a.backend ?? "✗"} ${a.ms.toFixed(0)}ms`).join(" ") || "no call";
			console.log(
				`${r.model}  ${r.tier}/${r.thinking}  ${r.action}${r.lane ? ` lane=${r.lane}` : ""}  ` +
					`decide=${r.decisionMs.toFixed(0)}ms (${assess})  embed=${r.embedMs.toFixed(1)}ms  ${r.decisionId}`,
			);
		}
	}
	const wall = performance.now() - t0;
	const maxDecision = decisionMs.length ? Math.max(...decisionMs) : 0;
	console.log(`\npolicy ${cfg.policy.id}@${cfg.policy.version}`);
	console.log(
		`${cards.length} cards  decide p50 ${pct(decisionMs, 50).toFixed(0)}ms p95 ${pct(decisionMs, 95).toFixed(0)}ms max ${maxDecision.toFixed(0)}ms  ` +
			`embed p50 ${pct(embedMs, 50).toFixed(1)}ms  explicit ${maxDecision.toFixed(0)}ms  ` +
			`wall ${(wall / 1000).toFixed(1)}s  representations ${encoded} encoded / ${cached} cached  decider-failures ${failed}`,
	);
}

function cmdIngest(flags: Map<string, string | true>): void {
	const cfg = loadPipelineConfig();
	const db = dbFrom(cfg, flags);
	const file = expand(flags.get("file"), "~/.local/share/route-prior/outcomes/labelled.jsonl");
	const r = ingestOutcomes(db, file);
	console.log(`${file}\n  rows ${r.read}  joined ${r.joined}  skipped ${r.skipped}`);
	const joined = (db.prepare("select count(*) as n from decisions d join observations o on o.assignment_id = d.assignment_id and o.kind='outcome'").get() as { n: number }).n;
	console.log(`  decisions with an outcome now: ${joined}`);
}

function fmtRate(r: { key: string; n: number; bad: number; lo: number; hi: number }): string {
	return `${r.key.padEnd(52)} ${String(r.n).padStart(6)} ${(100 * (r.bad / r.n)).toFixed(0).padStart(4)}%  ${(100 * r.lo).toFixed(0)}–${(100 * r.hi).toFixed(0)}%`;
}

function cmdCalibrate(flags: Map<string, string | true>): void {
	const cfg = loadPipelineConfig();
	const epochLabel = flags.has("prehistory") ? "all records, including pre-history" : `since day 0 (${cfg.epoch})`;
	const db = dbFrom(cfg, flags);
	const by = (typeof flags.get("by") === "string" ? flags.get("by") : "model") as "model" | "task";
	const prehistory = flags.has("prehistory");
	const since = prehistory ? undefined : cfg.epoch;
	const d = reportDecisions(db, since);
	console.log(
		`${epochLabel}\n` +
			`router decisions: ${d.decisions}  with a later outcome: ${d.withOutcome}  not kept: ${d.switched}\n` +
			`  chosen model == the model that actually ran: ${d.agree} (evidence about the choice)\n` +
			`  chosen model != the model that ran: ${d.offPolicy} (off-policy: the outcome belongs to the actual model)`,
	);
	if (d.withOutcome) {
		console.log("\nturns the router sent to each model, scored by what actually happened (confounded)");
		for (const r of d.rows) console.log("  " + fmtRate(r));
		console.log("\nonly the agreement subset: turns the router would have left where they were");
		for (const r of d.agreeRows) console.log("  " + fmtRate(r));
		for (const r of d.tierRows) console.log("  " + fmtRate(r));
	} else {
		console.log("  (no decision has a linked outcome yet: run `ingest` on a labelled.jsonl that covers these turns)");
	}
	const hard = flags.has("hard");
	const a = reportActual(db, by, hard ? "hard_outcome" : "outcome", since);
	console.log(
		hard
			? `\nhistorical dispatch by ${by}, scored only by structure (abort, error stop, switch, repeated tool error, abandoned branch)`
			: `\nhistorical dispatch by ${by}, scored by the imported annotation (a decision model's reading)`,
	);
	for (const r of a.slice(0, 20)) console.log("  " + fmtRate(r));
}

async function cmdConsult(flags: Map<string, string | true>): Promise<void> {
	const cfg = loadPipelineConfig();
	const db = dbFrom(cfg, flags);
	let text = typeof flags.get("text") === "string" ? String(flags.get("text")) : "";
	if (typeof flags.get("file") === "string") text = readFileSync(expand(flags.get("file"), ""), "utf8");
	if (!text) throw new Error("consult: --text or --file required");
	const index = (typeof flags.get("index") === "string" ? flags.get("index") : "request") as "request" | "project" | "contextual";
	const k = Number(typeof flags.get("k") === "string" ? flags.get("k") : 8);
	const encoder = typeof flags.get("encoder") === "string" ? String(flags.get("encoder")) : (cfg.default_encoder?.id ?? null);
	const r = await consult(db, { text, index, k, encoders: cfg.encoders, encoder });
	console.log(`index=${r.index} encoder=${r.encoder} scanned=${r.scanned} in ${r.ms}ms`);
	for (const [label, hits] of [
		["dense", r.dense],
		["sparse", r.sparse],
	] as const) {
		console.log(`\n${label}`);
		for (const h of hits) {
			const dec = h.decision ? `${h.decision.model} ${h.decision.action}` : "no decision";
			const out = h.outcome ? `outcome=${h.outcome.label ?? "?"}${h.outcome.task ? ` task=${h.outcome.task}` : ""}` : "no outcome";
			console.log(`  ${h.score.toFixed(4)}  ${h.assignmentId ?? "?"}  ${dec.padEnd(44)}  ${out}`);
		}
	}
}

async function cmdEmbed(flags: Map<string, string | true>): Promise<void> {
	const cfg = loadPipelineConfig();
	const db = dbFrom(cfg, flags);
	const limit = Number(typeof flags.get("limit") === "string" ? flags.get("limit") : 200);
	const pending = () => Number((db.prepare("select count(*) as n from embed_jobs where status = 'pending'").get() as { n: number }).n);
	const before = pending();
	const encoders = cfg.encoders.filter((e) => e.enabled !== false);
	const out = await drain(db, encoders, { limit });
	console.log(
		`queued before ${before}  drained ${out.done}  failed ${out.failed}  pending now ${pending()}  ` +
			`encoders ${encoders.map((e) => `${e.id}@${e.version}:${e.backend ?? "local"}`).join(" ")}`,
	);
	for (const e of out.encoded.slice(0, 5)) console.log(`  ${e.encoder} ${e.ms}ms${e.cached ? " (already stored)" : ""}`);
	const failed = db.prepare("select error, count(*) n from embed_jobs where error is not null group by error").all() as { error: string; n: number }[];
	for (const f of failed) console.log(`  failed: ${f.n} × ${f.error}`);
}

function cmdVerify(flags: Map<string, string | true>): void {
	const cfg = loadPipelineConfig();
	const db = dbFrom(cfg, flags);
	const q = (sql: string, ...a: (string | number)[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
	const checks: [string, number, string][] = [
		["assignments", q("select count(*) as n from assignments"), "admitted"],
		["snapshots", q("select count(*) as n from snapshots"), "exact inputs"],
		["assessments", q("select count(*) as n from assessments"), "decider calls"],
		["decisions", q("select count(*) as n from decisions"), "policy outputs"],
		["representations", q("select count(*) as n from representations"), "cached vectors"],
		["observations", q("select count(*) as n from observations"), "outcomes + actual dispatch"],
		["retrievals", q("select count(*) as n from retrievals"), "queries"],
	];
	for (const [name, n, what] of checks) console.log(`  ${name.padEnd(16)} ${String(n).padStart(8)}  ${what}`);
	const problems: string[] = [];
	const dupAdmission = q("select count(*) as n from (select admission_key from assignments group by admission_key having count(*) > 1)");
	if (dupAdmission) problems.push(`${dupAdmission} duplicate admission keys`);
	const orphanDecisions = q("select count(*) as n from decisions d left join snapshots s on s.snapshot_id = d.snapshot_id where s.snapshot_id is null");
	if (orphanDecisions) problems.push(`${orphanDecisions} decisions without a snapshot`);
	const orphanAssessments = q("select count(*) as n from assessments a left join snapshots s on s.snapshot_id = a.snapshot_id where s.snapshot_id is null");
	if (orphanAssessments) problems.push(`${orphanAssessments} assessments without a snapshot`);
	const badInvariant = q(
		"select count(*) as n from representations where (encoder_id = 'hash-ngram' and dim != 512) or (encoder_id = 'bm25' and dim < 1) or (dim < 1)",
	);
	if (badInvariant) problems.push(`${badInvariant} representations with a wrong dim for their encoder`);
	const unlinked = q("select count(*) as n from representations r left join representation_links l on l.representation_id = r.representation_id where l.representation_id is null");
	if (unlinked) problems.push(`${unlinked} representations with no link row`);
	const schema = (db.prepare("select value from pipeline_meta where key='schema_version'").get() as { value: string } | undefined)?.value;
	const epoch = cfg.epoch ?? "none";
	const withEnv = q("select count(distinct assignment_id) as n from observations where kind='environment'");
	const decided = q("select count(distinct assignment_id) as n from decisions");
	const live = q(
		`select count(distinct d.assignment_id) as n from decisions d
     join observations o on o.assignment_id = d.assignment_id and o.kind = 'outcome' and o.at_utc >= ?`,
		epoch,
	);
	const replay = q(
		`select count(distinct d.assignment_id) as n from decisions d
     join observations o on o.assignment_id = d.assignment_id and o.kind = 'outcome' and o.at_utc < ?`,
		epoch,
	);
	console.log(`\n  schema_version ${schema}`);
	console.log(`  epoch ${epoch}`);
	console.log(`  assignments with an environment record ${withEnv}  (post-day-0 only)`);
	console.log(`  decisions ${decided}: ${live} on post-epoch turns, ${replay} replaying pre-history turns`);
	console.log(`  calibratable now: ${live}  (a pre-history turn replayed today is still pre-history evidence)`);
	if (problems.length) {
		for (const p of problems) console.log(`  FAIL ${p}`);
		process.exitCode = 1;
	} else console.log("  ok: ids are derived, links resolve, dims match their encoder");
}

async function main(): Promise<void> {
	const { cmd, flags } = parseArgs(process.argv.slice(2));
	switch (cmd) {
		case "route":
			return cmdRoute(flags);
		case "ingest":
			return cmdIngest(flags);
		case "calibrate":
			return cmdCalibrate(flags);
		case "consult":
			return cmdConsult(flags);
		case "verify":
			return cmdVerify(flags);
		case "embed":
			return cmdEmbed(flags);
		default:
			console.log(
				[
					"route      --cards <jsonl> [--limit N] [--level low|medium|high] [--no-embed] [--summary file] [--json] [--db path]",
					"ingest     [--file labelled.jsonl] [--db path]",
					"calibrate  [--by model|task] [--hard] [--prehistory] [--db path]",
					"consult    --text '...' | --file path  [--index request|project|contextual] [--encoder id] [--k 8]",
					"embed      [--limit N] [--db path]      drain the encode queue (local or remote per encoder)",
					"verify     [--db path]",
				].join("\n"),
			);
	}
}

main().catch((e) => {
	console.error(String(e instanceof Error ? e.message : e));
	process.exitCode = 1;
});

/**
 * Record store: one SQLite file, WAL, no server. Every table is append-only except for migration.
 *
 * The schema is the interface. A future router in any language reads the same tables and writes
 * observations against the same assignment ids; nothing here depends on TypeScript.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const SCHEMA_VERSION = 2;

const DDL = `
create table if not exists pipeline_meta (key text primary key, value text not null);

create table if not exists projects (
  project_id text primary key,
  project_key text not null,
  name text,
  first_seen_utc text not null
);

create table if not exists context_items (
  item_id text primary key,
  project_id text,
  kind text not null,
  source text,
  revision integer not null,
  captured_utc text not null,
  sha256 text not null,
  bytes integer not null,
  text text not null
);

create table if not exists assignments (
  assignment_id text primary key,
  admission_key text not null unique,
  origin text,
  session text,
  entry_id text,
  project_id text,
  parent_assignment_id text,
  request_text text,
  request_sha256 text,
  created_utc text not null,
  config_id text
);

create table if not exists snapshots (
  snapshot_id text primary key,
  assignment_id text not null,
  recipe_id text not null,
  recipe_version text not null,
  input_sha256 text not null,
  input_json text not null,
  chars integer not null,
  created_utc text not null
);

create table if not exists snapshot_links (
  snapshot_id text not null,
  assignment_id text not null,
  created_utc text not null,
  primary key (snapshot_id, assignment_id)
);

create table if not exists assessments (
  assessment_id text primary key,
  snapshot_id text not null,
  assignment_id text not null,
  role text not null,
  backend text,
  model text,
  contract text not null,
  contract_hash text not null,
  attempt integer not null,
  started_utc text not null,
  ms real not null,
  ok integer not null,
  status integer,
  error text,
  answers_json text,
  raw_json text
);

create table if not exists decisions (
  decision_id text primary key,
  assignment_id text not null,
  snapshot_id text not null,
  policy_id text not null,
  policy_version text not null,
  rule_id text not null,
  action text not null,
  model text not null,
  provider text,
  thinking text,
  tier text not null,
  lane text,
  reasons_json text not null,
  propensity real,
  disagreement integer not null default 0,
  fallback integer not null default 0,
  decision_ms real not null,
  basis text,
  created_utc text not null
);

create table if not exists observations (
  observation_id text primary key,
  assignment_id text not null,
  kind text not null,
  source text not null,
  method text,
  at_utc text not null,
  value_json text not null
);

create table if not exists representations (
  representation_id text primary key,
  encoder_id text not null,
  encoder_version text not null,
  recipe_id text not null,
  recipe_version text not null,
  input_sha256 text not null,
  source_record text not null,
  source_id text not null,
  dim integer not null,
  vector blob not null,
  created_utc text not null,
  unique (encoder_id, encoder_version, recipe_id, recipe_version, input_sha256)
);

create table if not exists representation_links (
  representation_id text primary key,
  assignment_id text,
  snapshot_id text,
  created_utc text not null
);

create table if not exists embed_jobs (
  job_id text primary key,
  representation_id text not null,
  encoder_id text not null,
  encoder_version text not null,
  recipe_id text not null,
  recipe_version text not null,
  input_sha256 text not null,
  text text not null,
  source_record text not null,
  source_id text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  error text,
  created_utc text not null,
  updated_utc text not null
);

create index if not exists idx_embed_jobs_status on embed_jobs(status, created_utc);

create table if not exists retrievals (
  retrieval_id text primary key,
  query_sha256 text not null,
  index_name text not null,
  method text not null,
  filters_json text,
  returned_json text not null,
  ms real not null,
  created_utc text not null
);

create index if not exists idx_snapshots_assignment on snapshots(assignment_id);
create index if not exists idx_assessments_snapshot on assessments(snapshot_id);
create index if not exists idx_decisions_assignment on decisions(assignment_id);
create index if not exists idx_observations_assignment on observations(assignment_id);
create index if not exists idx_observations_kind on observations(kind);
create index if not exists idx_representations_encoder on representations(encoder_id, encoder_version, recipe_id);
create index if not exists idx_representation_links_assignment on representation_links(assignment_id);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const db = new DatabaseSync(path);
	// The store holds session text. Keep it private even when the umask is loose.
	for (const f of [path, `${path}-wal`, `${path}-shm`]) {
		try {
			chmodSync(f, 0o600);
		} catch {
			/* -wal/-shm may not exist yet; the umask in cli.ts covers them */
		}
	}
	db.exec("pragma journal_mode = wal");
	// Two processes may write: pi records turns, the worker drains the queue.
	db.exec("pragma busy_timeout = 5000");
	db.exec("pragma synchronous = normal");
	db.exec("pragma foreign_keys = off");
	db.exec(DDL);
	const row = db.prepare("select value from pipeline_meta where key = 'schema_version'").get() as { value?: string } | undefined;
	if (!row) db.prepare("insert into pipeline_meta (key, value) values ('schema_version', ?)").run(String(SCHEMA_VERSION));
	// v2: decisions.basis says what the initial pick rested on (explicit / judgement / declared / session_keep).
	const cols = db.prepare("pragma table_info(decisions)").all() as { name: string }[];
	if (!cols.some((c) => c.name === "basis")) db.exec("alter table decisions add column basis text");
	db.prepare("insert or replace into pipeline_meta (key, value) values ('schema_version', '2')").run();
	return db;
}

export function insert(db: Db, table: string, row: Record<string, unknown>): void {
	const keys = Object.keys(row);
	const sql = `insert or ignore into ${table} (${keys.join(", ")}) values (${keys.map(() => "?").join(", ")})`;
	db.prepare(sql).run(...keys.map((k) => row[k] as string | number | null | Uint8Array));
}

export function count(db: Db, table: string, where = "1=1", ...args: (string | number)[]): number {
	const row = db.prepare(`select count(*) as n from ${table} where ${where}`).get(...args) as { n: number };
	return Number(row.n);
}

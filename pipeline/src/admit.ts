/**
 * Admission and input construction.
 *
 * Three different things are kept apart, because conflating them is how provenance gets lost:
 *   1. the exact request bytes and where they came from (assignments),
 *   2. the context items selected for the pass, with their revisions (context_items),
 *   3. the exact bytes submitted to each model, hashed (snapshots).
 *
 * A recipe names how (3) was built from (1) and (2). No recipe calls a model to summarise or judge;
 * changing a recipe creates a new id, never a silent rewrite.
 */
import { insert, type Db } from "./db.ts";
import { canonical, id as ids, sha256 } from "./ids.ts";

export interface Recipe {
	id: string;
	version: string;
	source: string;
	join?: string;
}

export function recipeText(recipe: Recipe, parts: { request?: string | null; project_summary?: string | null }): string | null {
	switch (recipe.source) {
		case "request":
			return parts.request ?? null;
		case "project_summary":
			return parts.project_summary ?? null;
		case "request+project_summary":
			if (parts.request == null || parts.project_summary == null) return null;
			return `${parts.request}${recipe.join ?? "\n\n"}${parts.project_summary}`;
		default:
			return null;
	}
}

export interface Admission {
	admissionKey: string;
	origin?: string | null;
	session?: string | null;
	entryId?: string | null;
	projectKey?: string | null;
	projectName?: string | null;
	request?: string | null;
	parentAssignmentId?: string | null;
	configId?: string | null;
	now?: string;
}

export function admit(db: Db, a: Admission): { assignmentId: string; projectId: string | null } {
	const now = a.now ?? new Date().toISOString();
	const projectId = a.projectKey ? ids.project(a.projectKey) : null;
	if (projectId) {
		insert(db, "projects", {
			project_id: projectId,
			project_key: a.projectKey,
			name: a.projectName ?? a.projectKey,
			first_seen_utc: now,
		});
	}
	const assignmentId = ids.assignment(a.admissionKey);
	insert(db, "assignments", {
		assignment_id: assignmentId,
		admission_key: a.admissionKey,
		origin: a.origin ?? null,
		session: a.session ?? null,
		entry_id: a.entryId ?? null,
		project_id: projectId,
		parent_assignment_id: a.parentAssignmentId ?? null,
		request_text: a.request ?? null,
		request_sha256: a.request != null ? sha256("request", a.request) : null,
		created_utc: now,
		config_id: a.configId ?? null,
	});
	return { assignmentId, projectId };
}

/** Store or fetch a context item revision. Revision numbers are per project, monotonic. */
export function addContextItem(
	db: Db,
	item: { projectId: string | null; kind: string; source?: string | null; text: string; now?: string },
): { itemId: string; revision: number; cached: boolean } {
	const sha = sha256("context", item.text);
	const existing = db
		.prepare("select item_id, revision from context_items where project_id is ? and sha256 = ? and kind = ?")
		.get(item.projectId, sha, item.kind) as { item_id: string; revision: number } | undefined;
	if (existing) return { itemId: existing.item_id, revision: Number(existing.revision), cached: true };
	const row = db
		.prepare("select coalesce(max(revision), 0) as r from context_items where project_id is ?")
		.get(item.projectId) as { r: number };
	const revision = Number(row.r) + 1;
	const itemId = `ctx_${sha.slice(0, 16)}`;
	insert(db, "context_items", {
		item_id: itemId,
		project_id: item.projectId,
		kind: item.kind,
		source: item.source ?? null,
		revision,
		captured_utc: item.now ?? new Date().toISOString(),
		sha256: sha,
		bytes: Buffer.byteLength(item.text),
		text: item.text,
	});
	return { itemId, revision, cached: false };
}

export interface SnapshotInput {
	assignmentId: string;
	recipe: Recipe;
	input: string;
	now?: string;
}

export function snapshot(db: Db, s: SnapshotInput): { snapshotId: string; inputSha256: string; chars: number } {
	const inputSha256 = sha256("input", s.input);
	const snapshotId = ids.snapshot(s.recipe.id, s.recipe.version, s.input);
	insert(db, "snapshots", {
		snapshot_id: snapshotId,
		assignment_id: s.assignmentId,
		recipe_id: s.recipe.id,
		recipe_version: s.recipe.version,
		input_sha256: inputSha256,
		input_json: s.input,
		chars: s.input.length,
		created_utc: s.now ?? new Date().toISOString(),
	});
	insert(db, "snapshot_links", {
		snapshot_id: snapshotId,
		assignment_id: s.assignmentId,
		created_utc: s.now ?? new Date().toISOString(),
	});
	return { snapshotId, inputSha256, chars: s.input.length };
}

/** The decider input recipe is fixed: the exact card the bench measured, canonicalised. */
export const CARD_RECIPE: Recipe = { id: "card-state", version: "1", source: "card" };

export function cardSnapshot(db: Db, assignmentId: string, state: unknown): { snapshotId: string; inputSha256: string } {
	return snapshot(db, { assignmentId, recipe: CARD_RECIPE, input: canonical(state) });
}

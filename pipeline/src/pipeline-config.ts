/**
 * Config loading with no dependency on ../router, so the live adapter can import the store without
 * creating a cycle (router -> pipeline/record -> pipeline/db, ids, jobs).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueuedEncoder } from "./jobs.ts";

export interface Recipe {
	id: string;
	version: string;
	source: string;
	join?: string;
}

export interface PipelineConfig {
	version: string;
	epoch?: string;
	epoch_note?: string;
	db: string;
	router_config: string;
	catalogue: string;
	policy: { id: string; version: string; note?: string };
	initial_mode?: "classifier" | "default";
	deciders: { order: string[]; arm: string; timeout_ms?: number };
	questions: { goal: string; axes?: string };
	encoders: QueuedEncoder[];
	default_encoder: { id: string; version: string };
	recipes: Recipe[];
	embed: { on_route: boolean; mode?: "inline" | "queue"; max_chars: number };
}

export function configPath(): string {
	return process.env.PIPELINE_CONFIG ?? new URL("../config.json", import.meta.url).pathname;
}

export function loadPipelineConfig(path = configPath()): PipelineConfig {
	const cfg = JSON.parse(readFileSync(path, "utf8")) as PipelineConfig;
	const base = new URL("..", import.meta.url).pathname;
	cfg.router_config = join(base, cfg.router_config);
	const contractRel = cfg.questions.axes ?? cfg.questions.goal;
	const contractPath = join(base, contractRel);
	cfg.questions = { goal: contractPath, axes: contractPath };
	cfg.catalogue = join(base, cfg.catalogue);
	return cfg;
}

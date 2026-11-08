import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type BreakerConfig, DEFAULT_BREAKER } from "./breaker.ts";
import { isRecord } from "./omp.ts";

/** `longHorizon:` block of OMP's config.yml (user, then project `.omp/config.yml` overrides). */
export interface LongHorizonConfig {
	/** Model role (or exact model) for Extraction. Fails loudly; never falls back to another provider. */
	extractionRole: string;
	/** Extraction runs after this many LLM calls of the main session since the last pass. */
	extractionIntervalCalls: number;
	extractionTimeoutSec: number;
	/** Max transcript characters per Extraction call; larger backlogs are processed in chunks. */
	extractionChunkChars: number;
	breaker: BreakerConfig;
	/** Identical stop-gate rejections (no Best Checkpoint change) before Run Outcome `blocked`. */
	stallRejections: number;
	/** Pacing only: shown in the header, never enforced. */
	maxLlmCalls?: number;
	maxMinutes?: number;
	/** Redacted on-disk Ledger Export, relative to the session cwd; empty string disables it. */
	mirrorPath: string;
	/** Model role for trace-reflect; unset uses the default model. */
	reflectRole?: string;
	ompBinary: string;
}

export const DEFAULT_CONFIG: LongHorizonConfig = {
	extractionRole: "smol",
	extractionIntervalCalls: 8,
	extractionTimeoutSec: 120,
	extractionChunkChars: 60_000,
	breaker: DEFAULT_BREAKER,
	stallRejections: 3,
	mirrorPath: ".omp/WORKING_MEMORY.md",
	ompBinary: "omp",
};

const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);
const optionalPositive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);

export function normalizeConfig(raw: unknown, base: LongHorizonConfig = DEFAULT_CONFIG): LongHorizonConfig {
	if (!isRecord(raw)) return base;
	const breaker = isRecord(raw.breaker) ? raw.breaker : {};
	return {
		extractionRole: typeof raw.extractionRole === "string" && raw.extractionRole.trim() ? raw.extractionRole.trim() : base.extractionRole,
		extractionIntervalCalls: positive(raw.extractionIntervalCalls, base.extractionIntervalCalls),
		extractionTimeoutSec: positive(raw.extractionTimeoutSec, base.extractionTimeoutSec),
		extractionChunkChars: positive(raw.extractionChunkChars, base.extractionChunkChars),
		breaker: { threshold: positive(breaker.threshold, base.breaker.threshold), window: positive(breaker.window, base.breaker.window) },
		stallRejections: positive(raw.stallRejections, base.stallRejections),
		maxLlmCalls: optionalPositive(raw.maxLlmCalls) ?? base.maxLlmCalls,
		maxMinutes: optionalPositive(raw.maxMinutes) ?? base.maxMinutes,
		mirrorPath: typeof raw.mirrorPath === "string" ? raw.mirrorPath : base.mirrorPath,
		reflectRole: typeof raw.reflectRole === "string" && raw.reflectRole.trim() ? raw.reflectRole.trim() : base.reflectRole,
		ompBinary: typeof raw.ompBinary === "string" && raw.ompBinary.trim() ? raw.ompBinary.trim() : base.ompBinary,
	};
}

export type YamlParser = (text: string) => unknown;

/** Reads `longHorizon` from the user then project config, like omp-cyber-harness reads `preflightRouter`. */
export function loadConfig(cwd: string, parseYaml: YamlParser): LongHorizonConfig {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
	let config = DEFAULT_CONFIG;
	for (const file of [join(agentDir, "config.yml"), join(agentDir, "config.yaml"), join(cwd, ".omp", "config.yml"), join(cwd, ".omp", "config.yaml")]) {
		if (!existsSync(file)) continue;
		try {
			const doc = parseYaml(readFileSync(file, "utf8"));
			if (isRecord(doc)) config = normalizeConfig(doc.longHorizon, config);
		} catch {
			// A malformed config is OMP's to report; keep the previous layer.
		}
	}
	return config;
}

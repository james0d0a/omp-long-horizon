/** Domain types shared by the runtime, extraction, and post-mortem tooling. See CONTEXT.md. */

export type LedgerSection = "ground_truth" | "graveyard";
export type EntryOrigin = "agent" | "extraction" | "harness";

export interface LedgerEntry {
	id: string;
	section: LedgerSection;
	text: string;
	/** Journal entry id the fact was observed in, when known. */
	source?: string;
	origin: EntryOrigin;
	at: number;
	supersededBy?: string;
	supersedeReason?: string;
}

/** Operation proposed by Extraction or the agent's `ledger` tool, before validation. */
export type LedgerOp =
	| { op: "add"; section: LedgerSection; text: string; source?: string }
	| { op: "supersede"; id: string; text: string; reason: string; source?: string }
	| { op: "set_frontier"; text: string };

/** Operation after the harness validated it and assigned ids; replayed to rebuild the ledger. */
export type AppliedOp =
	| { op: "add"; entry: LedgerEntry }
	| { op: "supersede"; id: string; reason: string; entry: LedgerEntry }
	| { op: "set_frontier"; text: string; origin: EntryOrigin; at: number };

export interface Criterion {
	id: string;
	ok: boolean;
	detail?: string;
}

export type VerifierResult =
	| { kind: "verdict"; criteria: Criterion[]; at: number; durationMs: number; pinHash: string }
	| { kind: "invalid"; reason: string; at: number; durationMs: number; output?: string };

export interface VerifierPin {
	/** Absolute path to the verifier executable. */
	path: string;
	/** Absolute path of the pinned directory (the verifier's directory). */
	dir: string;
	hash: string;
	output: "json" | "exit_code";
	timeoutSec: number;
}

export interface BestCheckpoint {
	ref: string;
	passing: string[];
	score: number;
	max: number;
	at: number;
}

export type CheckpointStrategy = "git" | "script" | "none";

export interface HorizonContract {
	/** Skill name the contract came from, or null for the generic default. */
	skill: string | null;
	ground_truth_keys: string[];
	graveyard_keys: string[];
	checkpoint_strategy: CheckpointStrategy;
	checkpoint_cmd?: string;
	/** Verifier path: relative to the project, or `skill:<relative>` for skill-shipped verifiers. */
	verifier?: string;
	verifier_output: "json" | "exit_code";
	verifier_timeout_sec: number;
	verify_interval_steps: number;
	ledger_budget_tokens: number;
}

export type RunOutcome = "passed" | "blocked" | "unverified";

export const ENTRY = {
	run: "omp-long-horizon.run",
	ledger: "omp-long-horizon.ledger",
	watermark: "omp-long-horizon.watermark",
	verify: "omp-long-horizon.verify",
	checkpoint: "omp-long-horizon.checkpoint",
	pin: "omp-long-horizon.pin",
	outcome: "omp-long-horizon.outcome",
	trip: "omp-long-horizon.trip",
} as const;

export interface RunStartData {
	action: "start";
	runId: string;
	contract: HorizonContract;
	skillDir: string | null;
	pin: VerifierPin | null;
	startedAt: number;
}

export interface RunStopData {
	action: "stop";
	runId: string;
	at: number;
}

export interface LedgerEntryData {
	runId: string;
	ops: AppliedOp[];
}

export interface VerifyEntryData {
	runId: string;
	result: VerifierResult;
}

export interface CheckpointEntryData {
	runId: string;
	checkpoint: BestCheckpoint;
}

export interface WatermarkEntryData {
	runId: string;
	entryId: string;
}

export interface PinEntryData {
	runId: string;
	pin: VerifierPin;
}

export interface OutcomeEntryData {
	runId: string;
	outcome: RunOutcome;
	detail: string;
	at: number;
}

export interface TripEntryData {
	runId: string;
	signature: string;
	failures: number;
	at: number;
}

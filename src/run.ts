import { applyOp, emptyLedger, type LedgerState } from "./ledger.ts";
import { type BranchEntry, isRecord } from "./omp.ts";
import { READ_ONLY_TOOLS } from "./signature.ts";
import {
	type BestCheckpoint,
	type CheckpointEntryData,
	ENTRY,
	type LedgerEntryData,
	type PinEntryData,
	type RunStartData,
	type VerifierPin,
	type VerifierResult,
	type VerifyEntryData,
	type WatermarkEntryData,
} from "./types.ts";

/** In-memory projection of the active Horizon Run on the current branch. */
export interface RunView {
	start: RunStartData;
	startEntryId: string;
	ledger: LedgerState;
	watermark?: string;
	pin: VerifierPin | null;
	lastVerify: { entryId: string; result: VerifierResult } | null;
	best: BestCheckpoint | null;
	checkpoints: number;
}

/** Custom entries are written only by this extension; `runId` scoping guards against stale runs on the branch. */
function dataOf<T>(entry: BranchEntry, type: string, runId?: string): T | undefined {
	if (entry.type !== "custom" || entry.customType !== type || !isRecord(entry.data)) return undefined;
	if (runId !== undefined && entry.data.runId !== runId) return undefined;
	return entry.data as T;
}

/** Rebuilds the active run (the last started run not stopped later on this branch), or null. */
export function reconstructRun(branch: readonly BranchEntry[]): RunView | null {
	let startIndex = -1;
	let start: RunStartData | undefined;
	for (let i = 0; i < branch.length; i++) {
		const data = dataOf<{ action?: string; runId?: string }>(branch[i], ENTRY.run);
		if (!data) continue;
		if (data.action === "start") {
			startIndex = i;
			start = data as RunStartData;
		} else if (data.action === "stop" && start && data.runId === start.runId) {
			start = undefined;
			startIndex = -1;
		}
	}
	if (!start || startIndex < 0) return null;
	const view: RunView = {
		start,
		startEntryId: branch[startIndex].id,
		ledger: emptyLedger(),
		pin: start.pin,
		lastVerify: null,
		best: null,
		checkpoints: 0,
	};
	const runId = start.runId;
	for (const entry of branch.slice(startIndex + 1)) {
		const ledger = dataOf<LedgerEntryData>(entry, ENTRY.ledger, runId);
		if (ledger) for (const op of ledger.ops) applyOp(view.ledger, op);
		const watermark = dataOf<WatermarkEntryData>(entry, ENTRY.watermark, runId);
		if (watermark) view.watermark = watermark.entryId;
		const pin = dataOf<PinEntryData>(entry, ENTRY.pin, runId);
		if (pin) view.pin = pin.pin;
		const verify = dataOf<VerifyEntryData>(entry, ENTRY.verify, runId);
		if (verify) view.lastVerify = { entryId: entry.id, result: verify.result };
		const checkpoint = dataOf<CheckpointEntryData>(entry, ENTRY.checkpoint, runId);
		if (checkpoint) {
			view.best = checkpoint.checkpoint;
			view.checkpoints++;
		}
	}
	return view;
}

/** Action steps (non-read-only tool results) on the branch after `entryId`; all of them when not found. */
export function actionStepsSince(branch: readonly BranchEntry[], entryId: string | undefined): number {
	let from = entryId ? branch.findIndex(e => e.id === entryId) : -1;
	if (entryId && from < 0) from = -1;
	let steps = 0;
	for (const entry of branch.slice(from + 1)) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (message?.role === "toolResult" && typeof message.toolName === "string" && !READ_ONLY_TOOLS.has(message.toolName)) steps++;
	}
	return steps;
}

export function llmCallsSince(branch: readonly BranchEntry[], entryId: string): number {
	const from = branch.findIndex(e => e.id === entryId);
	let calls = 0;
	for (const entry of branch.slice(from + 1)) if (entry.type === "message" && entry.message?.role === "assistant") calls++;
	return calls;
}

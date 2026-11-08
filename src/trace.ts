import { readFileSync } from "node:fs";
import { type BreakerConfig, DEFAULT_BREAKER, FailureWindow } from "./breaker.ts";
import { type AgentMessage, type BranchEntry, isRecord, textOf } from "./omp.ts";
import { EXEC_TOOLS, failureSignature, READ_ONLY_TOOLS } from "./signature.ts";
import { ENTRY, type VerifierResult } from "./types.ts";

/** One tool call and its result, in transcript order. */
export interface TraceStep {
	index: number;
	entryId: string;
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	isError: boolean;
	exec: boolean;
	action: boolean;
	signature?: string;
	text: string;
}

export interface VerifyMark {
	/** Number of steps that happened before this verify result. */
	afterStep: number;
	result: VerifierResult;
}

export interface Trace {
	path: string;
	entries: BranchEntry[];
	steps: TraceStep[];
	llmCalls: number;
	compactions: number;
	resets: number;
	verifies: VerifyMark[];
}

export interface ChurnWindow {
	id: string;
	kind: "trip" | "regression" | "invalid";
	signature?: string;
	startStep: number;
	endStep: number;
	recovered: boolean;
	detail: string;
}

/** Parses a session JSONL file and keeps only the path from the root to the latest leaf. */
export function loadSessionEntries(path: string): BranchEntry[] {
	const all: BranchEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed) && typeof parsed.type === "string" && typeof parsed.id === "string") {
				all.push(parsed as BranchEntry);
			}
		} catch {
			// A torn final line from a live session is expected; skip it.
		}
	}
	const byId = new Map(all.map(e => [e.id, e]));
	const path_: BranchEntry[] = [];
	for (let cur = all.at(-1); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
		path_.push(cur);
		if (path_.length > all.length) break;
	}
	return path_.reverse();
}

function toolCallsOf(message: AgentMessage): Map<string, Record<string, unknown>> {
	const calls = new Map<string, Record<string, unknown>>();
	if (!Array.isArray(message.content)) return calls;
	for (const block of message.content) {
		if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
			calls.set(block.id, isRecord(block.arguments) ? block.arguments : {});
		}
	}
	return calls;
}

/** Builds steps from journal entries (works for live branches and on-disk sessions alike). */
export function buildTrace(entries: BranchEntry[], path = "<branch>"): Trace {
	const steps: TraceStep[] = [];
	const verifies: VerifyMark[] = [];
	const pendingInputs = new Map<string, Record<string, unknown>>();
	let llmCalls = 0;
	let compactions = 0;
	let resets = 0;
	for (const entry of entries) {
		if (entry.type === "compaction") compactions++;
		if (entry.type === "reset_boundary") resets++;
		if (entry.type === "custom" && entry.customType === ENTRY.verify && isRecord(entry.data) && isRecord(entry.data.result)) {
			verifies.push({ afterStep: steps.length, result: entry.data.result as unknown as VerifierResult });
		}
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "assistant") {
			llmCalls++;
			for (const [id, input] of toolCallsOf(message)) pendingInputs.set(id, input);
			continue;
		}
		if (message.role !== "toolResult" || typeof message.toolName !== "string") continue;
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
		const input = pendingInputs.get(toolCallId) ?? {};
		pendingInputs.delete(toolCallId);
		const text = textOf(message.content);
		const exec = EXEC_TOOLS.has(message.toolName);
		const isError = message.isError === true;
		steps.push({
			index: steps.length,
			entryId: entry.id,
			toolCallId,
			toolName: message.toolName,
			input,
			isError,
			exec,
			action: !READ_ONLY_TOOLS.has(message.toolName),
			signature: exec ? failureSignature({ toolName: message.toolName, input, resultText: text, details: message.details }) : undefined,
			text,
		});
	}
	return { path, entries, steps, llmCalls, compactions, resets, verifies };
}

export function loadTrace(path: string): Trace {
	return buildTrace(loadSessionEntries(path), path);
}

/** `bash:ansible-playbook site.yml` → `bash:ansible-playbook`; `bash:python3:inline:x` → `bash:python3`. */
export function signatureFamily(signature: string): string {
	const [tool, rest = ""] = signature.split(/:(.*)/s);
	return `${tool}:${rest.split(/[ :]/)[0]}`;
}

const RECOVERY_HORIZON = 40;

/** Simulates the Circuit Breaker over the trace and pairs each trip with its recovery. */
export function tripWindows(trace: Trace, config: BreakerConfig = DEFAULT_BREAKER): ChurnWindow[] {
	const window = new FailureWindow(config);
	const out: ChurnWindow[] = [];
	const execSteps = trace.steps.filter(s => s.exec && s.signature);
	for (let i = 0; i < execSteps.length; i++) {
		const step = execSteps[i];
		const signature = step.signature ?? "";
		const failures = window.record(signature, step.isError);
		if (failures === undefined) continue;
		const lookback = execSteps.slice(Math.max(0, i - config.window + 1), i + 1);
		const start = lookback.find(s => s.signature === signature && s.isError) ?? step;
		const family = signatureFamily(signature);
		const later = execSteps.slice(i + 1, i + 1 + RECOVERY_HORIZON);
		const recovery =
			later.find(s => !s.isError && s.signature === signature) ?? later.find(s => !s.isError && s.signature && signatureFamily(s.signature) === family);
		out.push({
			id: `w${out.length + 1}`,
			kind: "trip",
			signature,
			startStep: start.index,
			endStep: recovery?.index ?? (later.at(-1)?.index ?? step.index),
			recovered: recovery !== undefined,
			detail: `${failures} failures of ${signature}`,
		});
	}
	return out;
}

/** Regression and Invalid Result windows from recorded Verifier results (Horizon Runs only). */
export function verifierWindows(trace: Trace, firstId = 1): ChurnWindow[] {
	const out: ChurnWindow[] = [];
	let bestPassing = new Set<string>();
	let openRegression: { start: number; lost: string[] } | undefined;
	let invalidRun: number[] = [];
	for (const mark of trace.verifies) {
		if (mark.result.kind === "invalid") {
			invalidRun.push(mark.afterStep);
			continue;
		}
		if (invalidRun.length >= 2) {
			out.push({
				id: `w${firstId + out.length}`,
				kind: "invalid",
				startStep: invalidRun[0],
				endStep: mark.afterStep,
				recovered: true,
				detail: `${invalidRun.length} consecutive Invalid Results before a valid verdict`,
			});
		}
		invalidRun = [];
		const passing = new Set(mark.result.criteria.filter(c => c.ok).map(c => c.id));
		const lost = [...bestPassing].filter(id => !passing.has(id));
		if (lost.length > 0 && !openRegression) openRegression = { start: mark.afterStep, lost };
		if (openRegression && openRegression.lost.every(id => passing.has(id))) {
			out.push({
				id: `w${firstId + out.length}`,
				kind: "regression",
				startStep: openRegression.start,
				endStep: mark.afterStep,
				recovered: true,
				detail: `Regression of ${openRegression.lost.join(", ")}`,
			});
			openRegression = undefined;
		}
		if ([...bestPassing].every(id => passing.has(id)) && passing.size > bestPassing.size) bestPassing = passing;
	}
	if (openRegression) {
		out.push({
			id: `w${firstId + out.length}`,
			kind: "regression",
			startStep: openRegression.start,
			endStep: trace.steps.length - 1,
			recovered: false,
			detail: `Unrecovered Regression of ${openRegression.lost.join(", ")}`,
		});
	}
	return out;
}

export function churnWindows(trace: Trace, config: BreakerConfig = DEFAULT_BREAKER): ChurnWindow[] {
	const trips = tripWindows(trace, config);
	return [...trips, ...verifierWindows(trace, trips.length + 1)];
}

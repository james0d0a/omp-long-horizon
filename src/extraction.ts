import { applyProposedOps, type LedgerState, listEntries, type ValidationResult } from "./ledger.ts";
import { type BranchEntry, isRecord, textOf } from "./omp.ts";
import { extractJson } from "./proc.ts";
import type { HorizonContract } from "./types.ts";

export interface SliceChunk {
	text: string;
	/** Journal id of the last entry in the chunk; becomes the new watermark once applied. */
	lastEntryId: string;
	sourceIds: Set<string>;
}

const RESULT_HEAD = 1500;
const RESULT_TAIL = 1500;
const HORIZON_PREFIX = "omp-long-horizon.";

const clip = (text: string) =>
	text.length <= RESULT_HEAD + RESULT_TAIL ? text : `${text.slice(0, RESULT_HEAD)}\n…[${text.length - RESULT_HEAD - RESULT_TAIL} chars elided]…\n${text.slice(-RESULT_TAIL)}`;

/** Renders one journal entry for the extraction transcript, or undefined when it carries nothing to extract. */
export function serializeEntry(entry: BranchEntry): string | undefined {
	if (entry.type === "custom_message") {
		if (typeof entry.customType === "string" && entry.customType.startsWith(HORIZON_PREFIX)) return `[${entry.id}] HARNESS: ${clip(textOf(entry.content))}`;
		const text = typeof entry.content === "string" ? entry.content : textOf(entry.content);
		return text ? `[${entry.id}] NOTE: ${clip(text)}` : undefined;
	}
	if (entry.type !== "message" || !entry.message) return undefined;
	const message = entry.message;
	if (message.role === "user") {
		const text = textOf(message.content);
		return text ? `[${entry.id}] USER: ${clip(text)}` : undefined;
	}
	if (message.role === "assistant") {
		const parts: string[] = [];
		for (const block of Array.isArray(message.content) ? message.content : []) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string" && block.text.trim()) parts.push(`ASSISTANT: ${block.text.trim()}`);
			if (block.type === "toolCall") parts.push(`CALL ${String(block.name)}: ${clip(JSON.stringify(block.arguments ?? {}))}`);
		}
		return parts.length ? `[${entry.id}] ${parts.join("\n")}` : undefined;
	}
	if (message.role === "toolResult") {
		const status = message.isError ? "ERROR" : "ok";
		return `[${entry.id}] RESULT ${String(message.toolName)} (${status}): ${clip(textOf(message.content))}`;
	}
	return undefined;
}

/**
 * Entries after the watermark (or after `startId` when the watermark is not on this branch,
 * e.g. after a rewind), split into chunks of at most `chunkChars`.
 */
export function sliceSince(branch: BranchEntry[], watermark: string | undefined, startId: string, chunkChars: number): SliceChunk[] {
	let from = watermark ? branch.findIndex(e => e.id === watermark) : -1;
	if (from < 0) from = branch.findIndex(e => e.id === startId);
	const chunks: SliceChunk[] = [];
	let current: SliceChunk | undefined;
	for (const entry of branch.slice(from + 1)) {
		const line = serializeEntry(entry);
		if (!line) {
			if (current) current.lastEntryId = entry.id;
			continue;
		}
		if (!current || (current.text.length + line.length > chunkChars && current.text.length > 0)) {
			current = { text: "", lastEntryId: entry.id, sourceIds: new Set() };
			chunks.push(current);
		}
		current.text += `${line}\n`;
		current.lastEntryId = entry.id;
		current.sourceIds.add(entry.id);
	}
	return chunks;
}

export const EXTRACTION_SYSTEM_PROMPT = `You are the state-preservation engine for a long-horizon autonomous agent.
You read a transcript slice and propose updates to the agent's Working Memory Ledger as JSON operations.
You never rewrite the ledger; you only propose operations, which the harness validates and applies.
Output ONLY one JSON object, no prose.`;

export function buildExtractionPrompt(contract: HorizonContract, ledger: LedgerState, chunk: SliceChunk): string {
	return `RULES
1. Record only what the transcript shows. Ground Truth must be verified by observed output, not intended or assumed.
2. Preserve exact literals: IPs, hostnames, ports, hex offsets, register names, file paths, CLI flags, credentials, error codes and messages. Never paraphrase a literal.
3. Graveyard entries name the exact command/approach AND the exact failure signal (error text or code), so it is never retried blindly.
4. Do not add an entry that is already in the ledger. If new evidence proves a current entry wrong or outdated, use "supersede" with its id and a reason.
5. "source" is the [id] of the transcript entry that shows the fact.
6. Set the frontier only if the transcript shows what the agent is pursuing next; one or two sentences.
7. If nothing qualifies, return {"ops": []}.

GROUND TRUTH TO EXTRACT
${contract.ground_truth_keys.map(k => `- ${k}`).join("\n")}

GRAVEYARD TO EXTRACT (falsified hypotheses / failed approaches)
${contract.graveyard_keys.map(k => `- ${k}`).join("\n")}

OUTPUT SCHEMA
{"ops": [
4. Do not add an entry the ledger already covers, even if worded differently (same command family and same failure, or same fact). Add only genuinely new information. If new evidence proves a current entry wrong or outdated, use "supersede" with its id and a reason.
  {"op": "supersede", "id": "<gtN|gyN>", "text": "replacement", "reason": "why the old entry is wrong", "source": "<entry id>"},
  {"op": "set_frontier", "text": "..."}
]}

CURRENT LEDGER
${listEntries(ledger, "all")}

TRANSCRIPT SLICE
${chunk.text}`;
}

/** Parses model output and applies the valid ops to `ledger` (mutates). Throws when the output is not usable JSON. */
export function applyExtractionOutput(ledger: LedgerState, output: string, chunk: SliceChunk, now: number): ValidationResult {
	const parsed = extractJson(output);
	const ops = isRecord(parsed) && Array.isArray(parsed.ops) ? parsed.ops : Array.isArray(parsed) ? parsed : undefined;
	if (!ops) throw new Error('extraction output has no "ops" array');
	return applyProposedOps(ledger, ops, { origin: "extraction", now, validSources: chunk.sourceIds });
}

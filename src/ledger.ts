import { isRecord } from "./omp.ts";
import type { AppliedOp, BestCheckpoint, EntryOrigin, LedgerEntry, LedgerOp, LedgerSection } from "./types.ts";

export interface Frontier {
	text: string;
	origin: EntryOrigin;
	at: number;
}

export interface LedgerState {
	entries: LedgerEntry[];
	frontier: Frontier | null;
}

export const MAX_ENTRY_CHARS = 600;
const SECTIONS: readonly LedgerSection[] = ["ground_truth", "graveyard"];
const PREFIX: Record<LedgerSection, string> = { ground_truth: "gt", graveyard: "gy" };

export function emptyLedger(): LedgerState {
	return { entries: [], frontier: null };
}

/** Applies one already-validated op. The only mutation path, shared by live writes and replay. */
export function applyOp(state: LedgerState, op: AppliedOp): void {
	if (op.op === "set_frontier") {
		state.frontier = { text: op.text, origin: op.origin, at: op.at };
		return;
	}
	if (op.op === "supersede") {
		const old = state.entries.find(e => e.id === op.id);
		if (old) {
			old.supersededBy = op.entry.id;
			old.supersedeReason = op.reason;
		}
	}
	state.entries.push({ ...op.entry });
}

export function current(state: LedgerState, section: LedgerSection): LedgerEntry[] {
	return state.entries.filter(e => e.section === section && !e.supersededBy);
}

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

function nextId(state: LedgerState, section: LedgerSection): string {
	const prefix = PREFIX[section];
	let max = 0;
	for (const e of state.entries) {
		if (e.section === section) max = Math.max(max, Number(e.id.slice(prefix.length)) || 0);
	}
	return `${prefix}${max + 1}`;
}

export interface ValidationResult {
	applied: AppliedOp[];
	rejected: { op: unknown; reason: string }[];
}

export interface ValidationOptions {
	origin: EntryOrigin;
	now: number;
	/** When given, a `source` outside this set is dropped (not rejected): provenance must be real. */
	validSources?: ReadonlySet<string>;
}

/**
 * Validates proposed ops against the ledger and applies the accepted ones to `state`.
 * Ground Truth and Graveyard are append-only: an entry stops being current only through
 * Supersession with a stated reason. Exact duplicates of current entries are skipped.
 */
export function applyProposedOps(state: LedgerState, ops: readonly unknown[], options: ValidationOptions): ValidationResult {
	const result: ValidationResult = { applied: [], rejected: [] };
	for (const raw of ops) {
		const op = parseOp(raw);
		if (typeof op === "string") {
			result.rejected.push({ op: raw, reason: op });
			continue;
		}
		const text = op.text.trim();
		const source = "source" in op && op.source && (!options.validSources || options.validSources.has(op.source)) ? op.source : undefined;
		if (op.op === "set_frontier") {
			const applied: AppliedOp = { op: "set_frontier", text, origin: options.origin, at: options.now };
			applyOp(state, applied);
			result.applied.push(applied);
			continue;
		}
		if (op.op === "add") {
			const dup = current(state, op.section).find(e => normalize(e.text) === normalize(text));
			if (dup) {
				result.rejected.push({ op: raw, reason: `duplicate of ${dup.id}` });
				continue;
			}
			const entry: LedgerEntry = { id: nextId(state, op.section), section: op.section, text, source, origin: options.origin, at: options.now };
			const applied: AppliedOp = { op: "add", entry };
			applyOp(state, applied);
			result.applied.push(applied);
			continue;
		}
		const target = state.entries.find(e => e.id === op.id);
		if (!target) {
			result.rejected.push({ op: raw, reason: `unknown id ${op.id}` });
			continue;
		}
		if (target.supersededBy) {
			result.rejected.push({ op: raw, reason: `${op.id} already superseded by ${target.supersededBy}` });
			continue;
		}
		const entry: LedgerEntry = { id: nextId(state, target.section), section: target.section, text, source, origin: options.origin, at: options.now };
		const applied: AppliedOp = { op: "supersede", id: op.id, reason: op.reason.trim(), entry };
		applyOp(state, applied);
		result.applied.push(applied);
	}
	return result;
}

/** Parses one untrusted op (model output or tool input); returns a reason string when invalid. */
export function parseOp(raw: unknown): LedgerOp | string {
	if (!isRecord(raw)) return "op must be an object";
	const text = typeof raw.text === "string" ? raw.text.trim() : "";
	if (!text) return "text is required";
	if (text.length > MAX_ENTRY_CHARS) return `text exceeds ${MAX_ENTRY_CHARS} chars; split it`;
	const source = typeof raw.source === "string" && raw.source.trim() ? raw.source.trim() : undefined;
	switch (raw.op) {
		case "add": {
			const section = SECTIONS.find(s => s === raw.section);
			if (!section) return `section must be one of ${SECTIONS.join(", ")}`;
			return { op: "add", section, text, source };
		}
		case "supersede": {
			if (typeof raw.id !== "string" || !raw.id.trim()) return "supersede requires id";
			if (typeof raw.reason !== "string" || !raw.reason.trim()) return "supersede requires a reason";
			return { op: "supersede", id: raw.id.trim(), text, reason: raw.reason, source };
		}
		case "set_frontier":
			return { op: "set_frontier", text };
		default:
			return "op must be add, supersede, or set_frontier";
	}
}

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface RenderOptions {
	budgetTokens: number;
	header: string;
	best?: BestCheckpoint | null;
	notices?: string[];
	readOnly?: boolean;
}

const line = (e: LedgerEntry) => `- [${e.id}] ${e.text}${e.source ? ` (src ${e.source})` : ""}`;

/**
 * Renders the ledger for injection. Frontier, Best Checkpoint and all current Ground Truth are
 * always rendered; the Graveyard is rendered newest-first until the budget is spent, and the
 * remainder is replaced with a pointer to `ledger read`.
 */
export function renderLedger(state: LedgerState, options: RenderOptions): string {
	const head: string[] = [options.header, ...(options.notices ?? [])];
	head.push("", "## Frontier", state.frontier ? state.frontier.text : "- Not set.");
	head.push("", "## Best Checkpoint");
	head.push(
		options.best
			? `- ${options.best.ref} — ${options.best.score}/${options.best.max} criteria (passing: ${options.best.passing.join(", ") || "none"})`
			: "- None yet.",
	);
	const groundTruth = current(state, "ground_truth");
	head.push("", "## Ground Truth (verified; exact literals)");
	head.push(...(groundTruth.length ? groundTruth.map(line) : ["- None recorded yet."]));
	const graveyard = current(state, "graveyard");
	const footer = options.readOnly
		? "Ledger is read-only in this subagent; report discoveries and dead ends in your final answer."
		: "Record verified facts and falsified approaches with the `ledger` tool (op add / supersede / set_frontier). Never retry a Graveyard entry.";
	const fixed = `${head.join("\n")}\n\n## Graveyard (falsified — DO NOT RETRY)\n\n${footer}`;
	let budget = options.budgetTokens - estimateTokens(fixed);
	const shown: string[] = [];
	for (const entry of [...graveyard].reverse()) {
		const rendered = line(entry);
		const cost = estimateTokens(rendered) + 1;
		if (cost > budget) break;
		budget -= cost;
		shown.push(rendered);
	}
	const hidden = graveyard.length - shown.length;
	const graveLines = graveyard.length === 0 ? ["- None recorded yet."] : shown;
	if (hidden > 0) graveLines.push(`- …${hidden} older Graveyard entries not shown: call \`ledger\` with read="graveyard".`);
	return [`${head.join("\n")}`, "", "## Graveyard (falsified — DO NOT RETRY)", ...graveLines, "", footer].join("\n");
}

/** Full listing for `ledger read`, including superseded history when requested. */
export function listEntries(state: LedgerState, which: "all" | LedgerSection | "history"): string {
	if (which === "history") {
		const superseded = state.entries.filter(e => e.supersededBy);
		return superseded.length
			? superseded.map(e => `- [${e.id}] ${e.text} → superseded by ${e.supersededBy}: ${e.supersedeReason}`).join("\n")
			: "No superseded entries.";
	}
	const sections = which === "all" ? SECTIONS : [which];
	return sections
		.map(s => {
			const entries = current(state, s);
			return `## ${s}\n${entries.length ? entries.map(line).join("\n") : "- none"}`;
		})
		.join("\n\n");
}

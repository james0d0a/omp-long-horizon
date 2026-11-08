import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { FailureWindow } from "./breaker.ts";
import { gitSnapshot, scriptCheckpoint } from "./checkpoint.ts";
import { type LongHorizonConfig, loadConfig } from "./config.ts";
import { loadContract, resolveSkillDir } from "./contract.ts";
import { applyExtractionOutput, buildExtractionPrompt, EXTRACTION_SYSTEM_PROMPT, sliceSince } from "./extraction.ts";
import { applyProposedOps, current, listEntries, renderLedger } from "./ledger.ts";
import type { ExtensionAPI, ExtensionContext } from "./omp.ts";
import { isRecord, textOf } from "./omp.ts";
import { ompOneShot } from "./proc.ts";
import { redact } from "./redact.ts";
import { runReflect } from "./reflect.ts";
import { actionStepsSince, llmCallsSince, reconstructRun, type RunView } from "./run.ts";
import { EXEC_TOOLS, failureSignature, inlineScriptSignature, READ_ONLY_TOOLS } from "./signature.ts";
import { type AppliedOp, type BestCheckpoint, ENTRY, type LedgerSection, type RunOutcome } from "./types.ts";
import { assessProgress, createPin, formatVerdict, resolveVerifierPath, runVerifier } from "./verifier.ts";

/** Bun's YAML parser inside OMP; outside it (node tests, scripts) only the JSON subset of YAML is accepted. */
const parseYaml = (text: string): unknown => (globalThis.Bun ? globalThis.Bun.YAML.parse(text) : JSON.parse(text));

/**
 * Subagents run their own extension instance (fresh API, shared module scope). The main
 * session publishes a read-only view of its ledger here so subagents see Ground Truth and the
 * Graveyard without being able to write (the main session is the only writer).
 */
let mainLedgerView: { render(): string; list(which: "all" | LedgerSection | "history"): string } | null = null;

const HORIZON_TOOLS = new Set(["ledger", "verify"]);
const WRITE_TOOLS = new Set(["write", "edit", "ast_edit", "apply_patch", "notebook"]);
const SHELL_WRITE = /(^|[\s;&|])(>|>>|tee\b|sed\s+-i|perl\s+-[a-z]*i|cp\b|mv\b|rm\b|chmod\b|truncate\b|install\b|rsync\b|dd\b|patch\b|python3?\s+(-[ce]|-?\s*<<)|node\s+-e|bun\s+-e|ruby\s+-e|git\s+(checkout|restore|apply|stash))/;

interface TripState {
	signature: string;
	savedTools: string[];
	/** Reflection responses seen since the trip; starts at -1 because the tripping turn's own turn_end follows. */
	calls: number;
	at: number;
}

interface ExtractionState {
	inFlight: boolean;
	callsSince: number;
	stalled: { since: number; reason: string } | null;
}

export default function omplongHorizon(pi: ExtensionAPI): void {
	pi.setLabel("OMP Long-Horizon Engine");
	pi.registerFlag("horizon", { description: "Start a Horizon Run bound to this skill's contract (or 'default')", type: "string" });
	pi.registerFlag("horizon-verifier", { description: "Verifier executable for the Horizon Run (overrides the contract)", type: "string" });

	let config: LongHorizonConfig | undefined;
	let run: RunView | null = null;
	let isSub = false;
	const window = { breaker: new FailureWindow() };
	const recentErrors = new Map<string, string[]>();
	let trip: TripState | null = null;
	let extraction: ExtractionState = { inFlight: false, callsSince: 0, stalled: null };
	let continueAfterReflection = false;
	let gate = { key: "", count: 0, bestRef: "" };
	let lastVerifyNudge = 0;

	const cfg = (ctx: ExtensionContext) => {
		config ??= loadConfig(ctx.cwd, parseYaml);
		return config;
	};

	const status = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!run) {
			ctx.ui.setStatus("horizon", undefined);
			return;
		}
		const gt = current(run.ledger, "ground_truth").length;
		const gy = current(run.ledger, "graveyard").length;
		const verdict = run.lastVerify?.result;
		const score = !run.pin ? "no verifier" : !verdict ? "unverified" : verdict.kind === "invalid" ? "INVALID" : `${verdict.criteria.filter(c => c.ok).length}/${verdict.criteria.length}`;
		const flags = [trip ? "BREAKER" : "", extraction.stalled ? "extraction stalled" : ""].filter(Boolean).join(" ");
		ctx.ui.setStatus("horizon", `horizon ${run.start.contract.skill ?? "default"} | gt ${gt} gy ${gy} | ${score}${flags ? ` | ${flags}` : ""}`);
	};

	const mirror = (ctx: ExtensionContext) => {
		const path = cfg(ctx).mirrorPath;
		if (!run || !path) return;
		try {
			const file = resolve(ctx.cwd, path);
			mkdirSync(dirname(file), { recursive: true });
			const body = `# WORKING MEMORY — Horizon Run ${run.start.runId} (${run.start.contract.skill ?? "default contract"})\n\n> Read-only Ledger Export, secret-redacted. Source of truth is the session journal.\n\n## Frontier\n${run.ledger.frontier?.text ?? "Not set."}\n\n## Best Checkpoint\n${run.best ? `${run.best.ref} — ${run.best.score}/${run.best.max}` : "None"}\n\n${listEntries(run.ledger, "all")}\n\n## Superseded\n${listEntries(run.ledger, "history")}\n`;
			writeFileSync(file, redact(body));
		} catch (err) {
			ctx.ui.notify(`horizon: cannot write ledger mirror: ${String(err)}`, "warning");
		}
	};

	const publish = (ctx: ExtensionContext) => {
		if (isSub) return;
		const active = run;
		mainLedgerView = active
			? {
					render: () =>
						renderLedger(active.ledger, {
							budgetTokens: active.start.contract.ledger_budget_tokens,
							header: `[OMP Horizon | parent run ${active.start.runId} | read-only view]`,
							best: active.best,
							readOnly: true,
						}),
					list: which => listEntries(active.ledger, which),
				}
			: null;
		status(ctx);
	};

	/** `ledger`/`verify` are registered inactive and switched on only while they can work, so other sessions pay nothing. */
	const syncTools = async () => {
		const want = new Set<string>();
		if (run) {
			want.add("ledger");
			if (run.pin) want.add("verify");
		} else if (isSub && mainLedgerView) want.add("ledger");
		const active = pi.getActiveTools();
		const next = active.filter(t => !HORIZON_TOOLS.has(t) || want.has(t));
		for (const t of want) if (!next.includes(t)) next.push(t);
		if (next.length !== active.length || next.some((t, i) => t !== active[i])) await pi.setActiveTools(next);
	};

	const rebuild = async (ctx: ExtensionContext) => {
		isSub = ctx.agent?.kind === "sub";
		run = isSub ? null : reconstructRun(ctx.sessionManager.getBranch());
		window.breaker = new FailureWindow(cfg(ctx).breaker);
		recentErrors.clear();
		trip = null;
		continueAfterReflection = false;
		gate = { key: "", count: 0, bestRef: "" };
		lastVerifyNudge = 0;
		extraction = { inFlight: false, callsSince: 0, stalled: null };
		publish(ctx);
		await syncTools();
	};

	const commitLedgerOps = (ctx: ExtensionContext, ops: AppliedOp[]) => {
		if (!run || ops.length === 0) return;
		pi.appendEntry(ENTRY.ledger, { runId: run.start.runId, ops });
		mirror(ctx);
		status(ctx);
	};

	const recordOutcome = (ctx: ExtensionContext, outcome: RunOutcome, detail: string) => {
		if (!run) return;
		pi.appendEntry(ENTRY.outcome, { runId: run.start.runId, outcome, detail, at: Date.now() });
		ctx.ui.notify(`Horizon Run ${run.start.runId}: outcome ${outcome}${detail ? ` — ${detail}` : ""}`, outcome === "passed" ? "info" : "warning");
	};

	// ── Extraction ─────────────────────────────────────────────────────────────

	const runExtraction = async (ctx: ExtensionContext) => {
		if (!run || isSub || extraction.inFlight) return;
		extraction.inFlight = true;
		extraction.callsSince = 0;
		const runId = run.start.runId;
		const settings = cfg(ctx);
		try {
			for (let pass = 0; pass < 20; pass++) {
				const branch = ctx.sessionManager.getBranch();
				if (!run || run.start.runId !== runId) return;
				const [chunk] = sliceSince(branch, run.watermark, run.startEntryId, settings.extractionChunkChars);
				if (!chunk) break;
				const output = await ompOneShot({
					ompBinary: settings.ompBinary,
					model: settings.extractionRole,
					systemPrompt: EXTRACTION_SYSTEM_PROMPT,
					prompt: buildExtractionPrompt(run.start.contract, run.ledger, chunk),
					timeoutMs: settings.extractionTimeoutSec * 1000,
					cwd: ctx.cwd,
				});
				const view = run;
				if (!view || view.start.runId !== runId) return;
				if (!ctx.sessionManager.getBranch().some(e => e.id === chunk.lastEntryId)) return; // branch moved (rewind); next pass re-slices
				const result = applyExtractionOutput(view.ledger, output, chunk, Date.now());
				commitLedgerOps(ctx, result.applied);
				pi.appendEntry(ENTRY.watermark, { runId, entryId: chunk.lastEntryId });
				view.watermark = chunk.lastEntryId;
			}
			if (extraction.stalled) ctx.ui.notify("horizon: extraction recovered; ledger is current", "info");
			extraction.stalled = null;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (extraction.stalled?.reason !== reason) ctx.ui.notify(`horizon: EXTRACTION FAILED (${settings.extractionRole}): ${reason}. Ledger is stale until it succeeds; no fallback model is used.`, "error");
			extraction.stalled = { since: extraction.stalled?.since ?? Date.now(), reason };
		} finally {
			extraction.inFlight = false;
			status(ctx);
		}
	};

	const kickExtraction = (ctx: ExtensionContext) => {
		runExtraction(ctx).catch(err => ctx.ui.notify(`horizon: extraction crashed: ${String(err)}`, "error"));
	};

	// ── Circuit breaker ────────────────────────────────────────────────────────

	const tripBreaker = async (signature: string, failures: number) => {
		const savedTools = pi.getActiveTools();
		const allowed = savedTools.filter(t => READ_ONLY_TOOLS.has(t));
		await pi.setActiveTools(allowed);
		trip = { signature, savedTools, calls: -1, at: Date.now() };
		const errors = (recentErrors.get(signature) ?? []).map((e, i) => `  ${i + 1}. ${e}`).join("\n");
		const record = isSub
			? "2. State the falsified assumption explicitly in your reply (the ledger is read-only in subagents)."
			: '2. Record the falsified assumption with the `ledger` tool: {"ops":[{"op":"add","section":"graveyard","text":"<exact command/approach> → <exact failure>"}]}.';
		pi.sendMessage(
			{
				customType: "omp-long-horizon.trip",
				content: `[HARNESS CIRCUIT BREAKER TRIPPED: ${failures} failures of \`${signature}\`]\nAction tools are locked for this step. Do NOT attempt another command execution yet.\n1. State the exact root cause shared across the failed attempts.\n${record}\n3. Formulate a fundamentally different diagnostic approach for the next step.\nRecent failures:\n${errors}`,
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "steer" },
		);
		if (run) pi.appendEntry(ENTRY.trip, { runId: run.start.runId, signature, failures, at: Date.now() });
	};

	const unlockBreaker = async () => {
		if (!trip) return;
		const saved = trip.savedTools;
		trip = null;
		await pi.setActiveTools(saved);
	};

	const runActive = () => run !== null || (isSub && mainLedgerView !== null);

	// ── Run lifecycle ──────────────────────────────────────────────────────────

	const startRun = async (ctx: ExtensionContext, skillArg: string | null, verifierOverride?: string) => {
		if (isSub) throw new Error("Horizon Runs start in the main session only");
		if (run) throw new Error(`Horizon Run ${run.start.runId} is already active; /horizon stop first`);
		const settings = cfg(ctx);
		const skill = skillArg && skillArg !== "default" ? skillArg : null;
		const skillDir = skill ? await resolveSkillDir(skill, settings.ompBinary, ctx.cwd) : null;
		const { contract, warnings } = loadContract(skill, skillDir, parseYaml);
		const verifierPath = resolveVerifierPath(contract, skillDir, ctx.cwd, verifierOverride);
		const pin = verifierPath ? createPin(verifierPath, contract) : null;
		const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
		const runId = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
		pi.appendEntry(ENTRY.run, { action: "start", runId, contract, skillDir, pin, startedAt: Date.now() });
		await rebuild(ctx);
		mirror(ctx);
		for (const w of warnings) ctx.ui.notify(`horizon: ${w}`, "warning");
		ctx.ui.notify(
			`Horizon Run ${runId} started (contract: ${skill ?? "default"}; verifier: ${pin ? `${relative(ctx.cwd, pin.path)} pinned ${pin.hash.slice(0, 12)}` : "none — outcome will be unverified"})`,
			"info",
		);
	};

	const stopRun = async (ctx: ExtensionContext) => {
		if (!run) throw new Error("No Horizon Run is active");
		await unlockBreaker();
		pi.appendEntry(ENTRY.run, { action: "stop", runId: run.start.runId, at: Date.now() });
		const id = run.start.runId;
		await rebuild(ctx);
		ctx.ui.notify(`Horizon Run ${id} stopped`, "info");
	};

	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		pi.on(event, async (_e, ctx) => {
			config = undefined;
			await rebuild(ctx);
			if (event !== "session_start" || isSub || run) return;
			const flag = pi.getFlag("horizon");
			if (typeof flag !== "string" || !flag.trim()) return;
			const verifier = pi.getFlag("horizon-verifier");
			try {
				await startRun(ctx, flag.trim(), typeof verifier === "string" && verifier.trim() ? verifier.trim() : undefined);
			} catch (err) {
				ctx.ui.notify(`horizon: cannot start run: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		});
	}

	// ── Ledger injection (every LLM call) ──────────────────────────────────────

	pi.on("context", async (event, ctx) => {
		if (!Array.isArray(event.messages)) return;
		let text: string | undefined;
		if (run) {
			const branch = ctx.sessionManager.getBranch();
			const settings = cfg(ctx);
			const calls = llmCallsSince(branch, run.startEntryId);
			const minutes = Math.round((Date.now() - run.start.startedAt) / 60_000);
			const usage = ctx.getContextUsage?.();
			const verdict = run.lastVerify?.result;
			let verifier = "none";
			if (run.pin) {
				const stale = run.lastVerify ? actionStepsSince(branch, run.lastVerify.entryId) : 0;
				verifier = !verdict
					? "not run yet"
					: verdict.kind === "invalid"
						? "INVALID"
						: `${verdict.criteria.filter(c => c.ok).length}/${verdict.criteria.length}${stale ? ` (stale: ${stale} action steps)` : " (fresh)"}`;
			}
			const header = `[OMP Horizon | Run ${run.start.runId} | Contract: ${run.start.contract.skill ?? "default"} | LLM calls: ${calls}${settings.maxLlmCalls ? `/${settings.maxLlmCalls}` : ""} | Elapsed: ${minutes}m${settings.maxMinutes ? `/${settings.maxMinutes}m` : ""} | Context: ${usage ? `${Math.round(usage.percent)}%` : "?"} | Verifier: ${verifier} | Best Checkpoint: ${run.best?.ref ?? "none"}]`;
			const notices: string[] = [];
			if (extraction.stalled) notices.push(`WARNING: ledger extraction has been failing since ${new Date(extraction.stalled.since).toISOString()} (${extraction.stalled.reason}); recent discoveries may be missing — record critical facts with the \`ledger\` tool.`);
			if (trip) notices.push(`CIRCUIT BREAKER ACTIVE for \`${trip.signature}\`: action tools are locked until you record the falsified assumption.`);
			text = renderLedger(run.ledger, { budgetTokens: run.start.contract.ledger_budget_tokens, header, best: run.best, notices });
		} else if (isSub && mainLedgerView) {
			text = mainLedgerView.render();
		}
		if (!text) return;
		const injection = { role: "user", content: [{ type: "text", text: `<horizon-ledger>\n${text}\n</horizon-ledger>` }], attribution: "agent", timestamp: Date.now() };
		return { messages: [...event.messages, injection] };
	});

	// ── Tools ──────────────────────────────────────────────────────────────────

	const z = pi.zod;
	pi.registerTool<{ read?: "all" | LedgerSection | "history"; ops?: unknown[] }>({
		name: "ledger",
		label: "Horizon Ledger",
		description:
			"Working Memory Ledger of the active Horizon Run. Record verified Ground Truth (exact literals), Graveyard entries (falsified approaches with their exact failure), and the Frontier (next step). Entries are append-only: correct one with op supersede (id + reason). `read` lists entries, including ones the injected view omits.",
		loadMode: "essential",
		defaultInactive: true,
		approval: "read",
		parameters: z.object({
			read: z.enum(["all", "ground_truth", "graveyard", "history"]).optional().describe("List entries instead of (or before) writing"),
			ops: z
				.array(
					z.object({
						op: z.enum(["add", "supersede", "set_frontier"]),
						section: z.enum(["ground_truth", "graveyard"]).optional().describe("Required for add"),
						text: z.string().describe("Entry text with exact literals, or the Frontier"),
						id: z.string().optional().describe("Entry id to supersede (gtN / gyN)"),
						reason: z.string().optional().describe("Why the superseded entry is wrong or outdated"),
						source: z.string().optional().describe("Journal entry id that shows the fact"),
					}),
				)
				.optional(),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
			if (!runActive()) return fail("No Horizon Run is active. The user starts one with /horizon start [skill] or --horizon.");
			const out: string[] = [];
			if (params.ops?.length) {
				if (!run) return fail("The ledger is read-only in subagents. Report discoveries and dead ends in your final answer; the main session records them.");
				const result = applyProposedOps(run.ledger, params.ops, { origin: "agent", now: Date.now() });
				commitLedgerOps(ctx, result.applied);
				for (const op of result.applied) {
					out.push(op.op === "set_frontier" ? "frontier set" : op.op === "add" ? `added ${op.entry.id}` : `${op.id} superseded by ${op.entry.id}`);
				}
				for (const r of result.rejected) out.push(`rejected: ${r.reason}`);
				if (result.applied.length === 0) return fail(out.join("\n"));
			}
			if (params.read || !params.ops?.length) {
				const which = params.read ?? "all";
				out.push(run ? listEntries(run.ledger, which) : (mainLedgerView?.list(which) ?? ""));
			}
			return { content: [{ type: "text", text: out.join("\n") }] };
		},
	});

	pi.registerTool<Record<string, never>>({
		name: "verify",
		label: "Horizon Verify",
		description:
			"Run the active Horizon Run's pinned Verifier and record the verdict per Criterion. Call it alone, after your action steps have finished (not in parallel with them). Completion is accepted only after a fresh passing verify (no action steps since). Never edit files in the pinned verifier directory.",
		loadMode: "essential",
		defaultInactive: true,
		approval: "read",
		parameters: z.object({}),
		async execute(_id, _params, signal, _onUpdate, ctx) {
			const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
			if (!run) return fail(isSub ? "verify runs in the main session only." : "No Horizon Run is active.");
			if (!run.pin) return fail("This Horizon Run has no Verifier; its outcome will be `unverified`.");
			const view = run;
			const pin = run.pin;
			const result = await runVerifier(pin, ctx.cwd, signal);
			pi.appendEntry(ENTRY.verify, { runId: view.start.runId, result });
			const branch = ctx.sessionManager.getBranch();
			const verifyEntry = [...branch].reverse().find(e => e.type === "custom" && e.customType === ENTRY.verify);
			view.lastVerify = { entryId: verifyEntry?.id ?? "", result };
			lastVerifyNudge = 0;
			const lines = [formatVerdict(result)];
			if (result.kind === "verdict") {
				const progress = assessProgress(result.criteria, view.best);
				if (progress.regressions.length) {
					lines.push(
						`REGRESSION: ${progress.regressions.join(", ")} passed at Best Checkpoint ${view.best?.ref} but fail now. Fix forward, or restore that checkpoint (git: \`git checkout <commit> -- .\`).`,
					);
				}
				if (progress.newBest) {
					const n = view.checkpoints + 1;
					const label = `[omp-horizon] ${view.start.runId} #${n} ${progress.passing.length}/${result.criteria.length}`;
					let ref = "(checkpoint_strategy none)";
					try {
						if (view.start.contract.checkpoint_strategy === "git") ref = await gitSnapshot(ctx.cwd, view.start.runId, n, label);
						else if (view.start.contract.checkpoint_strategy === "script" && view.start.contract.checkpoint_cmd) {
							ref = await scriptCheckpoint(view.start.contract.checkpoint_cmd, ctx.cwd, label);
						}
					} catch (err) {
						ref = `(checkpoint failed: ${err instanceof Error ? err.message : String(err)})`;
						ctx.ui.notify(`horizon: ${ref}`, "warning");
					}
					const checkpoint: BestCheckpoint = { ref, passing: progress.passing, score: progress.passing.length, max: result.criteria.length, at: Date.now() };
					pi.appendEntry(ENTRY.checkpoint, { runId: view.start.runId, checkpoint });
					view.best = checkpoint;
					view.checkpoints = n;
					lines.push(`New Best Checkpoint: ${ref}`);
				}
			}
			mirror(ctx);
			status(ctx);
			return { content: [{ type: "text", text: lines.join("\n") }], isError: result.kind === "invalid" };
		},
	});

	// ── Tool interception ──────────────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const pin = run?.pin;
		if (!pin || typeof event.toolName !== "string" || !isRecord(event.input)) return;
		const strings = JSON.stringify(event.input);
		const rel = relative(ctx.cwd, pin.dir);
		const mentions = strings.includes(pin.dir) || (rel !== "" && !rel.startsWith("..") && strings.includes(`${rel}/`)) || (rel !== "" && strings.includes(`"${rel}"`));
		if (!mentions) return;
		const command = typeof event.input.command === "string" ? event.input.command : "";
		const isEval = event.toolName === "eval" || event.toolName === "python";
		if (WRITE_TOOLS.has(event.toolName) || isEval || (EXEC_TOOLS.has(event.toolName) && SHELL_WRITE.test(command))) {
			return { block: true, reason: `The Verifier directory ${pin.dir} is pinned for this Horizon Run and must not be modified. Change the system under test instead; only the user can re-pin (/horizon repin).` };
		}
	});

	pi.on("tool_result", async event => {
		if (!runActive() || typeof event.toolName !== "string" || !EXEC_TOOLS.has(event.toolName)) return;
		const text = textOf(event.content);
		const callInput = { toolName: event.toolName, input: isRecord(event.input) ? event.input : {}, resultText: text, details: event.details };
		const signature = failureSignature(callInput);
		const scriptSig = inlineScriptSignature(callInput);
		const failed = event.isError === true;
		if (failed) {
			const list = recentErrors.get(signature) ?? [];
			list.push(text.replace(/\s+/g, " ").trim().slice(-300));
			recentErrors.set(signature, list.slice(-3));
		}
		const failures = window.breaker.record(signature, failed, scriptSig);
		if (failures !== undefined && !trip) await tripBreaker(signature, failures);
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = isRecord(event.message) ? event.message : {};
		const hadToolCalls = Array.isArray(message.content) && message.content.some(b => isRecord(b) && b.type === "toolCall");
		if (trip) {
			trip.calls++;
			const at = trip.at;
			// Only the agent's own Graveyard write counts as reflection; background Extraction does not.
			// Subagents cannot write the ledger, so one reflection response unlocks them.
			const recorded = run ? run.ledger.entries.some(e => e.section === "graveyard" && e.origin === "agent" && e.at >= at) : trip.calls >= 1;
			if (recorded || trip.calls >= 2) {
				await unlockBreaker();
				if (!hadToolCalls && !isSub) continueAfterReflection = true;
			} else if (trip.calls >= 1) {
				pi.sendMessage(
					{ customType: "omp-long-horizon.trip", content: "Record the falsified assumption with the `ledger` tool (section graveyard) before action tools unlock.", display: true, attribution: "agent" },
					{ deliverAs: "steer" },
				);
			}
		}
		if (!run || isSub) return;
		extraction.callsSince++;
		if (extraction.callsSince >= cfg(ctx).extractionIntervalCalls) kickExtraction(ctx);
		const interval = run.start.contract.verify_interval_steps;
		if (run.pin && hadToolCalls) {
			const steps = actionStepsSince(ctx.sessionManager.getBranch(), run.lastVerify?.entryId);
			if (steps >= interval && steps >= lastVerifyNudge + interval) {
				lastVerifyNudge = steps;
				pi.sendMessage(
					{ customType: "omp-long-horizon.verify-due", content: `Verify is due: ${steps} action steps since the last verification. Call \`verify\` when the current step settles.`, display: true, attribution: "agent" },
					{ deliverAs: "steer" },
				);
			}
		}
	});

	pi.on("session_before_compact", async (_e, ctx) => {
		if (run && !isSub) kickExtraction(ctx);
	});

	// ── Stop gate ──────────────────────────────────────────────────────────────

	pi.on("session_stop", async (_e, ctx) => {
		if (!run || isSub) return;
		if (trip) return { decision: "block", reason: "Circuit breaker active: record the falsified assumption with the `ledger` tool (section graveyard); action tools unlock after that." };
		if (continueAfterReflection) {
			continueAfterReflection = false;
			return { decision: "block", reason: "Reflection recorded; action tools are unlocked. Continue with the fundamentally different approach — do not retry the Graveyard entry." };
		}
		kickExtraction(ctx);
		if (!run.pin) {
			recordOutcome(ctx, "unverified", "no Verifier bound");
			return;
		}
		const verdict = run.lastVerify?.result;
		const stale = run.lastVerify ? actionStepsSince(ctx.sessionManager.getBranch(), run.lastVerify.entryId) : Number.POSITIVE_INFINITY;
		let key: string;
		let reason: string;
		if (!verdict || stale > 0) {
			key = "__unverified__";
			reason = `[HARNESS VERIFIER GATE] Completion requires a fresh verification: ${verdict ? `${stale} action steps since the last verify` : "verify has not run"}. Call \`verify\`.`;
		} else if (verdict.kind === "invalid") {
			key = `__invalid__:${verdict.reason.slice(0, 80)}`;
			reason = `[HARNESS VERIFIER GATE] The last verification was an Invalid Result (${verdict.reason}). That is not a pass. Resolve the cause without touching the pinned verifier directory, then verify again.`;
		} else {
			const failing = verdict.criteria.filter(c => !c.ok);
			if (failing.length === 0) {
				gate = { key: "", count: 0, bestRef: "" };
				recordOutcome(ctx, "passed", `${verdict.criteria.length}/${verdict.criteria.length} criteria`);
				return;
			}
			key = failing.map(c => c.id).sort().join(",");
			reason = `[HARNESS VERIFIER REJECTED COMPLETION: Score ${verdict.criteria.length - failing.length}/${verdict.criteria.length}] Unmet criteria: ${failing.map(c => `${c.id}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}. Continue execution.`;
		}
		const bestRef = run.best?.ref ?? "";
		gate = gate.key === key && gate.bestRef === bestRef ? { ...gate, count: gate.count + 1 } : { key, count: 1, bestRef };
		if (gate.count >= cfg(ctx).stallRejections) {
			const blocker = key.startsWith("__") ? reason : `unmet criteria ${key}`;
			const result = applyProposedOps(run.ledger, [{ op: "set_frontier", text: `BLOCKED after ${gate.count} identical completion rejections: ${blocker}` }], { origin: "harness", now: Date.now() });
			commitLedgerOps(ctx, result.applied);
			recordOutcome(ctx, "blocked", key.startsWith("__") ? key.replace(/^__|__$/g, "") : key);
			gate = { key: "", count: 0, bestRef: "" };
			return;
		}
		return { decision: "block", reason };
	});

	// ── Commands ───────────────────────────────────────────────────────────────

	pi.registerCommand("horizon", {
		description: "Horizon Runs: start [skill|default] [--verifier path] | stop | status | ledger | repin [path] | extract | reflect <session.jsonl> [--skill name] [--project dir] [--out dir]",
		handler: async (args, ctx) => {
			const words = args.trim().split(/\s+/).filter(Boolean);
			const sub = words[0] ?? "status";
			const option = (name: string) => {
				const at = words.indexOf(`--${name}`);
				return at >= 0 ? words[at + 1] : undefined;
			};
			const positional = words.slice(1).filter((w, i, all) => !w.startsWith("--") && !all[i - 1]?.startsWith("--"));
			try {
				switch (sub) {
					case "start":
						await startRun(ctx, positional[0] ?? null, option("verifier"));
						return;
					case "stop":
						await stopRun(ctx);
						return;
					case "ledger":
						if (!run) throw new Error("No Horizon Run is active");
						mirror(ctx);
						ctx.ui.notify(`${listEntries(run.ledger, "all")}\n\nFrontier: ${run.ledger.frontier?.text ?? "not set"}\nMirror: ${cfg(ctx).mirrorPath || "disabled"}`, "info");
						return;
					case "repin": {
						if (!run?.pin && !positional[0]) throw new Error("No verifier to re-pin; pass a path");
						if (!run) throw new Error("No Horizon Run is active");
						const path = positional[0] ? resolve(ctx.cwd, positional[0]) : (run.pin?.path ?? "");
						const pin = createPin(path, run.start.contract);
						pi.appendEntry(ENTRY.pin, { runId: run.start.runId, pin });
						run.pin = pin;
						ctx.ui.notify(`Verifier re-pinned: ${pin.dir} ${pin.hash.slice(0, 12)}`, "info");
						return;
					}
					case "extract":
						if (!run) throw new Error("No Horizon Run is active");
						await runExtraction(ctx);
						ctx.ui.notify(extraction.stalled ? `Extraction failed: ${extraction.stalled.reason}` : "Extraction caught up", extraction.stalled ? "error" : "info");
						return;
					case "reflect": {
						if (!positional[0]) throw new Error("usage: /horizon reflect <session.jsonl> [--skill name] [--project dir] [--out dir]");
						ctx.ui.notify("trace-reflect: analysing churn windows…", "info");
						const report = await runReflect({
							sessionFile: resolve(ctx.cwd, positional[0]),
							skill: option("skill"),
							projectDir: resolve(ctx.cwd, option("project") ?? "."),
							outDir: resolve(ctx.cwd, option("out") ?? "reflect-out"),
							config: cfg(ctx),
						});
						ctx.ui.notify(report, "info");
						return;
					}
					default: {
						if (!run) {
							ctx.ui.notify("No Horizon Run active. /horizon start [skill|default] [--verifier path]", "info");
							return;
						}
						const branch = ctx.sessionManager.getBranch();
						ctx.ui.notify(
							[
								`Run ${run.start.runId} | contract ${run.start.contract.skill ?? "default"} | LLM calls ${llmCallsSince(branch, run.startEntryId)}`,
								`Verifier: ${run.pin ? `${run.pin.path} (pin ${run.pin.hash.slice(0, 12)})` : "none"}`,
								`Last verify: ${run.lastVerify ? formatVerdict(run.lastVerify.result).split("\n")[0] : "never"}`,
								`Best Checkpoint: ${run.best ? `${run.best.ref} ${run.best.score}/${run.best.max}` : "none"}`,
								`Ledger: ${current(run.ledger, "ground_truth").length} ground truth, ${current(run.ledger, "graveyard").length} graveyard; extraction ${extraction.stalled ? `STALLED: ${extraction.stalled.reason}` : "ok"}`,
								`Breaker: ${trip ? `tripped on ${trip.signature}` : "armed"}`,
							].join("\n"),
							"info",
						);
					}
				}
			} catch (err) {
				ctx.ui.notify(`horizon: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}

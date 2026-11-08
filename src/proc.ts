import { spawn } from "node:child_process";

export interface ProcResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	durationMs: number;
	/** Set when the process could not be spawned at all (missing binary, permissions). */
	spawnError?: string;
}

export interface ProcOptions {
	cwd?: string;
	input?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

const MAX_CAPTURE = 4 * 1024 * 1024;

/** Runs a process without a shell; output capped at 4 MiB per stream. Never throws. */
export function runProcess(command: string, args: readonly string[], options: ProcOptions = {}): Promise<ProcResult> {
	const started = Date.now();
	const { promise, resolve } = Promise.withResolvers<ProcResult>();
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	let settled = false;
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env ?? process.env,
		stdio: ["pipe", "pipe", "pipe"],
		signal: options.signal,
	});
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, options.timeoutMs ?? 120_000);
	const finish = (result: Pick<ProcResult, "code" | "spawnError">) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve({ ...result, stdout, stderr, timedOut, durationMs: Date.now() - started });
	};
	child.stdout.on("data", (chunk: Buffer) => {
		if (stdout.length < MAX_CAPTURE) stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		if (stderr.length < MAX_CAPTURE) stderr += chunk.toString("utf8");
	});
	child.on("error", err => finish({ code: null, spawnError: err.message }));
	child.on("close", code => finish({ code }));
	child.stdin.on("error", () => {
		// The child may exit before reading stdin; its exit status reports the failure.
	});
	child.stdin.end(options.input ?? "");
	return promise;
}

export interface OneShotOptions {
	ompBinary: string;
	/** Role (`smol`, `@smol`) or exact `provider/model`. */
	model?: string;
	systemPrompt: string;
	prompt: string;
	timeoutMs: number;
	cwd?: string;
}

/**
 * One non-interactive completion through the `omp` CLI. Extensions cannot import OMP's model
 * client (it is bundled into the binary), and the CLI is the supported path that resolves
 * roles and provider auth. Every ambient capability is disabled so the call is a pure completion.
 */
export async function ompOneShot(options: OneShotOptions): Promise<string> {
	const args = ["-p", "--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--thinking", "off"];
	if (options.model) args.push("--model", options.model.startsWith("@") || options.model.includes("/") ? options.model : `@${options.model}`);
	args.push("--system-prompt", options.systemPrompt);
	const result = await runProcess(options.ompBinary, args, { input: options.prompt, timeoutMs: options.timeoutMs, cwd: options.cwd });
	if (result.spawnError) throw new Error(`cannot run ${options.ompBinary}: ${result.spawnError}`);
	if (result.timedOut) throw new Error(`model call timed out after ${Math.round(options.timeoutMs / 1000)}s`);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim().split("\n").slice(-3).join(" | ");
		throw new Error(`model call failed (exit ${result.code}): ${detail.slice(0, 400)}`);
	}
	return result.stdout.trim();
}

/** Extracts the first JSON value from model output (tolerates fences and prose around it). */
export function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = (fenced ? fenced[1] : text).trim();
	const start = body.search(/[[{]/);
	if (start < 0) throw new Error("no JSON in model output");
	const open = body[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	for (let i = start; i < body.length; i++) {
		const ch = body[i];
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === open) depth++;
		else if (ch === close && --depth === 0) return JSON.parse(body.slice(start, i + 1));
	}
	throw new Error("unterminated JSON in model output");
}

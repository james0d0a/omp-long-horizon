import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isRecord } from "./omp.ts";
import { runProcess } from "./proc.ts";
import type { BestCheckpoint, Criterion, HorizonContract, VerifierPin, VerifierResult } from "./types.ts";

const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv"]);

/** Content hash of a directory tree: relative paths, executable bits, and file contents. */
export function hashDir(dir: string): string {
	const hash = createHash("sha256");
	const walk = (current: string) => {
		for (const name of readdirSync(current).sort()) {
			const full = join(current, name);
			const stat = lstatSync(full);
			const rel = relative(dir, full);
			if (stat.isDirectory()) {
				if (!SKIP_DIRS.has(name)) walk(full);
			} else if (stat.isSymbolicLink()) {
				hash.update(`L ${rel}\0`);
			} else if (stat.isFile()) {
				hash.update(`F ${rel} ${stat.mode & 0o111 ? "x" : "-"}\0`);
				hash.update(readFileSync(full));
				hash.update("\0");
			}
		}
	};
	walk(dir);
	return hash.digest("hex");
}

/**
 * Resolves the verifier for a run: an explicit override (relative to cwd), else the contract's
 * `verifier` (relative to the project, or `skill:<path>` relative to the skill directory).
 */
export function resolveVerifierPath(contract: HorizonContract, skillDir: string | null, cwd: string, override?: string): string | undefined {
	const spec = override ?? contract.verifier;
	if (!spec || spec === "none") return undefined;
	if (spec.startsWith("skill:")) {
		if (!skillDir) throw new Error(`verifier ${spec} needs a skill directory, but no skill is bound`);
		return resolve(skillDir, spec.slice("skill:".length));
	}
	return isAbsolute(spec) ? spec : resolve(cwd, spec);
}

/** Pins the verifier's whole directory so the run cannot pass by editing the test or its inputs. */
export function createPin(path: string, contract: HorizonContract): VerifierPin {
	if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`verifier not found: ${path}`);
	try {
		accessSync(path, constants.X_OK);
	} catch {
		throw new Error(`verifier is not executable: ${path} (chmod +x it)`);
	}
	const dir = dirname(path);
	return { path, dir, hash: hashDir(dir), output: contract.verifier_output, timeoutSec: contract.verifier_timeout_sec };
}

/** Parses a verdict. JSON mode: the last stdout line that is an object with a `criteria` array. */
export function parseVerifierOutput(stdout: string, code: number | null, output: VerifierPin["output"]): Criterion[] | string {
	if (output === "exit_code") {
		if (code === null) return "verifier did not exit normally";
		const last = stdout.trim().split("\n").at(-1) ?? "";
		return [{ id: "exit_zero", ok: code === 0, detail: last.slice(0, 300) || `exit ${code}` }];
	}
	const lines = stdout.trim().split("\n").reverse();
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.criteria)) continue;
		const criteria: Criterion[] = [];
		const ids = new Set<string>();
		for (const raw of parsed.criteria) {
			if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id.trim() || typeof raw.ok !== "boolean") {
				return "criteria entries need a non-empty string `id` and boolean `ok`";
			}
			if (ids.has(raw.id)) return `duplicate criterion id ${raw.id}`;
			ids.add(raw.id);
			criteria.push({ id: raw.id, ok: raw.ok, detail: typeof raw.detail === "string" ? raw.detail.slice(0, 500) : undefined });
		}
		if (criteria.length === 0) return "criteria array is empty";
		return criteria;
	}
	return 'no stdout line with {"criteria": [...]} JSON';
}

/** Runs the pinned verifier. A changed directory, crash, timeout, or unparseable output is an Invalid Result. */
export async function runVerifier(pin: VerifierPin, cwd: string, signal?: AbortSignal): Promise<VerifierResult> {
	const started = Date.now();
	const invalid = (reason: string, output?: string): VerifierResult => ({ kind: "invalid", reason, at: Date.now(), durationMs: Date.now() - started, output });
	let hash: string;
	try {
		hash = hashDir(pin.dir);
	} catch (err) {
		return invalid(`cannot hash pinned verifier directory: ${String(err)}`);
	}
	if (hash !== pin.hash) return invalid(`Verifier Pin broken: ${pin.dir} changed since it was pinned. Restore it, or ask the user to run /horizon repin.`);
	const result = await runProcess(pin.path, [], { cwd, timeoutMs: pin.timeoutSec * 1000, signal });
	const tail = `${result.stdout}\n${result.stderr}`.trim().slice(-2000);
	if (result.spawnError) return invalid(`verifier could not start: ${result.spawnError}`);
	if (result.timedOut) return invalid(`verifier timed out after ${pin.timeoutSec}s`, tail);
	const parsed = parseVerifierOutput(result.stdout, result.code, pin.output);
	if (typeof parsed === "string") return invalid(`${parsed} (exit ${result.code})`, tail);
	return { kind: "verdict", criteria: parsed, at: Date.now(), durationMs: result.durationMs, pinHash: pin.hash };
}

export interface Progress {
	passing: string[];
	failing: Criterion[];
	/** Criteria passing at the Best Checkpoint that no longer pass. */
	regressions: string[];
	/** Strict superset of the best passing set: this result becomes the new Best Checkpoint. */
	newBest: boolean;
}

export function assessProgress(criteria: Criterion[], best: BestCheckpoint | null): Progress {
	const passing = criteria.filter(c => c.ok).map(c => c.id);
	const passingSet = new Set(passing);
	const bestPassing = best?.passing ?? [];
	const regressions = bestPassing.filter(id => !passingSet.has(id));
	return {
		passing,
		failing: criteria.filter(c => !c.ok),
		regressions,
		newBest: regressions.length === 0 && passing.length > bestPassing.length,
	};
}

export function formatVerdict(result: VerifierResult): string {
	if (result.kind === "invalid") return `INVALID RESULT: ${result.reason}${result.output ? `\n--- verifier output (tail) ---\n${result.output}` : ""}`;
	const ok = result.criteria.filter(c => c.ok).length;
	const rows = result.criteria.map(c => `- [${c.ok ? "x" : " "}] ${c.id}${c.detail ? `: ${c.detail}` : ""}`);
	return `Score ${ok}/${result.criteria.length}${ok === result.criteria.length ? " — PASSED" : ""}\n${rows.join("\n")}`;
}

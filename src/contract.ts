import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { YamlParser } from "./config.ts";
import { isRecord } from "./omp.ts";
import { runProcess } from "./proc.ts";
import type { CheckpointStrategy, HorizonContract } from "./types.ts";

export const CONTRACT_FILE = "horizon.yml";

/** Generic default contract: used when no skill is bound or the skill has no horizon.yml. */
export const DEFAULT_CONTRACT: HorizonContract = {
	skill: null,
	ground_truth_keys: [
		"Hosts, IPs, ports, hostnames, and service versions confirmed reachable or running",
		"Working credentials, keys, and tokens, with the exact command or flags that succeeded",
		"Confirmed file paths, offsets, addresses, identifiers, and configuration values",
		"Environment constraints verified by observation (OS, versions, policies in force)",
	],
	graveyard_keys: [
		"Commands, flags, and approaches that failed, with the exact error text or code",
		"Hypotheses falsified by evidence, with the evidence",
		"Paths blocked by environment controls (firewall, policy, EDR), with the observed block",
	],
	checkpoint_strategy: "none",
	verifier_output: "json",
	verifier_timeout_sec: 600,
	verify_interval_steps: 10,
	ledger_budget_tokens: 6000,
};

const STRATEGIES: readonly CheckpointStrategy[] = ["git", "script", "none"];

const stringList = (value: unknown, fallback: string[]) => {
	if (!Array.isArray(value)) return fallback;
	const items = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim());
	return items.length > 0 ? items : fallback;
};

const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback);

/** Validates a parsed horizon.yml. Unknown keys are ignored; bad values fall back to defaults. */
export function normalizeContract(raw: unknown, skill: string | null): { contract: HorizonContract; warnings: string[] } {
	const warnings: string[] = [];
	if (!isRecord(raw)) return { contract: { ...DEFAULT_CONTRACT, skill }, warnings: raw === undefined ? [] : ["horizon.yml is not a mapping; using defaults"] };
	const strategy = STRATEGIES.find(s => s === raw.checkpoint_strategy);
	if (raw.checkpoint_strategy !== undefined && !strategy) warnings.push(`checkpoint_strategy must be one of ${STRATEGIES.join(", ")}`);
	const checkpointCmd = typeof raw.checkpoint_cmd === "string" && raw.checkpoint_cmd.trim() ? raw.checkpoint_cmd.trim() : undefined;
	if (strategy === "script" && !checkpointCmd) warnings.push("checkpoint_strategy: script requires checkpoint_cmd; checkpoints disabled");
	const output = raw.verifier_output === "exit_code" ? "exit_code" : "json";
	return {
		contract: {
			skill,
			ground_truth_keys: stringList(raw.ground_truth_keys, DEFAULT_CONTRACT.ground_truth_keys),
			graveyard_keys: stringList(raw.graveyard_keys, DEFAULT_CONTRACT.graveyard_keys),
			checkpoint_strategy: strategy === "script" && !checkpointCmd ? "none" : (strategy ?? DEFAULT_CONTRACT.checkpoint_strategy),
			checkpoint_cmd: checkpointCmd,
			verifier: typeof raw.verifier === "string" && raw.verifier.trim() ? raw.verifier.trim() : undefined,
			verifier_output: output,
			verifier_timeout_sec: positive(raw.verifier_timeout_sec, DEFAULT_CONTRACT.verifier_timeout_sec),
			verify_interval_steps: positive(raw.verify_interval_steps, DEFAULT_CONTRACT.verify_interval_steps),
			ledger_budget_tokens: positive(raw.ledger_budget_tokens, DEFAULT_CONTRACT.ledger_budget_tokens),
		},
		warnings,
	};
}

/** Resolves a skill name to its installed directory through `omp skill list --json` (OMP's own discovery). */
export async function resolveSkillDir(name: string, ompBinary: string, cwd: string): Promise<string> {
	const result = await runProcess(ompBinary, ["skill", "list", "--json"], { cwd, timeoutMs: 30_000 });
	if (result.code !== 0) throw new Error(`omp skill list failed: ${(result.spawnError ?? result.stderr).trim().slice(0, 300)}`);
	const parsed: unknown = JSON.parse(result.stdout);
	const skills = isRecord(parsed) && Array.isArray(parsed.skills) ? parsed.skills : [];
	const candidates = skills.filter(isRecord).filter(s => typeof s.baseDir === "string" && typeof s.name === "string");
	const exact = candidates.find(s => s.name === name) ?? candidates.find(s => String(s.name).split("/").at(-1) === name);
	if (!exact) throw new Error(`skill "${name}" not found by omp skill list`);
	return String(exact.baseDir);
}

export function loadContract(skill: string | null, skillDir: string | null, parseYaml: YamlParser): { contract: HorizonContract; warnings: string[] } {
	if (!skillDir) return { contract: { ...DEFAULT_CONTRACT, skill }, warnings: [] };
	const file = join(skillDir, CONTRACT_FILE);
	if (!existsSync(file)) return { contract: { ...DEFAULT_CONTRACT, skill }, warnings: [`${skill} has no ${CONTRACT_FILE}; using the generic default contract`] };
	return normalizeContract(parseYaml(readFileSync(file, "utf8")), skill);
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { gitSnapshot } from "../src/checkpoint.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { appendUnderHeading, appendYamlList, runReflect } from "../src/reflect.ts";
import { verifierWindows, buildTrace } from "../src/trace.ts";
import { ENTRY } from "../src/types.ts";
import { parseVerifierOutput } from "../src/verifier.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(): string {
	const dir = mkdtempSync(join(tmpdir(), "horizon-git-"));
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "t@t");
	git(dir, "config", "user.name", "t");
	writeFileSync(join(dir, "tracked.txt"), "v1\n");
	writeFileSync(join(dir, ".gitignore"), "secret.env\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "seed");
	return dir;
}

describe("Best Checkpoint git snapshot", () => {
	test("captures tracked, modified, and untracked files without touching HEAD, index, or branch", async () => {
		const dir = repo();
		writeFileSync(join(dir, "tracked.txt"), "v2\n");
		writeFileSync(join(dir, "new-playbook.yml"), "- hosts: all\n");
		writeFileSync(join(dir, "secret.env"), "TOKEN=x\n");
		git(dir, "add", "tracked.txt");
		const before = { head: git(dir, "rev-parse", "HEAD"), branch: git(dir, "branch", "--show-current"), status: git(dir, "status", "--porcelain") };
		const ref = await gitSnapshot(dir, "run1", 1, "[omp-horizon] test");
		assert.match(ref, /^refs\/omp-horizon\/run1\/1 \(/);
		assert.deepEqual({ head: git(dir, "rev-parse", "HEAD"), branch: git(dir, "branch", "--show-current"), status: git(dir, "status", "--porcelain") }, before);
		const files = git(dir, "ls-tree", "-r", "--name-only", "refs/omp-horizon/run1/1").split("\n");
		assert.deepEqual(files.sort(), [".gitignore", "new-playbook.yml", "tracked.txt"]);
		assert.equal(git(dir, "show", "refs/omp-horizon/run1/1:tracked.txt"), "v2");
	});
});

describe("verifier output contract", () => {
	test("the last criteria JSON line wins over noise; malformed verdicts are Invalid", () => {
		const out = 'progress {"x":1}\n{"criteria":[{"id":"a","ok":true}]}\n{"criteria":[{"id":"a","ok":false,"detail":"down"},{"id":"b","ok":true}]}\n';
		assert.deepEqual(parseVerifierOutput(out, 1, "json"), [
			{ id: "a", ok: false, detail: "down" },
			{ id: "b", ok: true, detail: undefined },
		]);
		assert.equal(typeof parseVerifierOutput("all good\n", 0, "json"), "string", "exit 0 without JSON is not a pass");
		assert.equal(typeof parseVerifierOutput('{"criteria":[{"id":"a","ok":"yes"}]}', 0, "json"), "string");
		assert.equal(typeof parseVerifierOutput('{"criteria":[{"id":"a","ok":true},{"id":"a","ok":true}]}', 0, "json"), "string");
		assert.deepEqual(parseVerifierOutput("boom\n", 2, "exit_code"), [{ id: "exit_zero", ok: false, detail: "boom" }]);
	});
});

describe("Churn Windows from verifier history", () => {
	test("a Regression window opens when a best-passing criterion is lost and closes when it passes again", () => {
		const verify = (id: string, criteria: [string, boolean][]) => ({
			type: "custom",
			id,
			customType: ENTRY.verify,
			data: { runId: "r", result: { kind: "verdict", criteria: criteria.map(([cid, ok]) => ({ id: cid, ok })), at: 0, durationMs: 0, pinHash: "h" } },
		});
		const trace = buildTrace([
			verify("v1", [["dc", true], ["siem", false]]),
			verify("v2", [["dc", false], ["siem", true]]),
			verify("v3", [["dc", true], ["siem", true]]),
		]);
		assert.deepEqual(
			verifierWindows(trace).map(w => [w.kind, w.detail, w.recovered]),
			[["regression", "Regression of dc", true]],
		);
	});
});

describe("trace-reflect", () => {
	test("YAML list and Markdown section appends keep existing content", () => {
		const yml = "ground_truth_keys:\n  - \"a\"\n\ngraveyard_keys:\n  - \"b\"\ncheckpoint_strategy: git\n";
		assert.equal(appendYamlList(yml, "ground_truth_keys", ["c"]), 'ground_truth_keys:\n  - "a"\n  - "c"\n\ngraveyard_keys:\n  - "b"\ncheckpoint_strategy: git\n');
		const md = "# T\n\n## Telemetry\n\n- x\n\n## Escalation\n\n- y\n";
		assert.equal(appendUnderHeading(md, "## Telemetry", ["- new"]), "# T\n\n## Telemetry\n\n- x\n- new\n\n## Escalation\n\n- y\n");
	});

	test("emits redacted, git-apply-able patches split by scope and never applies them", async () => {
		const root = mkdtempSync(join(tmpdir(), "horizon-reflect-"));
		const skillDir = join(root, "skill");
		const projectDir = join(root, "project");
		mkdirSync(skillDir);
		mkdirSync(projectDir);
		const skillMd = "---\nname: demo\ndescription: d\n---\n# Demo\n\nBody.\n";
		writeFileSync(join(skillDir, "SKILL.md"), skillMd);
		const lines: object[] = [];
		let parent: string | null = null;
		const push = (entry: Record<string, unknown>) => {
			const id = `e${lines.length + 1}`;
			lines.push({ ...entry, id, parentId: parent });
			parent = id;
		};
		const call = (n: number, command: string, ok: boolean, out: string) => {
			push({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `c${n}`, name: "bash", arguments: { command } }] } });
			push({ type: "message", message: { role: "toolResult", toolCallId: `c${n}`, toolName: "bash", isError: !ok, content: [{ type: "text", text: out }] } });
		};
		call(1, "kinit -k admin", false, "KDC_ERR_PREAUTH_FAILED");
		call(2, "kinit -kt admin.keytab admin", false, "KDC_ERR_PREAUTH_FAILED");
		call(3, "kinit -V admin", false, "clock skew too great");
		call(4, "sudo ntpdate dc01 && kinit -kt admin.keytab admin", true, "ok");
		const session = join(root, "session.jsonl");
		writeFileSync(session, `${lines.map(l => JSON.stringify(l)).join("\n")}\n`);

		let prompt = "";
		const summary = await runReflect({
			sessionFile: session,
			skill: "demo",
			skillDir,
			projectDir,
			outDir: join(root, "out"),
			config: DEFAULT_CONFIG,
			complete: async (_system, p) => {
				prompt = p;
				return JSON.stringify({
					lessons: [
						{ scope: "skill", text: "Check clock skew before debugging Kerberos auth flags.", windows: ["w1"] },
						{ scope: "environment", section: "Trust Boundaries", text: "DC01 drifts; lab admin login admin:Winter2026! works after ntpdate.", windows: ["w1"] },
					],
					ground_truth_keys: ["Time source and measured skew for each domain controller"],
					graveyard_keys: [],
				});
			},
		});
		assert.match(summary, /1 windows, 2 lessons, 3 patches/);
		assert.match(prompt, /### w1 — trip: 3 failures of bash:kinit \(/);
		const envPatch = readFileSync(join(root, "out", "security-context.patch"), "utf8");
		assert.doesNotMatch(envPatch, /Winter2026!/);
		assert.match(envPatch, /## Trust Boundaries/);
		assert.equal(readFileSync(join(skillDir, "SKILL.md"), "utf8"), skillMd, "nothing is applied");
		git(skillDir, "init", "-q");
		git(projectDir, "init", "-q");
		git(skillDir, "apply", join(root, "out", "skill.patch"));
		git(skillDir, "apply", join(root, "out", "contract.patch"));
		git(projectDir, "apply", join(root, "out", "security-context.patch"));
		assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf8"), /## Verified Patterns & Pitfalls\n\n- Check clock skew/);
		const contract = readFileSync(join(skillDir, "horizon.yml"), "utf8");
		assert.match(contract, /Hosts, IPs, ports/, "new contracts keep the generic default keys");
		assert.match(contract, /Time source and measured skew/);
	});
});

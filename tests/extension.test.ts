import assert from "node:assert/strict";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "node:test";
import extension from "../src/index.ts";
import { ENTRY } from "../src/types.ts";
import { FakeOmp } from "./fake-omp.ts";

const VERIFIER = `#!/bin/sh
a=false; b=false
[ -f state.txt ] && a=true
[ -f notes.txt ] && b=true
echo "noise before the verdict"
printf '{"criteria":[{"id":"state","ok":%s},{"id":"notes","ok":%s,"detail":"notes.txt missing"}]}\\n' $a $b
`;

/** Fake `omp` CLI for Extraction: proposes one Ground Truth op citing the last [id] it was shown. */
const FAKE_OMP = `#!/bin/sh
input=$(cat)
src=$(printf '%s' "$input" | grep -o '^\\[[a-z0-9]*\\]' | tail -1 | tr -d '[]')
printf '{"ops":[{"op":"add","section":"ground_truth","text":"DC01 = 10.20.0.10","source":"%s"}]}\\n' "$src"
`;

function project(extra: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "horizon-ext-"));
	mkdirSync(join(dir, ".omp", "horizon", "verify"), { recursive: true });
	writeFileSync(join(dir, ".omp", "horizon", "verify", "run"), VERIFIER);
	chmodSync(join(dir, ".omp", "horizon", "verify", "run"), 0o755);
	writeFileSync(join(dir, "fake-omp"), FAKE_OMP);
	chmodSync(join(dir, "fake-omp"), 0o755);
	writeFileSync(join(dir, ".omp", "config.yml"), JSON.stringify({ longHorizon: { ompBinary: join(dir, "fake-omp"), extractionIntervalCalls: 1000, stallRejections: 3, ...extra } }));
	return dir;
}

async function startedHost(withVerifier = true, extra: Record<string, unknown> = {}) {
	const host = new FakeOmp(project(extra));
	extension(host.api());
	await host.emit("session_start");
	await host.command(withVerifier ? "start default --verifier .omp/horizon/verify/run" : "start default");
	assert.equal(host.custom(ENTRY.run).length, 1, host.notices.join("\n"));
	return host;
}

describe("stop gate", () => {
	let host: FakeOmp;
	beforeEach(async () => {
		host = await startedHost();
	});

	test("blocks completion until a fresh verify passes, then records outcome passed", async () => {
		const noVerify = await host.emit("session_stop");
		assert.match(JSON.stringify(noVerify), /"decision":"block".*verify has not run/);

		writeFileSync(join(host.cwd, "state.txt"), "ok\n");
		writeFileSync(join(host.cwd, "notes.txt"), "ok\n");
		await host.callTool("verify", {});
		await host.exec("touch other", false);
		assert.match(JSON.stringify(await host.emit("session_stop")), /1 action steps since the last verify/);

		await host.callTool("verify", {});
		assert.equal(await host.emit("session_stop"), undefined);
		assert.deepEqual(host.custom(ENTRY.outcome).map(o => o.outcome), ["passed"]);
	});

	test("rejects with unmet criteria, then ends blocked after N identical rejections", async () => {
		writeFileSync(join(host.cwd, "state.txt"), "ok\n");
		await host.callTool("verify", {});
		const first = await host.emit("session_stop");
		assert.match(JSON.stringify(first), /REJECTED COMPLETION: Score 1\/2.*notes \(notes.txt missing\)/);
		await host.emit("session_stop");
		assert.equal(await host.emit("session_stop"), undefined, "third identical rejection lets the run stop");
		assert.deepEqual(host.custom(ENTRY.outcome).map(o => [o.outcome, o.detail]), [["blocked", "notes"]]);
	});

	test("Best Checkpoint only on a strict superset; a Regression is reported against it", async () => {
		writeFileSync(join(host.cwd, "state.txt"), "ok\n");
		await host.callTool("verify", {});
		assert.equal(host.custom(ENTRY.checkpoint).length, 1);
		appendFileSync(join(host.cwd, "notes.txt"), "x");
		await host.exec("rm state.txt", false);
		rmSync(join(host.cwd, "state.txt"));
		const result = await host.callTool("verify", {});
		assert.match(result.content[0].text, /REGRESSION: state passed at Best Checkpoint/);
		assert.equal(host.custom(ENTRY.checkpoint).length, 1, "a result with a Regression never becomes best");
	});

	test("a changed pinned directory makes the verdict an Invalid Result, which never passes", async () => {
		writeFileSync(join(host.cwd, "state.txt"), "ok\n");
		writeFileSync(join(host.cwd, "notes.txt"), "ok\n");
		writeFileSync(join(host.cwd, ".omp", "horizon", "verify", "helper.txt"), "tampered");
		const result = await host.callTool("verify", {});
		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /Verifier Pin broken/);
		assert.match(JSON.stringify(await host.emit("session_stop")), /Invalid Result/);
	});

	test("writes into the pinned directory are blocked; reads and other paths are not", async () => {
		const block = (toolName: string, input: Record<string, unknown>) => host.emit("tool_call", { toolName, input });
		assert.match(JSON.stringify(await block("write", { path: ".omp/horizon/verify/run", content: "exit 0" })), /"block":true/);
		assert.match(JSON.stringify(await block("bash", { command: "echo '{}' >> .omp/horizon/verify/run" })), /"block":true/);
		assert.match(JSON.stringify(await block("edit", { input: `[${join(host.cwd, ".omp/horizon/verify/run")}#AB12]\nPUT 1:\n+x` })), /"block":true/);
		assert.equal(await block("bash", { command: "cat .omp/horizon/verify/run" }), undefined);
		assert.equal(await block("write", { path: "state.txt", content: "ok" }), undefined);
	});
});

describe("runs without a Verifier", () => {
	test("completion is allowed with outcome unverified", async () => {
		const host = await startedHost(false);
		assert.equal(await host.emit("session_stop"), undefined);
		assert.deepEqual(host.custom(ENTRY.outcome).map(o => o.outcome), ["unverified"]);
	});
});

describe("circuit breaker", () => {
	test("locks action tools on a trip and unlocks only after the agent writes the Graveyard", async () => {
		const host = await startedHost(false);
		await host.exec("labtool --version", true, "labtool: command not found");
		await host.exec("labtool -v", true, "labtool: command not found");
		await host.exec("ls /tmp", false);
		await host.exec("labtool --help", true, "labtool: command not found");
		assert.deepEqual(host.activeTools, ["read", "grep", "ledger"]);
		assert.match(host.sent.at(-1)?.content ?? "", /CIRCUIT BREAKER TRIPPED: 3 failures of `bash:labtool`/);

		// A reflection response without the Graveyard write keeps the lock and nudges once.
		await host.emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } });
		assert.deepEqual(host.activeTools, ["read", "grep", "ledger"]);
		assert.match(JSON.stringify(await host.emit("session_stop")), /Circuit breaker active/);

		await host.callTool("ledger", { ops: [{ op: "add", section: "graveyard", text: "labtool any flag → command not found (not installed)" }] });
		await host.emit("turn_end", { message: { role: "assistant", content: [{ type: "text", text: "recorded" }] } });
		assert.deepEqual(host.activeTools, ["read", "bash", "edit", "write", "grep", "ledger"]);
		assert.match(JSON.stringify(await host.emit("session_stop")), /Reflection recorded; action tools are unlocked/);
	});
});

describe("tool activation", () => {
	test("ledger and verify are active only during a run (verify only with a Verifier)", async () => {
		const host = new FakeOmp(project());
		extension(host.api());
		await host.emit("session_start");
		assert.deepEqual(host.activeTools, ["read", "bash", "edit", "write", "grep"]);
		await host.command("start default --verifier .omp/horizon/verify/run");
		assert.deepEqual(host.activeTools.slice(-2), ["ledger", "verify"]);
		await host.command("stop");
		assert.deepEqual(host.activeTools, ["read", "bash", "edit", "write", "grep"]);
	});
});

describe("ledger injection and subagents", () => {
	test("every LLM call gets the ledger with the pacing header; subagents get a read-only view", async () => {
		const host = await startedHost(true);
		await host.callTool("ledger", { ops: [{ op: "add", section: "ground_truth", text: "WinRM 5986 on DC01" }, { op: "set_frontier", text: "Kerberoast red case" }] });
		const result = (await host.emit("context", { messages: [{ role: "user", content: "hi" }] })) as { messages: { content: { text: string }[] }[] };
		const injected = result.messages.at(-1)?.content[0].text ?? "";
		assert.match(injected, /\[OMP Horizon \| Run .* \| Contract: default \| LLM calls: \d+ .*Verifier: not run yet/);
		assert.match(injected, /\[gt1\] WinRM 5986 on DC01/);
		assert.match(injected, /Kerberoast red case/);

		const sub = new FakeOmp(host.cwd);
		extension(sub.api());
		await sub.emit("session_start", {}, sub.ctx("sub"));
		const subView = (await sub.emit("context", { messages: [] }, sub.ctx("sub"))) as { messages: { content: { text: string }[] }[] };
		assert.match(subView.messages[0].content[0].text, /read-only/);
		assert.match(subView.messages[0].content[0].text, /WinRM 5986 on DC01/);
		const write = await sub.callTool("ledger", { ops: [{ op: "add", section: "graveyard", text: "x" }] }, sub.ctx("sub"));
		assert.equal(write.isError, true);
	});

	test("state survives a rebuild from the journal (resume)", async () => {
		const host = await startedHost(true);
		await host.callTool("ledger", { ops: [{ op: "add", section: "graveyard", text: "kinit -k → KDC_ERR_PREAUTH_FAILED" }] });
		const resumed = new FakeOmp(host.cwd);
		resumed.branch.push(...host.branch);
		extension(resumed.api());
		await resumed.emit("session_start");
		const listing = await resumed.callTool("ledger", { read: "graveyard" });
		assert.match(listing.content[0].text, /\[gy1\] kinit -k → KDC_ERR_PREAUTH_FAILED/);
	});
});

describe("extraction", () => {
	test("turns new transcript into ledger ops with real provenance and advances the watermark", async () => {
		const host = await startedHost(false);
		await host.exec("nmap -p 5986 10.20.0.10", false, "5986/tcp open wsmans");
		await host.command("extract");
		const ops = host.custom(ENTRY.ledger).flatMap(d => d.ops as { entry?: { text: string; source?: string; origin: string } }[]);
		assert.equal(ops[0]?.entry?.text, "DC01 = 10.20.0.10");
		assert.equal(ops[0]?.entry?.origin, "extraction");
		assert.ok(host.branch.some(e => e.id === ops[0]?.entry?.source), "source must be a journal entry id from the slice");
		assert.equal(host.custom(ENTRY.watermark).length, 1);
		await host.command("extract");
		assert.equal(host.custom(ENTRY.ledger).length, 1, "nothing past the watermark: no second call");
	});

	test("a failing extraction model stalls loudly and marks the ledger stale", async () => {
		const host = await startedHost(false, { ompBinary: "/bin/false" });
		await host.exec("id", false, "uid=0(root)");
		await host.command("extract");
		assert.ok(host.notices.some(n => n.includes("EXTRACTION FAILED")));
		const result = (await host.emit("context", { messages: [] })) as { messages: { content: { text: string }[] }[] };
		assert.match(result.messages[0].content[0].text, /ledger extraction has been failing/);
		assert.equal(host.custom(ENTRY.watermark).length, 0);
	});
});

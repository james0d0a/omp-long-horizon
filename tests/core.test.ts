import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FailureWindow } from "../src/breaker.ts";
import { applyProposedOps, current, emptyLedger, renderLedger } from "../src/ledger.ts";
import { redact } from "../src/redact.ts";
import { failureSignature, inlineScriptSignature } from "../src/signature.ts";

const bash = (command: string, resultText = "", details?: unknown) => failureSignature({ toolName: "bash", input: { command }, resultText, details });

describe("Failure Signature", () => {
	test("retries of one program with different flags share a signature", () => {
		assert.equal(bash("ansible-playbook site.yml --check"), bash("ansible-playbook -v site.yml"));
		assert.equal(bash("cd ansible && ansible ews01 -m win_shell -a 'x'"), bash("cd ansible && ansible ews01 -m win_ping"));
	});

	test("wrappers and env assignments do not change the signature", () => {
		assert.equal(bash("sudo timeout 30 FOO=1 nmap -sV 10.0.0.1"), bash("nmap 10.0.0.1"));
		assert.equal(bash("export X=1; virt-ls -a box.img /"), bash("virt-ls -a box.img /tmp"));
	});

	test("inline scripts are keyed by where they fail, not collapsed into the interpreter", () => {
		const tb = (line: number) => `Traceback (most recent call last):\n  File "<stdin>", line 4, in <module>\n  File "/lab/scenario/lab.py", line ${line}, in ps\nRuntimeError: boom`;
		const a = bash("python3 - <<'EOF'\nfrom lab import Host\nHost('a').ps('x')\nEOF", tb(79));
		const b = bash("python3 - <<'EOF'\nimport time\nfrom lab import Host\nHost('b').reboot()\nEOF", tb(79));
		const c = bash("python3 - <<'EOF'\nprint(1)\nEOF", tb(113));
		assert.equal(a, b);
		assert.notEqual(a, c);
		assert.notEqual(bash("python3 -c 'print(1/0)'"), bash("python3 -c 'import nope'"));
	});

	test("OMP's structured bash trace names the failing command, not the script's first command", () => {
		const details = { trace: { units: [{ nodes: [{ k: "simple", state: "ok", argv: ["make", "build"] }, { k: "simple", state: "fail", argv: ["kinit", "admin@LAB"] }] }] } };
		assert.equal(bash("make build && kinit admin@LAB", "", details), "bash:kinit");
		assert.equal(bash("make build && kinit admin@LAB", ""), "bash:make build");
	});

	test("subcommand tools keep their subcommand; script runs keep the script", () => {
		assert.notEqual(bash("git push origin main"), bash("git pull"));
		assert.equal(bash("python3 scenario/check.py /tmp/a"), bash("python3 ./check.py --dry"));
	});
});

describe("Circuit breaker window", () => {
	test("trips on the threshold-th failure of one signature, once", () => {
		const w = new FailureWindow({ threshold: 3, window: 8 });
		assert.equal(w.record("a", true), undefined);
		assert.equal(w.record("b", false), undefined);
		assert.equal(w.record("a", true), undefined);
		assert.equal(w.record("a", true), 3);
		assert.equal(w.record("a", true), undefined, "history is cleared after a trip");
	});

	test("a success of the same signature resets it; other successes do not", () => {
		const w = new FailureWindow({ threshold: 3, window: 8 });
		w.record("a", true);
		w.record("a", true);
		w.record("a", false);
		assert.equal(w.record("a", true), undefined);
		const v = new FailureWindow({ threshold: 3, window: 8 });
		v.record("a", true);
		v.record("ls", false);
		v.record("a", true);
		v.record("cat", false);
		assert.equal(v.record("a", true), 3);
	});

	test("a retry of the same inline script that succeeds clears its traceback-anchored failure", () => {
		const w = new FailureWindow({ threshold: 3, window: 8 });
		const cmd = "python3 - <<'EOF'\nfrom lab import Host\nHost('a').ps('x')\nEOF";
		const tb = 'Traceback (most recent call last):\n  File "<stdin>", line 3, in <module>\n  File "/lab/scenario/lab.py", line 79, in ps\nRuntimeError: boom';
		const failCall = { toolName: "bash", input: { command: cmd }, resultText: tb };
		const okCall = { toolName: "bash", input: { command: cmd }, resultText: "ok" };
		w.record(failureSignature(failCall), true, inlineScriptSignature(failCall));
		w.record(failureSignature(failCall), true, inlineScriptSignature(failCall));
		w.record(failureSignature(okCall), false, inlineScriptSignature(okCall));
		assert.equal(w.record(failureSignature(failCall), true, inlineScriptSignature(failCall)), undefined);
	});

	test("failures outside the window do not count", () => {
		const w = new FailureWindow({ threshold: 3, window: 4 });
		w.record("a", true);
		w.record("a", true);
		w.record("x", false);
		w.record("y", false);
		w.record("z", false);
		assert.equal(w.record("a", true), undefined);
	});
});

describe("Working Memory Ledger", () => {
	const opts = { origin: "extraction" as const, now: 1 };

	test("supersession is the only way an entry stops being current, and requires a reason", () => {
		const ledger = emptyLedger();
		applyProposedOps(ledger, [{ op: "add", section: "ground_truth", text: "WinRM on 5985" }], opts);
		const bad = applyProposedOps(ledger, [{ op: "supersede", id: "gt1", text: "WinRM on 5986" }], opts);
		assert.equal(bad.applied.length, 0);
		const good = applyProposedOps(ledger, [{ op: "supersede", id: "gt1", text: "WinRM on 5986", reason: "GPO moved it" }], opts);
		assert.equal(good.applied.length, 1);
		assert.deepEqual(current(ledger, "ground_truth").map(e => [e.id, e.text]), [["gt2", "WinRM on 5986"]]);
		assert.equal(ledger.entries.find(e => e.id === "gt1")?.supersedeReason, "GPO moved it");
		assert.equal(applyProposedOps(ledger, [{ op: "supersede", id: "gt1", text: "x", reason: "y" }], opts).applied.length, 0, "superseded entries cannot be superseded again");
	});

	test("duplicates of current entries and unknown sections are rejected; ops in one batch see each other", () => {
		const ledger = emptyLedger();
		const r = applyProposedOps(
			ledger,
			[
				{ op: "add", section: "graveyard", text: "kinit -k → KDC_ERR_PREAUTH_FAILED" },
				{ op: "add", section: "graveyard", text: "  KINIT -K → kdc_err_preauth_failed " },
				{ op: "add", section: "notes", text: "x" },
				{ op: "supersede", id: "gy1", text: "kinit -k → clock skew", reason: "re-run showed skew" },
			],
			opts,
		);
		assert.deepEqual(r.applied.map(a => a.op), ["add", "supersede"]);
		assert.equal(r.rejected.length, 2);
	});

	test("extraction provenance must point into the slice", () => {
		const ledger = emptyLedger();
		applyProposedOps(ledger, [{ op: "add", section: "ground_truth", text: "a", source: "e1" }, { op: "add", section: "ground_truth", text: "b", source: "zz" }], {
			...opts,
			validSources: new Set(["e1"]),
		});
		assert.deepEqual(ledger.entries.map(e => e.source), ["e1", undefined]);
	});

	test("render keeps all Ground Truth and the newest Graveyard within budget, pointing at the rest", () => {
		const ledger = emptyLedger();
		applyProposedOps(ledger, [{ op: "add", section: "ground_truth", text: "DC01 = 10.20.0.10" }], opts);
		for (let i = 1; i <= 60; i++) applyProposedOps(ledger, [{ op: "add", section: "graveyard", text: `approach ${i} failed with error code ${1000 + i} after a long explanation of why` }], opts);
		const text = renderLedger(ledger, { budgetTokens: 600, header: "[h]" });
		assert.match(text, /DC01 = 10\.20\.0\.10/);
		assert.match(text, /\[gy60\]/);
		assert.doesNotMatch(text, /\[gy1\] /);
		assert.match(text, /older Graveyard entries not shown/);
	});
});

describe("redaction", () => {
	test("secrets are replaced, structure and non-secret literals are kept", () => {
		const out = redact("LAB\\administrator creds: login admin:Winter2026! on 10.20.0.10:5986; http://elastic:changeme@10.20.0.20:9200/_cat");
		assert.doesNotMatch(out, /Winter2026!|changeme/);
		assert.match(out, /10\.20\.0\.10:5986/);
		assert.match(out, /10\.20\.0\.20:9200/);
		assert.match(out, /elastic:<redacted:url-credential#1>@/);
	});

	test("common secret forms", () => {
		const out = redact(
			[
				"ansible_password=Sup3rS3cret --password 'hunter22'",
				"sshpass -p 'labpass' ssh root@host",
				"aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0",
				"-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
				"PASSWORDS = {'alice': 'Alic3!'}",
			].join("\n"),
		);
		for (const secret of ["Sup3rS3cret", "hunter22", "labpass", "31d6cfe0d16ae931b73c59d7e0c089c0", "AAAA", "Alic3!"]) assert.ok(!out.includes(secret), secret);
	});

	test("the same secret maps to the same placeholder within one pass", () => {
		const out = redact("password=abc123 and later password=abc123");
		assert.equal(out.match(/<redacted:password#1>/g)?.length, 2);
	});
});

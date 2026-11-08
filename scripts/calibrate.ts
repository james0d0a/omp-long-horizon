/**
 * P0 calibration: profile a recorded OMP session and show what the Circuit Breaker would do.
 * Usage: node scripts/calibrate.ts <session.jsonl> [--threshold N] [--window M] [--verbose]
 */
import { churnWindows, loadTrace } from "../src/trace.ts";

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith("--"));
if (!file) {
	console.error("usage: node scripts/calibrate.ts <session.jsonl> [--threshold N] [--window M] [--verbose]");
	process.exit(2);
}
const flag = (name: string, fallback: number) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? Number(args[at + 1]) : fallback;
};
const threshold = flag("threshold", 3);
const window = flag("window", 8);
const verbose = args.includes("--verbose");

const trace = loadTrace(file);
const errors = trace.steps.filter(s => s.isError);
const execErrors = errors.filter(s => s.exec);
const byTool = new Map<string, number>();
for (const s of errors) byTool.set(s.toolName, (byTool.get(s.toolName) ?? 0) + 1);
const bySig = new Map<string, number>();
for (const s of execErrors) bySig.set(s.signature ?? "?", (bySig.get(s.signature ?? "?") ?? 0) + 1);

console.log(`trace: ${file}`);
console.log(
	`llm calls ${trace.llmCalls} | steps ${trace.steps.length} | exec steps ${trace.steps.filter(s => s.exec).length} | errors ${errors.length} (exec ${execErrors.length}, neutral ${errors.length - execErrors.length}) | compactions ${trace.compactions} | resets ${trace.resets}`,
);
console.log(`errors by tool: ${[...byTool].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log("top failing signatures:");
for (const [sig, n] of [...bySig].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(3)}  ${sig}`);

console.log("\nsensitivity (trips / recovered):");
for (const t of [2, 3, 4]) {
	const row = [6, 8, 12].map(w => {
		const ws = churnWindows(trace, { threshold: t, window: w }).filter(x => x.kind === "trip");
		return `w${w}: ${ws.length}/${ws.filter(x => x.recovered).length}`;
	});
	console.log(`  threshold ${t}: ${row.join("  ")}`);
}

const windows = churnWindows(trace, { threshold, window });
console.log(`\nchurn windows at threshold ${threshold}, window ${window}: ${windows.length}`);
for (const w of windows) {
	console.log(`  ${w.id} ${w.kind} steps ${w.startStep}-${w.endStep} ${w.recovered ? "recovered" : "UNRECOVERED"}: ${w.detail}`);
	if (!verbose) continue;
	for (const s of trace.steps.slice(w.startStep, w.endStep + 1).filter(s => s.exec)) {
		const cmd = String(s.input.command ?? s.input.code ?? "").replace(/\s+/g, " ").slice(0, 110);
		const out = s.text.replace(/\s+/g, " ").slice(0, 110);
		console.log(`      #${s.index} ${s.isError ? "ERR" : "ok "} ${s.signature}\n          $ ${cmd}\n          > ${out}`);
	}
}

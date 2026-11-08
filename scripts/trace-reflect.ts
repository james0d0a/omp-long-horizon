/**
 * Standalone trace-reflect (same pipeline as `/horizon reflect`).
 * Usage: node scripts/trace-reflect.ts <session.jsonl> [--skill name] [--skill-dir dir] [--project dir] [--out dir] [--model role|provider/id] [--omp path]
 */
import { resolve } from "node:path";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { runReflect } from "../src/reflect.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
	const at = args.indexOf(`--${name}`);
	return at >= 0 ? args[at + 1] : undefined;
};
const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
if (!file) {
	console.error("usage: node scripts/trace-reflect.ts <session.jsonl> [--skill name] [--skill-dir dir] [--project dir] [--out dir] [--model role] [--omp path]");
	process.exit(2);
}
const skillDir = option("skill-dir");
const summary = await runReflect({
	sessionFile: resolve(file),
	skill: option("skill"),
	skillDir: skillDir ? resolve(skillDir) : undefined,
	projectDir: resolve(option("project") ?? "."),
	outDir: resolve(option("out") ?? "reflect-out"),
	config: { ...DEFAULT_CONFIG, reflectRole: option("model") ?? DEFAULT_CONFIG.reflectRole, ompBinary: option("omp") ?? DEFAULT_CONFIG.ompBinary },
});
console.log(summary);

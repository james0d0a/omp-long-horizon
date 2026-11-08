import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LongHorizonConfig } from "./config.ts";
import { DEFAULT_CONTRACT, resolveSkillDir } from "./contract.ts";
import { unifiedDiff } from "./diff.ts";
import { isRecord } from "./omp.ts";
import { extractJson, ompOneShot } from "./proc.ts";
import { Redactor } from "./redact.ts";
import { type ChurnWindow, churnWindows, loadTrace, type Trace } from "./trace.ts";

export type LessonScope = "skill" | "contract" | "environment";
export const ENVIRONMENT_SECTIONS = ["Crown Jewels", "Trust Boundaries", "Telemetry", "Baseline Oddities", "Escalation"] as const;
type EnvironmentSection = (typeof ENVIRONMENT_SECTIONS)[number];

export interface Lesson {
	scope: LessonScope;
	text: string;
	windows: string[];
	section?: EnvironmentSection;
}

export interface Reflection {
	lessons: Lesson[];
	groundTruthKeys: string[];
	graveyardKeys: string[];
}

export const SKILL_SECTION = "## Verified Patterns & Pitfalls";

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max / 2)} …[${text.length - max} chars]… ${text.slice(-max / 2)}`);

/** Redacted excerpt of the steps around a window: every reflection input is a Ledger Export. */
export function windowExcerpt(trace: Trace, window: ChurnWindow, redactor: Redactor): string {
	const steps = trace.steps.slice(Math.max(0, window.startStep - 1), window.endStep + 1).slice(0, 14);
	const lines = steps.map(s => {
		const input = typeof s.input.command === "string" ? s.input.command : typeof s.input.code === "string" ? s.input.code : JSON.stringify(s.input);
		return `#${s.index} ${s.toolName} ${s.isError ? "FAILED" : "ok"}${s.signature ? ` [${s.signature}]` : ""}\n  $ ${clip(input.replace(/\s+/g, " "), 400)}\n  > ${clip(s.text.replace(/\s+/g, " "), 600)}`;
	});
	return redactor.redact(`### ${window.id} — ${window.kind}: ${window.detail} (${window.recovered ? "recovered" : "NOT recovered"})\n${lines.join("\n")}`);
}

const REFLECT_SYSTEM = `You analyse failure-to-recovery transitions from an autonomous agent's trace and distil reusable lessons.
Output ONLY one JSON object, no prose.`;

export function buildReflectPrompt(excerpts: string[], skillName: string | null, skillBody: string, contractText: string): string {
	return `Each window below is a span where the agent thrashed, regressed, or got invalid verification, followed (usually) by the step that recovered.
For each window, identify what actually fixed it, and turn that into lessons. Classify every lesson by scope:
- "skill": a reusable operational rule that holds in ANY environment where ${skillName ? `the "${skillName}" skill` : "this kind of work"} is used. No hostnames, IPs, credentials, or lab-specific paths.
- "environment": a fact about THIS environment (hosts, services, quirks, telemetry gaps, policies). Pick section from: ${ENVIRONMENT_SECTIONS.join(", ")}.
- "contract": nothing here; instead, propose new extraction keys in "ground_truth_keys" / "graveyard_keys". Each key is a plain-language sentence naming a category of facts a future run must preserve (like the existing keys), not an identifier.
Skip lessons already stated in the existing skill text or contract. Skip windows with no transferable lesson. Be concrete; one sentence each.

OUTPUT SCHEMA
{"lessons": [{"scope": "skill" | "environment", "section": "<environment section, environment scope only>", "text": "...", "windows": ["w1"]}],
 "ground_truth_keys": ["..."], "graveyard_keys": ["..."]}

EXISTING SKILL TEXT${skillName ? ` (${skillName})` : ""}
${skillBody ? clip(skillBody, 6000) : "(none)"}

EXISTING CONTRACT (horizon.yml)
${contractText || "(none)"}

WINDOWS
${excerpts.join("\n\n")}`;
}

/** Validates the reflection model's JSON. Unknown scopes and empty lessons are dropped. */
export function parseReflection(output: string, windowIds: ReadonlySet<string>): Reflection {
	const parsed = extractJson(output);
	if (!isRecord(parsed)) throw new Error("reflection output is not an object");
	const lessons: Lesson[] = [];
	for (const raw of Array.isArray(parsed.lessons) ? parsed.lessons : []) {
		if (!isRecord(raw) || typeof raw.text !== "string" || !raw.text.trim()) continue;
		const scope = raw.scope === "skill" || raw.scope === "environment" ? raw.scope : undefined;
		if (!scope) continue;
		const windows = Array.isArray(raw.windows) ? raw.windows.filter((w): w is string => typeof w === "string" && windowIds.has(w)) : [];
		const section = ENVIRONMENT_SECTIONS.find(s => s === raw.section) ?? (scope === "environment" ? "Baseline Oddities" : undefined);
		lessons.push({ scope, text: raw.text.trim().replace(/\s+/g, " "), windows, section });
	}
	const keys = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(v => v.trim()) : []);
	return { lessons, groundTruthKeys: keys(parsed.ground_truth_keys), graveyardKeys: keys(parsed.graveyard_keys) };
}

const bullet = (lesson: Lesson) => `- ${lesson.text}${lesson.windows.length ? ` _(trace-reflect: ${lesson.windows.join(", ")})_` : ""}`;

/** Appends bullets under `heading` (created at the end of the document when missing). */
export function appendUnderHeading(doc: string, heading: string, bullets: string[]): string {
	if (bullets.length === 0) return doc;
	const lines = doc.replace(/\n$/, "").split("\n");
	const level = heading.match(/^#+/)?.[0].length ?? 2;
	const at = lines.findIndex(l => l.trim() === heading.trim());
	if (at < 0) return `${lines.join("\n")}${lines.length && lines.at(-1) !== "" ? "\n" : ""}\n${heading}\n\n${bullets.join("\n")}\n`;
	let end = lines.length;
	for (let i = at + 1; i < lines.length; i++) {
		const m = lines[i].match(/^(#+)\s/);
		if (m && m[1].length <= level) {
			end = i;
			break;
		}
	}
	while (end > at + 1 && lines[end - 1].trim() === "") end--;
	lines.splice(end, 0, ...bullets);
	return `${lines.join("\n")}\n`;
}

/** Adds keys to a YAML list (`key:` followed by `  - item` lines), creating the list when missing. */
export function appendYamlList(doc: string, key: string, items: string[]): string {
	if (items.length === 0) return doc;
	const quoted = items.map(i => `  - ${JSON.stringify(i)}`);
	const lines = doc.replace(/\n$/, "").split("\n").filter((l, i, all) => !(all.length === 1 && l === ""));
	const at = lines.findIndex(l => l.startsWith(`${key}:`));
	if (at < 0) return `${[...lines, `${key}:`, ...quoted].join("\n")}\n`;
	let end = at + 1;
	while (end < lines.length && (/^\s+-\s/.test(lines[end]) || lines[end].trim() === "")) end++;
	while (end > at + 1 && lines[end - 1].trim() === "") end--;
	lines.splice(end, 0, ...quoted);
	return `${lines.join("\n")}\n`;
}

export interface ReflectOptions {
	sessionFile: string;
	skill?: string;
	/** Source directory of the skill to patch; defaults to the installed copy OMP resolves. */
	skillDir?: string;
	projectDir: string;
	outDir: string;
	config: LongHorizonConfig;
	/** Test seam: model call. */
	complete?: (systemPrompt: string, prompt: string) => Promise<string>;
}

/** trace-reflect: Churn Windows → reflection model → redacted, reviewable patches split by scope. Returns a summary. */
export async function runReflect(options: ReflectOptions): Promise<string> {
	const trace = loadTrace(options.sessionFile);
	const windows = churnWindows(trace, options.config.breaker);
	mkdirSync(options.outDir, { recursive: true });
	if (windows.length === 0) return `No Churn Windows in ${basename(options.sessionFile)} (${trace.steps.length} steps); nothing to reflect.`;

	const skillDir = options.skillDir ?? (options.skill ? await resolveSkillDir(options.skill, options.config.ompBinary, options.projectDir) : undefined);
	const read = (path: string | undefined) => (path && existsSync(path) ? readFileSync(path, "utf8") : null);
	const skillMd = read(skillDir && join(skillDir, "SKILL.md"));
	const contractYml = read(skillDir && join(skillDir, "horizon.yml"));
	const contextPath = join(options.projectDir, "SECURITY-CONTEXT.md");
	const securityContext = read(contextPath);

	const redactor = new Redactor();
	const excerpts = windows.map(w => windowExcerpt(trace, w, redactor));
	const complete =
		options.complete ??
		((systemPrompt: string, prompt: string) =>
			ompOneShot({ ompBinary: options.config.ompBinary, model: options.config.reflectRole, systemPrompt, prompt, timeoutMs: 600_000, cwd: options.projectDir }));
	const output = await complete(REFLECT_SYSTEM, buildReflectPrompt(excerpts, options.skill ?? null, skillMd ?? "", contractYml ?? ""));
	const reflection = parseReflection(output, new Set(windows.map(w => w.id)));
	const clean = (text: string) => redactor.redact(text);
	const lessons = reflection.lessons.map(l => ({ ...l, text: clean(l.text) }));

	const written: string[] = [];
	const emit = (name: string, patch: string, applyIn: string) => {
		if (!patch) return;
		writeFileSync(join(options.outDir, name), patch);
		written.push(`- ${name}: apply with \`git -C ${applyIn} apply ${join(options.outDir, name)}\``);
	};

	const skillLessons = lessons.filter(l => l.scope === "skill");
	if (skillDir && skillMd !== null) {
		emit("skill.patch", unifiedDiff(skillMd, appendUnderHeading(skillMd, SKILL_SECTION, skillLessons.map(bullet)), "SKILL.md"), skillDir);
		const gt = reflection.groundTruthKeys.map(clean);
		const gy = reflection.graveyardKeys.map(clean);
		// A new contract starts from the generic default keys so adding lessons never narrows extraction.
		const base =
			contractYml ??
			appendYamlList(
				appendYamlList(`# Horizon Contract for ${options.skill ?? basename(skillDir)}\n`, "ground_truth_keys", DEFAULT_CONTRACT.ground_truth_keys),
				"graveyard_keys",
				DEFAULT_CONTRACT.graveyard_keys,
			);
		emit("contract.patch", unifiedDiff(contractYml, appendYamlList(appendYamlList(base, "ground_truth_keys", gt), "graveyard_keys", gy), "horizon.yml"), skillDir);
	}
	const envLessons = lessons.filter(l => l.scope === "environment");
	if (envLessons.length) {
		let doc = securityContext ?? `# Security Context — ${basename(options.projectDir)}\n`;
		for (const section of ENVIRONMENT_SECTIONS) {
			doc = appendUnderHeading(doc, `## ${section}`, envLessons.filter(l => l.section === section).map(bullet));
		}
		emit("security-context.patch", unifiedDiff(securityContext, doc, "SECURITY-CONTEXT.md"), options.projectDir);
	}

	const report = [
		`# trace-reflect: ${basename(options.sessionFile)}`,
		"",
		`${trace.llmCalls} LLM calls, ${trace.steps.length} steps, ${windows.length} Churn Windows. All excerpts and lessons are secret-redacted (${redactor.count} secrets).`,
		"",
		"## Windows",
		...windows.map(w => `- ${w.id} ${w.kind} steps ${w.startStep}-${w.endStep} (${w.recovered ? "recovered" : "not recovered"}): ${clean(w.detail)}`),
		"",
		"## Lessons",
		...(lessons.length ? lessons.map(l => `- [${l.scope}${l.section ? `/${l.section}` : ""}] ${l.text} (${l.windows.join(", ") || "no window"})`) : ["- none"]),
		"",
		"## Proposed contract keys",
		...reflection.groundTruthKeys.map(k => `- ground_truth: ${clean(k)}`),
		...reflection.graveyardKeys.map(k => `- graveyard: ${clean(k)}`),
		"",
		"## Patches (review before applying; nothing was applied)",
		...(written.length ? written : ["- none generated"]),
		...(skillDir ? [] : ["", "No skill given (--skill): skill and contract patches were not generated."]),
	].join("\n");
	writeFileSync(join(options.outDir, "report.md"), `${report}\n`);
	return `trace-reflect: ${windows.length} windows, ${lessons.length} lessons, ${written.length} patches → ${options.outDir}`;
}

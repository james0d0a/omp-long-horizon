import { createHash } from "node:crypto";
import { isRecord } from "./omp.ts";

/** Tools whose failures can indicate thrashing; only these produce Failure Signatures. */
export const EXEC_TOOLS: ReadonlySet<string> = new Set(["bash", "eval", "python", "ssh"]);

/**
 * Tools that never change the workspace or environment. Calls to anything else count as an
 * action step (conservative: unknown extension tools are treated as actions).
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"find",
	"lsp",
	"web_search",
	"todo",
	"ask",
	"wait",
	"recall",
	"context_notes",
	"checkpoint",
	"ledger",
	"verify",
]);

const WRAPPERS = new Set(["sudo", "doas", "nice", "time", "nohup", "stdbuf", "env", "timeout", "command", "exec"]);
const SKIP_HEADS = new Set(["cd", "pushd", "popd", "export", "set", "source", ".", "echo", "printf", "true", ":", "unset", "sleep", "mkdir"]);
const INLINE_INTERPRETERS = new Set(["python", "python3", "node", "bun", "deno", "ruby", "perl", "bash", "sh", "zsh", "pwsh", "powershell"]);
const INLINE_FLAGS = new Set(["-", "-c", "-e", "-E", "--eval", "-Command", "-command"]);
const SHELL_PREFIX_KEYWORDS = new Set(["do", "then", "else", "!", "{", "("]);
const SHELL_CLAUSE_KEYWORDS = new Set(["for", "while", "until", "if", "elif", "case", "done", "fi", "esac", "}", ")"]);
/** Programs whose first positional selects a distinct operation, which is part of the signature. */
const SUBCOMMAND_TOOLS = new Set([
	"git",
	"docker",
	"podman",
	"kubectl",
	"helm",
	"systemctl",
	"apt",
	"apt-get",
	"dnf",
	"yum",
	"pip",
	"pip3",
	"npm",
	"cargo",
	"go",
	"vagrant",
	"terraform",
	"packer",
	"az",
	"aws",
	"gcloud",
	"virsh",
	"ansible-galaxy",
	"make",
	"netexec",
	"nxc",
	"crackmapexec",
]);

export interface SignatureInput {
	toolName: string;
	input: Record<string, unknown>;
	resultText: string;
	details?: unknown;
}

const shortHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);

const baseName = (token: string) => {
	const trimmed = token.replace(/\/+$/, "");
	const slash = trimmed.lastIndexOf("/");
	return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
};

/** Split a shell word list conservatively (quotes respected, no expansion). */
export function shellWords(segment: string): string[] {
	const words: string[] = [];
	const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
	for (let m = re.exec(segment); m; m = re.exec(segment)) {
		words.push(m[1] ?? m[2] ?? m[3] ?? "");
	}
	return words;
}

function stripWrappers(argv: string[]): string[] {
	let i = 0;
	while (i < argv.length) {
		const word = argv[i];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			i++;
			continue;
		}
		const head = baseName(word);
		if (!WRAPPERS.has(head)) break;
		i++;
		// Skip wrapper options and, for `timeout`, its duration operand.
		while (i < argv.length && (argv[i].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]))) i++;
		if (head === "timeout" && i < argv.length && /^\d+(\.\d+)?[smhd]?$/.test(argv[i])) i++;
	}
	return argv.slice(i);
}

/** Exception anchor from a traceback: deepest real-file frame plus exception class. */
export function errorAnchor(resultText: string): string | undefined {
	const frames = [...resultText.matchAll(/File "([^"]+)", line (\d+)/g)].filter(
		m => !m[1].startsWith("<") && !m[1].includes("/site-packages/") && !m[1].includes("/lib/python"),
	);
	const exception = resultText.match(/^(?:[\w.]+\.)?(\w+(?:Error|Exception|Interrupt|Exit))\b/m)?.[1];
	const frame = frames.at(-1);
	if (frame) return `${baseName(frame[1])}:${frame[2]}${exception ? `:${exception}` : ""}`;
	if (exception) return exception;
	const jsFrame = resultText.match(/at .*\(([^()]+):(\d+):\d+\)/);
	if (jsFrame) return `${baseName(jsFrame[1])}:${jsFrame[2]}`;
	return undefined;
}

/** argv of the last failing simple command from OMP's structured bash trace, when present. */
function failingArgvFromTrace(details: unknown): string[] | undefined {
	if (!isRecord(details) || !isRecord(details.trace) || !Array.isArray(details.trace.units)) return undefined;
	let found: string[] | undefined;
	for (const unit of details.trace.units) {
		if (!isRecord(unit) || !Array.isArray(unit.nodes)) continue;
		for (const node of unit.nodes) {
			if (isRecord(node) && node.k === "simple" && node.state === "fail" && Array.isArray(node.argv)) {
				found = node.argv.filter((a): a is string => typeof a === "string");
			}
		}
	}
	return found && found.length > 0 ? found : undefined;
}

/** Main command of a bash script: first segment whose head is not navigation/setup noise. */
function mainArgvFromCommand(command: string): string[] {
	const firstLine = command.split(/<<-?\s*['"]?\w+['"]?/)[0];
	const segments = firstLine.split(/&&|\|\||;|\||\n/);
	let fallback: string[] = [];
	for (const segment of segments) {
		// Shell keywords (`for x in …; do cmd; done`) wrap the command; skip them to reach it.
		let argv = stripWrappers(shellWords(segment.trim()));
		while (argv.length && SHELL_PREFIX_KEYWORDS.has(argv[0])) argv = argv.slice(1);
		if (argv.length === 0 || SHELL_CLAUSE_KEYWORDS.has(argv[0])) continue;
		if (fallback.length === 0) fallback = argv;
		if (!SKIP_HEADS.has(baseName(argv[0]))) return argv;
	}
	return fallback;
}

function argvSignature(argv: string[], command: string, resultText: string): string {
	const stripped = stripWrappers(argv);
	if (stripped.length === 0) return "bash:?";
	const bin = baseName(stripped[0]);
	const rest = stripped.slice(1);
	const heredoc = /<<-?\s*['"]?\w+/.test(command);
	const inline =
		INLINE_INTERPRETERS.has(bin) && (rest.length === 0 || INLINE_FLAGS.has(rest[0]) || (heredoc && !rest.some(a => /\.\w+$/.test(a))));
	if (inline) {
		const anchor = errorAnchor(resultText);
		const script = INLINE_FLAGS.has(rest[0]) && rest[1] ? rest[1] : command;
		return `bash:${bin}:inline:${anchor ?? shortHash(script.replace(/\s+/g, " ").trim().slice(0, 400))}`;
	}
	if (INLINE_INTERPRETERS.has(bin)) {
		const script = rest.find(a => !a.startsWith("-"));
		return script ? `bash:${bin} ${baseName(script).slice(0, 40)}` : `bash:${bin}`;
	}
	if (SUBCOMMAND_TOOLS.has(bin)) {
		const sub = rest.find(a => !a.startsWith("-"));
		return sub ? `bash:${bin} ${sub.slice(0, 40)}` : `bash:${bin}`;
	}
	// Flag values and positionals are what thrashing varies (`kinit -k admin` vs `kinit -kt x.keytab admin`).
	return `bash:${bin}`;
}

/**
 * Failure Signature of a tool call: the tool plus its normalized command, so retries of the
 * same command with different flags share one signature, while distinct inline scripts are
 * keyed by where they fail (traceback anchor) rather than collapsing into one interpreter.
 */
export function failureSignature(call: SignatureInput): string {
	if (call.toolName === "bash") {
		const command = typeof call.input.command === "string" ? call.input.command : "";
		const traced = failingArgvFromTrace(call.details);
		return argvSignature(traced ?? mainArgvFromCommand(command), command, call.resultText);
	}
	if (call.toolName === "eval" || call.toolName === "python") {
		const code = typeof call.input.code === "string" ? call.input.code : JSON.stringify(call.input);
		return `${call.toolName}:${errorAnchor(call.resultText) ?? shortHash(code.replace(/\s+/g, " ").trim().slice(0, 400))}`;
	}
	const target = typeof call.input.host === "string" ? call.input.host : "";
	return target ? `${call.toolName}:${target}` : call.toolName;
}

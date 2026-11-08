/**
 * Deterministic secret redaction for every Ledger Export (disk mirror, trace-reflect output).
 * Structure is preserved (`admin:<redacted:password#1>`) so exports stay readable; identical
 * secrets map to the same placeholder within one redaction pass.
 */

interface Rule {
	kind: string;
	pattern: RegExp;
	/** Capture group holding the secret; 0 = whole match. */
	group: number;
}

const RULES: readonly Rule[] = [
	{ kind: "private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, group: 0 },
	{ kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, group: 0 },
	{ kind: "aws-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, group: 0 },
	{ kind: "token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})/g, group: 0 },
	{ kind: "ntlm", pattern: /\b[0-9a-fA-F]{32}:[0-9a-fA-F]{32}\b/g, group: 0 },
	{ kind: "hash", pattern: /\b(?:NTLM|NT hash|LM hash|nthash|hash)\s*[:=]\s*([0-9a-fA-F]{32,128})\b/gi, group: 1 },
	{ kind: "kerberos", pattern: /\$krb5(?:tgs|asrep|pa)\$[^\s'"]{20,}/g, group: 0 },
	{ kind: "bearer", pattern: /\b(?:Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{12,})/g, group: 1 },
	{ kind: "url-credential", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]+)@/gi, group: 1 },
	{
		kind: "password",
		pattern: /(?:\b(?:password|passwd|pwd|pass|secret|token|api[_-]?key|apikey|ansible_password|ansible_become_pass)\b\s*[:=]\s*)(["']?)([^\s"',;}]{3,})\1/gi,
		group: 2,
	},
	{ kind: "password", pattern: /(?:--password|--pass|--passwd|--secret|--token|--api-key)(?:=|\s+)(["']?)([^\s"']{3,})\1/gi, group: 2 },
	{ kind: "password", pattern: /\b(?:sshpass|mysql|psql|smbclient|net use)\b[^\n]*?\s-p\s*(["']?)([^\s"']{3,})\1/gi, group: 2 },
	{ kind: "credential", pattern: /\b(?:[A-Za-z0-9_.-]+\\)?[A-Za-z0-9_.-]+\s*(?:\/|:)\s*(["'])([^"'\s]{4,})\1/g, group: 2 },
	{ kind: "credential", pattern: /\b(?:cred(?:ential)?s?|login)\b[^\n]{0,40}?\b[A-Za-z0-9_.\\-]+:([^\s:@]{4,})(?=\s|$|[,;)])/gi, group: 1 },
	{ kind: "password", pattern: /(?:pass|cred|secret)[^\n]*?(["'])[\w.\\-]+\1\s*:\s*(["'])([^"'\n]{3,})\2/gi, group: 3 },
];

/** Placeholders are swapped for opaque tokens while rules run so no rule re-matches them. */
const TOKEN = (n: number) => `\u0001${n}\u0001`;

export class Redactor {
	readonly #seen = new Map<string, string>();
	readonly #counts = new Map<string, number>();

	#placeholder(kind: string, secret: string): string {
		const key = `${kind}\0${secret}`;
		const existing = this.#seen.get(key);
		if (existing) return existing;
		const n = (this.#counts.get(kind) ?? 0) + 1;
		this.#counts.set(kind, n);
		const placeholder = `<redacted:${kind}#${n}>`;
		this.#seen.set(key, placeholder);
		return placeholder;
	}

	redact(text: string): string {
		const tokens: string[] = [];
		let out = text;
		for (const rule of RULES) {
			out = out.replace(rule.pattern, (match: string, ...groups: unknown[]) => {
				const secret = rule.group === 0 ? match : groups[rule.group - 1];
				if (typeof secret !== "string" || !secret || secret.includes("\u0001")) return match;
				const index = rule.group === 0 ? 0 : match.lastIndexOf(secret);
				tokens.push(this.#placeholder(rule.kind, secret));
				return `${match.slice(0, index)}${TOKEN(tokens.length - 1)}${match.slice(index + secret.length)}`;
			});
		}
		return out.replace(/\u0001(\d+)\u0001/g, (_m, n: string) => tokens[Number(n)] ?? "");
	}

	get count(): number {
		return this.#seen.size;
	}
}

export function redact(text: string): string {
	return new Redactor().redact(text);
}

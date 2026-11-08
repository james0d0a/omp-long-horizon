/** Minimal line-based unified diff (LCS), enough for git-apply-able patches of small text files. */

type Op = { kind: " " | "-" | "+"; line: string };

function diffLines(a: string[], b: string[]): Op[] {
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	}
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ kind: " ", line: a[i++] });
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ kind: "-", line: a[i++] });
		else ops.push({ kind: "+", line: b[j++] });
	}
	while (i < n) ops.push({ kind: "-", line: a[i++] });
	while (j < m) ops.push({ kind: "+", line: b[j++] });
	return ops;
}

const splitLines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));

/** Unified diff of `before` → `after` for `path`; empty string when identical. `before === null` creates the file. */
export function unifiedDiff(before: string | null, after: string, path: string, context = 3): string {
	if (before === after) return "";
	const ops = diffLines(splitLines(before ?? ""), splitLines(after));
	const header = [`diff --git a/${path} b/${path}`, ...(before === null ? ["new file mode 100644"] : []), `--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
	const hunks: string[] = [];
	let k = 0;
	let oldLine = 1;
	let newLine = 1;
	const positions = ops.map(op => {
		const pos = { oldLine, newLine };
		if (op.kind !== "+") oldLine++;
		if (op.kind !== "-") newLine++;
		return pos;
	});
	while (k < ops.length) {
		if (ops[k].kind === " ") {
			k++;
			continue;
		}
		let lastChange = k;
		for (let e = k + 1; e < ops.length; e++) {
			if (ops[e].kind !== " ") lastChange = e;
			else if (e - lastChange > context * 2) break;
		}
		const start = Math.max(0, k - context);
		const end = Math.min(ops.length, lastChange + context + 1);
		const slice = ops.slice(start, end);
		const oldCount = slice.filter(o => o.kind !== "+").length;
		const newCount = slice.filter(o => o.kind !== "-").length;
		const oldStart = oldCount === 0 ? positions[start].oldLine - 1 : positions[start].oldLine;
		const newStart = newCount === 0 ? positions[start].newLine - 1 : positions[start].newLine;
		hunks.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...slice.map(o => `${o.kind}${o.line}`));
		k = end;
	}
	return `${[...header, ...hunks].join("\n")}\n`;
}

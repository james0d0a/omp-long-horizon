import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "./proc.ts";

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
	const result = await runProcess("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env, timeoutMs: 120_000 });
	if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${(result.spawnError ?? result.stderr).trim().slice(0, 300)}`);
	return result.stdout.trim();
}

/**
 * Snapshots the whole working tree (tracked and untracked, honouring .gitignore) into
 * `refs/omp-horizon/<runId>/<n>` through a temporary index. HEAD, the real index, branches,
 * and the stash are never touched; restoring is the user's explicit `git checkout <ref> -- .`.
 */
export async function gitSnapshot(cwd: string, runId: string, n: number, message: string): Promise<string> {
	const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
	const tmp = mkdtempSync(join(tmpdir(), "omp-horizon-index-"));
	const env = { GIT_INDEX_FILE: join(tmp, "index") };
	try {
		const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]).catch(() => "");
		if (head) await git(root, ["read-tree", head], env);
		await git(root, ["add", "-A", "."], env);
		const tree = await git(root, ["write-tree"], env);
		const commit = await git(root, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", message]);
		const ref = `refs/omp-horizon/${runId}/${n}`;
		await git(root, ["update-ref", ref, commit]);
		return `${ref} (${commit.slice(0, 12)})`;
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

/** Runs the contract's checkpoint_cmd (e.g. VM snapshots); the last stdout line is the checkpoint id. */
export async function scriptCheckpoint(command: string, cwd: string, label: string): Promise<string> {
	const result = await runProcess("sh", ["-c", command], { cwd, timeoutMs: 600_000, env: { ...process.env, OMP_HORIZON_CHECKPOINT_LABEL: label } });
	if (result.spawnError || result.timedOut || result.code !== 0) {
		throw new Error(`checkpoint_cmd failed (${result.timedOut ? "timeout" : `exit ${result.code}`}): ${(result.spawnError ?? result.stderr).trim().slice(-300)}`);
	}
	const id = result.stdout.trim().split("\n").at(-1)?.trim();
	if (!id) throw new Error("checkpoint_cmd printed no checkpoint id");
	return id;
}

# omp-long-horizon

OMP extension that keeps multi-hour autonomous runs on track: a **Working Memory Ledger** that survives compaction, a **Circuit Breaker** for tool thrashing, a pinned **Verifier** gate on completion, **Best Checkpoints**, and a post-mortem **trace-reflect**. Vocabulary: [CONTEXT.md](CONTEXT.md). Design: [docs/architecture.md](docs/architecture.md), decisions in [docs/adr/](docs/adr/).

Everything is inert outside a **Horizon Run**; the `ledger` and `verify` tools are only activated while a run needs them.

## Install

```sh
omp plugin link ~/git/omp-long-horizion        # or per session: omp -e ~/git/omp-long-horizion/src/index.ts
```

Requires `omp` ≥ 18.18 on `PATH` (Extraction and trace-reflect call it as a subprocess, see ADR-0004). Node ≥ 22.18 only for tests and the standalone scripts.

## Running

```sh
omp --horizon detection-engineering                 # bind that skill's horizon.yml
omp --horizon default --horizon-verifier ./verify   # generic contract, explicit verifier
```

Or in a session: `/horizon start [skill|default] [--verifier path|none]`.

| Command | Effect |
|---|---|
| `/horizon status` | Run id, verifier pin, last verdict, Best Checkpoint, ledger counts, breaker and extraction state |
| `/horizon ledger` | List the ledger and refresh the redacted mirror |
| `/horizon extract` | Run Extraction now (catch-up to the journal) |
| `/horizon repin [path]` | Re-pin the verifier directory after *you* changed it |
| `/horizon stop` | End the run |
| `/horizon reflect <session.jsonl> [--skill name] [--project dir] [--out dir]` | trace-reflect |

During a run:

- **Ledger** — injected at the tail of every LLM call (never persisted into history), with a pacing header: LLM calls, elapsed, context %, verifier state, Best Checkpoint. Stored as journal entries, so it follows rewind/branch/fork/resume. Written by background Extraction (the `smol` role by default) and by the agent via `ledger`. Ground Truth and Graveyard are append-only; corrections are supersessions with a reason. A redacted copy is written to `.omp/WORKING_MEMORY.md` (add it to the project's `.gitignore`).
- **Circuit Breaker** — when one Failure Signature (e.g. `bash:kinit`, `bash:git push`, `bash:python3:inline:lab.py:79:RuntimeError`) fails 3 times within 8 exec steps with no success of that same command in between, action tools are locked to read-only + `ledger` until the agent records the falsified assumption in the Graveyard (max 2 calls).
- **Verifier gate** — completion is blocked until the latest `verify` is fresh (no action steps since), from the pinned directory, and passes every Criterion. The same rejection 3 times with no new Best Checkpoint ends the run as `blocked`. Writes into the pinned directory are blocked; any change to it makes results Invalid.
- **Best Checkpoint** — on a verdict whose passing set strictly contains the best one: `git` snapshots the whole tree to `refs/omp-horizon/<run>/<n>` without touching HEAD, index, or branches (restore: `git checkout <commit> -- .`); `script` runs `checkpoint_cmd` and records its last stdout line. A verdict that loses a best-passing Criterion is reported as a Regression and never becomes best.
- **Subagents** see a read-only ledger and have their own breaker.

## Horizon Contract (`horizon.yml` beside a skill's `SKILL.md`)

```yaml
ground_truth_keys: ["…facts Extraction must preserve…"]
graveyard_keys: ["…dead ends to record…"]
checkpoint_strategy: git        # git | script | none
checkpoint_cmd: ./snapshot.sh   # script only; prints the checkpoint id last
verifier: .omp/horizon/verify/run   # project-relative, or skill:scripts/verify for skill-shipped
verifier_output: json           # json | exit_code
verifier_timeout_sec: 600
verify_interval_steps: 10       # steer a verify after this many action steps
ledger_budget_tokens: 6000
```

Without `horizon.yml` (or with `--horizon default`) the generic contract applies. Keep the verifier in its own directory: the whole directory is pinned.

**Verifier output** — the last stdout line that is `{"criteria":[{"id":"…","ok":true|false,"detail":"…"}]}`. Crashes, timeouts, and unparseable output are Invalid Results (never a pass or fail). `verifier_output: exit_code` maps exit 0 to a single `exit_zero` criterion.

## Configuration (`longHorizon:` in `~/.omp/agent/config.yml` or `<project>/.omp/config.yml`)

| Key | Default | |
|---|---|---|
| `extractionRole` | `smol` | Role or `provider/model`. Fails loudly; never falls back to another provider |
| `extractionIntervalCalls` | `8` | LLM calls between background Extraction passes |
| `extractionTimeoutSec` / `extractionChunkChars` | `120` / `60000` | |
| `breaker.threshold` / `breaker.window` | `3` / `8` | Calibrated on a 1,454-call lab trace (`npm run calibrate`) |
| `stallRejections` | `3` | Identical gate rejections before outcome `blocked` |
| `maxLlmCalls` / `maxMinutes` | unset | Pacing only: shown in the header, never enforced |
| `mirrorPath` | `.omp/WORKING_MEMORY.md` | `""` disables the mirror |
| `reflectRole` | default model | trace-reflect model |
| `ompBinary` | `omp` | |

## trace-reflect

```sh
npm run trace-reflect -- <session.jsonl> --skill detection-engineering \
  --skill-dir ~/git/sec-skills/skills/investigation/detection-engineering --project ~/git/ot_detection_lab --out reflect-out
```

Finds Churn Windows (breaker trips, Regressions, runs of Invalid Results) and writes `report.md` plus reviewable patches, never applied: `skill.patch` (SKILL.md "Verified Patterns & Pitfalls"), `contract.patch` (horizon.yml keys), `security-context.patch` (the project's SECURITY-CONTEXT.md, environment-model format). Excerpts sent to the model and everything written are secret-redacted.

## Development

```sh
npm install && npm run typecheck && npm test
npm run calibrate -- <session.jsonl> [--threshold N] [--window M] [--verbose]
```

Interplay with `omp-cyber-harness`: see ADR-0003.

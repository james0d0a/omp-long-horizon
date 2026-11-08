# omp-long-horizon

An OMP plugin that keeps multi-hour autonomous runs on track across context compactions and repeated tool failures:

- **Working Memory Ledger** — preserves verified facts (**Ground Truth**) and failed approaches (**Graveyard**) across compaction.
- **Circuit Breaker** — detects when the agent thrashes on the same failing command (`3` failures in `8` exec steps) and locks action tools until it records what went wrong.
- **Pinned Verifier & Checkpoints** — blocks premature completion until an external verifier script passes every criterion, and snapshots git state whenever the score improves.
- **`trace-reflect`** — turns post-mortem session logs into reviewable patches for your skill, contract, and project `SECURITY-CONTEXT.md`.

Outside a Horizon Run, the plugin is completely inert.

---

## Install

```sh
omp plugin link ~/git/omp-long-horizion
```

Requires `omp` ≥ 18.18 on `PATH`.

---

## Pre-Flight Checklist: What Do You Need Before a Run?

Only the plugin itself is strictly required, but a full setup has four parts:

| Requirement | Required? | What to set up |
|---|---|---|
| **1. `smol` model role** | **Yes** | Background extraction calls `@smol` via `omp`. Ensure `smol` is configured in `~/.omp/agent/config.yml` (or override `longHorizon.extractionRole`). |
| **2. Skill (`horizon.yml`)** | Optional | Pass a skill name (`--horizon detection-engineering`) to use its `horizon.yml`, or pass `--horizon default` to use the built-in generic contract. |
| **3. Verifier script** | Recommended | An executable script in its own directory (e.g. `.omp/horizon/verify/run`) that outputs criteria JSON. If you don't have one, pass `--horizon-verifier none` (you still get the Ledger and Circuit Breaker). |
| **4. `.gitignore`** | Recommended | Add `.omp/WORKING_MEMORY.md` to your project's `.gitignore` (it is a secret-redacted read-only mirror of the ledger). |

---

## Quickstart Example: Running `ot_detection_lab`

### 1. Create a Verifier (`.omp/horizon/verify/run`)

Put an executable script in its own directory (the whole directory is SHA-256 pinned when the run starts so the agent cannot edit the test to pass):

```sh
mkdir -p .omp/horizon/verify
chmod +x .omp/horizon/verify/run
```

The verifier checks the environment and prints a single `{"criteria": [...]}` JSON line on stdout:

```json
{"criteria":[
  {"id":"pcap-capture","ok":true,"detail":"modbus_reads=2880, s7_reads=1440"},
  {"id":"modbus-setpoint-writes","ok":true,"detail":"FC 6/16 count=64"},
  {"id":"rtu01-readonly","ok":false,"detail":"rtu01_writes=2 (expected 0)"}
]}
```

### 2. Start the Horizon Run

From the project directory (`~/git/ot_detection_lab`):

```sh
# Run with a skill contract (uses verifier path from the skill's horizon.yml):
omp --horizon detection-engineering

# Run with the generic contract + explicit verifier:
omp --horizon default --horizon-verifier .omp/horizon/verify/run

# Run without a verifier (Ledger + Circuit Breaker only):
omp --horizon detection-engineering --horizon-verifier none
```

You can also start or manage a run inside an interactive session:

| Slash Command | Action |
|---|---|
| `/horizon start [skill\|default] [--verifier path\|none]` | Start a Horizon Run in the current session |
| `/horizon status` | Show run ID, verifier score, Best Checkpoint, ledger counts, and breaker state |
| `/horizon ledger` | Print current Ground Truth, Graveyard, and Frontier |
| `/horizon extract` | Force an immediate background Extraction pass |
| `/horizon repin [path]` | Re-pin the verifier directory after *you* intentionally edited it |
| `/horizon stop` | End the active Horizon Run |

### 3. Restoring a Best Checkpoint

When `checkpoint_strategy: git` is active, each new Best Checkpoint is saved to a hidden git ref without touching `HEAD`, your branch, or the staging index. To roll the working tree back to a checkpoint shown in `/horizon status`:

```sh
git checkout refs/omp-horizon/<run-id>/<n> -- .
```

---

## Post-Mortem Learning (`trace-reflect`)

After a long run finishes, run `trace-reflect` on the session `.jsonl` transcript to extract lessons from any Churn Windows (circuit breaker trips, verifier regressions, or repeated invalid results):

```sh
npm run trace-reflect -- <session.jsonl> \
  --skill detection-engineering \
  --skill-dir ~/git/sec-skills/skills/investigation/detection-engineering \
  --project ~/git/ot_detection_lab \
  --out reflect-out
```

Or from inside OMP:

```text
/horizon reflect <session.jsonl> --skill detection-engineering --project ~/git/ot_detection_lab --out reflect-out
```

`trace-reflect` secret-redacts all excerpts and writes reviewable patches to `reflect-out/` (nothing is auto-applied):
- `report.md` — summary of Churn Windows and distilled lessons.
- `skill.patch` — reusable operational rules for `SKILL.md` (`## Verified Patterns & Pitfalls`).
- `contract.patch` — new `ground_truth_keys` / `graveyard_keys` for `horizon.yml`.
- `security-context.patch` — environment-specific quirks and telemetry gaps for the project's `SECURITY-CONTEXT.md`.

---

## Documentation

- **Configuration & `horizon.yml` Schema**: [docs/configuration.md](docs/configuration.md)
- **Architecture & Hook Flow**: [docs/architecture.md](docs/architecture.md)
- **Domain Vocabulary**: [CONTEXT.md](CONTEXT.md)
- **Architecture Decision Records**: [docs/adr/](docs/adr/)

## Development

```sh
npm install && npm run typecheck && npm test
npm run calibrate -- <session.jsonl> [--threshold N] [--window M] [--verbose]
```

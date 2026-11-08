# Configuration Reference

`omp-long-horizon` has two configuration surfaces:

1. **Horizon Contract (`horizon.yml`)** — per-skill settings (what facts to extract, how to checkpoint, and which verifier to run).
2. **Engine Settings (`longHorizon:`)** — user-level (`~/.omp/agent/config.yml`) or project-level (`<project>/.omp/config.yml`) runtime tuning.

---

## 1. Horizon Contract (`horizon.yml`)

Place `horizon.yml` beside a skill's `SKILL.md` (for example, `sec-skills/skills/investigation/detection-engineering/horizon.yml`).
When you run `omp --horizon default` or bind a skill that has no `horizon.yml`, the built-in generic contract is used.

```yaml
# Facts background Extraction must preserve in Ground Truth
ground_truth_keys:
  - "Hosts, IPs, ports, hostnames, and service versions confirmed reachable or running"
  - "Working credentials, keys, and tokens, with the exact command or flags that succeeded"

# Dead ends and falsified hypotheses to record in the Graveyard
graveyard_keys:
  - "Commands, flags, and approaches that failed, with the exact error text or code"
  - "Paths blocked by environment controls (firewall, policy, EDR), with the observed block"

# Workspace checkpointing on each new Best Checkpoint: git | script | none
checkpoint_strategy: git
checkpoint_cmd: ./snapshot.sh       # Required only when checkpoint_strategy: script (prints checkpoint ID on last stdout line)

# Verifier settings
verifier: .omp/horizon/verify/run   # Project-relative path, or skill:scripts/verify for a skill-bundled script
verifier_output: json               # json | exit_code
verifier_timeout_sec: 600
verify_interval_steps: 10           # Nudge the agent to run `verify` after this many action steps

# Token budget for the ledger block injected on each LLM call
ledger_budget_tokens: 6000
```

### Verifier Output Formats

Keep the verifier executable (`chmod +x`) in its own dedicated directory (e.g. `.omp/horizon/verify/run`). The entire directory is SHA-256 pinned at run start and write-protected during the run.

- **`verifier_output: json` (default)**:
  The verifier prints a JSON line on stdout (earlier stdout noise is ignored; the last matching JSON line wins):
  ```json
  {"criteria":[{"id":"pcap-capture","ok":true,"detail":"modbus_reads=2880"},{"id":"rtu01-readonly","ok":false,"detail":"2 writes observed"}]}
  ```
  - Progress and regressions are tracked per `id`.
  - A **Best Checkpoint** is created only when passing criteria are a strict superset of the previous best (zero regressions).
  - Crashes, timeouts, broken directory pins, or missing JSON produce an **Invalid Result** (never treated as pass or fail).
- **`verifier_output: exit_code`**:
  Maps process exit code `0` to a single passing `exit_zero` criterion (and non-zero to failing), using the last stdout line as `detail`.

---

## 2. Engine Settings (`config.yml`)

Add an optional `longHorizon:` block to `~/.omp/agent/config.yml` (global) or `<project>/.omp/config.yml` (project override):

```yaml
longHorizon:
  extractionRole: smol              # Model role or provider/model used for background ledger extraction
  extractionIntervalCalls: 8        # Main-session LLM calls between background extraction passes
  extractionTimeoutSec: 120
  extractionChunkChars: 60000
  breaker:
    threshold: 3                    # Failures of the same Failure Signature to trip the breaker
    window: 8                       # Sliding window of recent exec steps
  stallRejections: 3                # Identical completion-gate rejections before ending as `blocked`
  maxLlmCalls: 200                  # Optional pacing display in header (not enforced)
  maxMinutes: 240                   # Optional pacing display in header (not enforced)
  mirrorPath: ".omp/WORKING_MEMORY.md" # Secret-redacted disk mirror (`""` disables)
  reflectRole: plan                 # Optional model role for `trace-reflect` (defaults to default model)
  ompBinary: "omp"
```

| Key | Default | Description |
|---|---|---|
| `extractionRole` | `smol` | Role or `provider/model` for background Extraction. Fails loudly without falling back to another provider. |
| `extractionIntervalCalls` | `8` | LLM calls between background Extraction passes. |
| `extractionTimeoutSec` | `120` | Timeout per Extraction model call in seconds. |
| `extractionChunkChars` | `60000` | Max transcript characters processed per Extraction chunk. |
| `breaker.threshold` | `3` | Failures of one Failure Signature within `breaker.window` exec steps that trip the breaker. |
| `breaker.window` | `8` | Sliding window size (in exec steps) for the Circuit Breaker. |
| `stallRejections` | `3` | Identical stop-gate rejections with no new Best Checkpoint before the run ends as `blocked`. |
| `maxLlmCalls` / `maxMinutes` | unset | Shown in the pacing header for agent awareness; never terminates the run. |
| `mirrorPath` | `.omp/WORKING_MEMORY.md` | Path for the secret-redacted Markdown ledger mirror (`""` disables). |
| `reflectRole` | default model | Role or `provider/model` used by `trace-reflect`. |
| `ompBinary` | `omp` | `omp` executable invoked for Extraction and `trace-reflect`. |

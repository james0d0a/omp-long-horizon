# No Coupling with omp-cyber-harness; Offensive Horizon Runs Settle on the Fallback Model

The ledger is injected verbatim through the `context` hook on every LLM call, outside the pre-flight router's Regex Gate (which scans prompts and tool results) and its Context Sanitization (which redacts only flagged historical turns). Combined with the router's per-User-Turn Sticky Window (its ADR-0002) and a Horizon Run typically being one long User Turn, an offensive Horizon Run will likely trip the Refusal Backstop once and then stay on the Fallback Model for the rest of the run. We accept this rather than introduce a cross-repo contract (tagged ledger injections sanitized in `before_provider_request`, or per-step sticky decrement), so neither plugin depends on the other's internals or hook ordering.

## Consequences

- Do not "fix" refusals in Horizon Runs by redacting the ledger in this repo: the ledger's value is exact literals.
- If Primary-Model continuity in offensive runs becomes a requirement, revisit with the tagged-injection contract (router-side sanitization at `before_provider_request`, which runs after all `context` handlers regardless of load order).

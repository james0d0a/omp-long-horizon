# OMP Long-Horizon Engine

An OMP extension that keeps multi-hour autonomous runs on track across context compaction and repeated tool failure, parameterized per skill by a declarative contract.

## Language

**Horizon Run**:
A session explicitly started in long-horizon mode and bound to exactly one Horizon Contract; outside a Horizon Run the engine is inert.
_Avoid_: long-horizon session, autonomous mode, goal

**Horizon Contract**:
A skill's declaration of what Extraction must preserve and how progress is verified and checkpointed for a Horizon Run; a generic default applies when none is bound.
_Avoid_: active skill, skill config, rubric

**Working Memory Ledger**:
The structured, branch-scoped record of what a run has established — ground truth, dead ends, best checkpoint, and next step — kept in the session journal and shown to the model on every request.
_Avoid_: WORKING_MEMORY.md, scratchpad, notes, context notes

**Extraction**:
The harness-driven distillation of new transcript into Working Memory Ledger entries, performed incrementally behind the run rather than at eviction time.
_Avoid_: pre-compaction hook, summarization, compaction

**Ground Truth**:
A ledger entry recording a verified, exact-literal fact about the target environment that later work depends on.
_Avoid_: facts, findings, coordinates

**Graveyard**:
The ledger section of falsified hypotheses and failed approaches, each with its exact failure signal, that must not be retried.
_Avoid_: failures, blocklist, dead-ends list

**Frontier**:
The single current next diagnostic step the run is pursuing.
_Avoid_: todo, plan, next steps

**Supersession**:
The only way a Ground Truth or Graveyard entry stops being current: a newer entry replaces it with a stated reason, and the old one is kept as history.
_Avoid_: delete, edit, update

**Ledger Export**:
Any rendering of the Working Memory Ledger that leaves the session journal, such as the on-disk mirror or post-mortem output; always secret-redacted.
_Avoid_: dump, mirror file, snapshot

**Failure Signature**:
The identity of a failed action for thrash detection: the tool plus the normalized command it ran, so retries of the same command with different flags share one signature.
_Avoid_: error type, exit code

**Circuit Breaker Trip**:
The forced pause triggered when one Failure Signature fails repeatedly within a short window, during which the run must reflect instead of act.
_Avoid_: lockout, cooldown, retry limit

**Verifier**:
A deterministic, external check of the target environment that scores a Horizon Run's progress; its verdict, not the agent's claim, decides whether the run may finish.
_Avoid_: test, judge, rubric, grader

**Verifier Pin**:
The content hash of the Verifier's directory recorded when a Horizon Run starts; a result from an unpinned or altered Verifier is invalid.
_Avoid_: lock, checksum, signature

**Criterion**:
One named, independently pass/fail condition a Verifier reports; progress and regressions are judged per Criterion, not by a total.
_Avoid_: check, test case, score item

**Invalid Result**:
A Verifier run that produced no usable verdict (crash, unparseable output, or broken Verifier Pin); it never counts as pass or fail.
_Avoid_: error, failed verification

**Best Checkpoint**:
A restorable snapshot of the run's workspace or environment taken when the Verifier records new progress, referenced from the ledger; distinct from OMP's conversation-only `checkpoint` tool.
_Avoid_: checkpoint (bare), commit, save point, green checkpoint

**Regression**:
A Verifier result in which a Criterion that passed at the Best Checkpoint no longer passes; a result with any Regression can never become the Best Checkpoint.
_Avoid_: score drop, failure, rollback

**Run Outcome**:
How a Horizon Run ended: `passed` (fresh, pinned Verifier result with every Criterion ok), `blocked` (the stop gate rejected the same failing Criteria repeatedly with no progress, naming them), or `unverified` (the run had no Verifier).
_Avoid_: status, result, exit code

**Churn Window**:
A span of a finished run where progress stalled — a Circuit Breaker Trip, a Regression, or repeated Invalid Results — followed by a recovery; the unit post-mortem reflection learns from.
_Avoid_: failure window, thrash log

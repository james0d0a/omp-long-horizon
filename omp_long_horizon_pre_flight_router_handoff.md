Technical Handoff: Long-Horizon Execution & Skill-Parameterized State Engine for OMP1. ObjectiveUpgrade OMP to reliably execute multi-hour, 100+ turn autonomous workflows (such as self-healing cyber range buildouts, unattended firmware emulation/RE, and iterative OT detection tuning) without suffering from context compaction amnesia (Short-Horizon failure) or unproductive tool thrashing (Weak-Reflection failure).The architecture strictly separates Universal Harness Mechanics (implemented once in OMP's core loop) from Domain Extraction & Verification Rubrics (defined declaratively via horizon_contract YAML frontmatter inside individual SKILL.md files).2. System Architecture                     ┌──────────────────────────────────────┐
                     │     Active Skill (SKILL.md)          │
                     │  + horizon_contract (YAML schema)    │
                     └──────────┬───────────────────┬───────┘
                                │                   │
         Injects extraction keys│                   │ Injects verify_cmd
                                ▼                   ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ OMP Long-Horizon Turn Loop                                                │
│                                                                           │
│  1. [System Prompt Assembly] ◄── Pin `.omp/WORKING_MEMORY.md`             │
│  2. [Tool Execution]         ──► Track `consecutiveFailures`              │
│                                   ├─► If >= 3: Trip Circuit Breaker       │
│                                   │   (Disable tools 1 turn, force `plan`)│
│                                   └─► Append Pacing & Budget Footer       │
│  3. [Pre-Compaction Hook]    ──► Call `smol` (`GLM-5.3-flash`) to update  │
│                                  `WORKING_MEMORY.md` BEFORE truncating    │
│  4. [Verifier Gate]          ──► Run `verify_cmd` on completion attempt   │
│                                  or every K turns; auto-checkpoint on ⬆️  │
└───────────────────────────────────────────────────────────────────────────┘
3. Part 1: sec-skills Frontmatter Schema (horizon_contract)Extend your SKILL.md YAML frontmatter parser to recognize an optional horizon_contract block. If no skill is active (or the active skill omits this block), OMP falls back to a default generic contract.3.1. Schema DefinitionYAML---
name: skill-identifier
description: Skill description used for standard routing/loading.
horizon_contract:
  ground_truth_keys:
    - "Domain-specific immutable facts to preserve across compaction"
  graveyard_keys:
    - "Domain-specific failed hypotheses/commands to never retry"
  checkpoint_strategy: "git" | "script" | "none"
  checkpoint_cmd: "./optional_custom_snapshot_script.sh"
  default_verifier: "./optional_default_verifier_script.sh"
  verify_interval_turns: 10
---
3.2. Reference Skill ConfigurationsExample A: skills/purple-team-range/SKILL.mdYAMLhorizon_contract:
  ground_truth_keys:
    - "Provisioned host IPs, hostnames, domain SIDs, and VLAN subnets"
    - "Verified working credentials, SSH keys, and WinRM/SMB ports"
    - "Confirmed SIEM/Elastic indices and active log forwarder statuses"
  graveyard_keys:
    - "Ansible/Terraform modules or CLI flags that failed with fatal errors"
    - "Blocked network paths, firewall drops, or local GPO restrictions"
    - "Attack payloads or execution methods blocked by defender controls"
  checkpoint_strategy: "git"
  default_verifier: "./scripts/verify_range_health.sh"
  verify_interval_turns: 10
Example B: skills/firmware-re/SKILL.mdYAMLhorizon_contract:
  ground_truth_keys:
    - "CPU architecture, endianness, instruction set, and base load address"
    - "Confirmed function symbol addresses (init, main, parsers, crypto)"
    - "MMIO / peripheral register addresses and required return values"
  graveyard_keys:
    - "QEMU/Unicorn hook addresses or register stubs that caused segfaults or loops"
    - "False-positive string/xref offsets and invalid struct layouts"
    - "Decompression/unpacking offsets that yielded corrupt sections"
  checkpoint_strategy: "git"
  default_verifier: "./scripts/verify_emulation.py"
  verify_interval_turns: 8
4. Part 2: OMP Configuration (~/.omp/agent/config.yml)Add a longHorizon configuration block to ~/.omp/agent/config.yml:YAMLlongHorizon:
  enabled: true
  workingMemoryPath: ".omp/WORKING_MEMORY.md"
  maxTurnsBudget: 120              # Exposed to agent for pacing
  circuitBreakerThreshold: 3       # Consecutive tool failures before forced `plan` reflection
  compactionThresholdRatio: 0.75   # Trigger pre-compaction extraction at 75% context window
  autoGitCheckpoint: true          # Auto-commit to scratch branch when verifier score improves
5. Part 3: OMP Harness Implementation Specification5.1. Universal Working Memory Ledger (src/horizon/workingMemory.ts)Maintain .omp/WORKING_MEMORY.md on disk and inject its contents directly into the system prompt block so it is never subject to sliding-window message truncation.Initial Template:Markdown# WORKING MEMORY (PERSISTENT ACROSS COMPACTION)

## 1. Verified Ground Truth (Immutable Facts & Coordinates)
- None recorded yet.

## 2. Current Best Checkpoint & Score
- Last Verifier Score: Unverified
- Last Green Checkpoint: None

## 3. The Graveyard (Falsified Hypotheses — DO NOT RETRY)
- None recorded yet.

## 4. Active Frontier / Next Diagnostic Step
- Initial exploration.
5.2. Pre-Compaction Extraction Hook (src/horizon/compactionHook.ts)Trigger: Immediately before OMP’s existing context compaction/truncation function drops or summarizes historical messages.Read the current .omp/WORKING_MEMORY.md.Read the slice of messages scheduled for compaction/eviction.Load ground_truth_keys and graveyard_keys from the active skill's horizon_contract (or use generic defaults if no skill is active).Dispatch a non-streaming call to modelRoles.smol (GLM-5.3-flash):TypeScriptexport async function updateWorkingMemoryBeforeCompaction(
  evictedMessages: Message[],
  currentMemoryMarkdown: string,
  contract: HorizonContract,
  smolClient: LLMClient
): Promise<string> {
  const prompt = `
You are the state-preservation engine for a long-horizon autonomous agent.
The following conversation transcript slice is about to be evicted from context.
Update the WORKING_MEMORY.md document below so zero critical discoveries or dead ends are lost.

RULES:
1. NEVER delete existing Verified Ground Truth or Graveyard entries unless explicitly proven false in the new transcript.
2. Include exact literals: IP addresses, hex offsets, register names, file paths, CLI flags, and exact error codes.

EXTRACT INTO [1. Verified Ground Truth]:
${contract.ground_truth_keys.map((k) => `- ${k}`).join('\n')}

EXTRACT INTO [3. The Graveyard (Falsified Hypotheses — DO NOT RETRY)]:
${contract.graveyard_keys.map((k) => `- ${k}`).join('\n')}

CURRENT WORKING_MEMORY.md:
${currentMemoryMarkdown}

TRANSCRIPT SLICE TO EXTRACT FROM:
${formatMessagesForExtraction(evictedMessages)}

Return ONLY the complete, updated Markdown for WORKING_MEMORY.md.
`;

  const updated = await smolClient.complete({
    prompt,
    temperature: 0.0,
    max_tokens: 2000,
  });

  await fs.writeFile('.omp/WORKING_MEMORY.md', updated.trim(), 'utf8');
  return updated.trim();
}
5.3. Consecutive-Failure Circuit Breaker (src/horizon/circuitBreaker.ts)Solves Weak-Reflection thrashing when an agent guesses CLI flags in a tight loop.Track sessionState.consecutiveToolFailures (incremented whenever a bash/tool execution returns exitCode !== 0 or matches known error patterns; reset to 0 on a clean execution).When consecutiveToolFailures >= config.longHorizon.circuitBreakerThreshold (default 3):Override the next turn's model role to modelRoles.plan.Temporarily disable action/bash tool definitions for 1 turn (only allow read-only or memory-update tools).Inject a system directive at the tail of the message array:Plaintext[HARNESS CIRCUIT BREAKER TRIPPED: 3 Consecutive Tool Failures]
Action tools are locked for this turn. Do NOT attempt another command execution yet.
1. State the exact root cause shared across the last 3 failed attempts.
2. Record the falsified assumption in WORKING_MEMORY.md under The Graveyard.
3. Formulate a fundamentally different diagnostic approach for the next turn.
Reset consecutiveToolFailures = 0 after the reflection turn completes.5.4. Deterministic Verifier & Auto-Checkpointing (src/horizon/verifier.ts)Solves premature completion claims and state regression.CLI Flag / Skill Binding: Support --verifier <cmd> on the OMP CLI, or fall back to activeSkill.horizon_contract.default_verifier.Verifier Output Contract: Any verifier script outputs a JSON line on stdout (or the harness parses its exit code):JSON{"score": 3, "max_score": 5, "passed": false, "summary": "DC01 up, WinRM up, Kerberos SPN ok, Elastic missing EventID 4769"}
Execution Triggers:Every verify_interval_turns (e.g., every 10 turns).Mandatory gate whenever the agent emits a final completion response (stop_reason === 'end_turn' with no tool calls).Gate & Checkpoint Logic:If score > sessionState.bestScore:Update sessionState.bestScore = score.If autoGitCheckpoint is enabled, run git commit -am "[omp-checkpoint] score ${score}/${max_score}" on a scratch branch (or invoke checkpoint_cmd) and write the commit hash into WORKING_MEMORY.md.If the agent tried to finish the task (end_turn) while passed === false:Block termination, append the verifier scoreboard diff as a user message, and force the loop to continue:[HARNESS VERIFIER REJECTED COMPLETION: Score 3/5] Unmet criteria: Elastic missing EventID 4769. Continue execution.5.5. Budget & Pacing Telemetry Footer (src/horizon/telemetry.ts)In AREX-2, models adapt their exploration-vs-exploitation ratio when they know their remaining turn budget. Append a compact telemetry footer to every tool execution response before returning it to the LLM:TypeScriptexport function buildPacingFooter(state: SessionState, config: OmpConfig): string {
  const elapsedMin = Math.round((Date.now() - state.startTimeMs) / 60000);
  const contextPct = Math.round((state.currentTokenCount / state.maxContextTokens) * 100);
  const scoreStr = state.lastVerifierResult
    ? `${state.lastVerifierResult.score}/${state.lastVerifierResult.max_score}`
    : 'unverified';

  return `\n---\n[OMP Horizon | Turn: ${state.turnCount}/${config.longHorizon.maxTurnsBudget} | Elapsed: ${elapsedMin}m | Context: ${contextPct}% (Compacts @ 75%) | Verifier Score: ${scoreStr} | Best Checkpoint: ${state.lastCheckpointId ?? 'none'}]`;
}
6. Part 4: Post-Mortem trace-reflect Utility (scripts/trace-reflect.ts)To close the loop on long runs (turning 4-hour messy trajectories into reusable skill updates), add a standalone CLI command omp trace-reflect <session-id> --skill <path-to-SKILL.md>:Parse Trace: Load the JSONL transcript for <session-id>.Isolate Churn Windows: Identify any sequence of $\ge 3$ turns where tools returned errors or the verifier score stalled, followed by a recovery turn where the command succeeded or the score increased.Distill into Skill Diff: Send only those churn-and-recovery windows to your plan model with the prompt:PlaintextAnalyze these failure-to-recovery transitions from an agent trace.
Extract reusable operational rules, environment pitfalls, and working verification commands.
Format the output as a concise Markdown patch to append to the "Verified Patterns & Pitfalls" section and `horizon_contract` of the target SKILL.md.
Write Patch: Output a .patch or prompt to apply the distilled rules directly to SKILL.md so the next run starts with those lessons baked in on Turn 1.7. Implementation Order & Verification PlanPhase 1 (WORKING_MEMORY.md + Pacing Footer): Wire up the persistent file injection and the [OMP Horizon | ...] footer. Run a 30-turn session, force compaction at turn 15, and verify .omp/WORKING_MEMORY.md retains exact IPs/offsets discovered in turns 1–10.Phase 2 (Circuit Breaker): Run a test task with an intentionally broken CLI command. Verify that after 3 consecutive non-zero exits, OMP locks bash execution for 1 turn, switches to plan, logs the failed assumption to The Graveyard, and pivots on turn 5.Phase 3 (trace-reflect on your existing 4-hour Cyber Range log): Run the post-mortem script against your existing cyber lab trace first to generate the initial horizon_contract and pitfalls block for your range skill.

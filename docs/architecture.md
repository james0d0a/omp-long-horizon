# Architecture: Horizon engine on the stock OMP loop

The engine is an extension plugin (ADR-0001). It never replaces a stage of OMP's agent loop; it attaches to documented hooks (dotted edges) and registers two tools, `ledger` and `verify`, which stay inactive until a Horizon Run needs them. Terms are defined in [CONTEXT.md](../CONTEXT.md). Outside a Horizon Run every hook is a no-op.

## Hook attachment

```mermaid
flowchart TD
  subgraph STOCK["Stock OMP agent loop (unchanged)"]
    U["User prompt"] --> IN["input"]
    IN --> BAS["before_agent_start<br/>(once per user prompt)"]
    BAS --> CTX["context<br/>(every LLM call)"]
    CTX --> LLM[("Provider call<br/>default role")]
    LLM --> AM["assistant_message"]
    AM -->|tool calls| TC["tool_call"]
    TC --> EX["execute tool"]
    EX --> TR["tool_result"]
    TR --> MC{"compaction<br/>threshold?"}
    MC -->|yes| SBC["session_before_compact<br/>then compaction"]
    MC -->|no| TE["turn_end"]
    SBC --> TE
    TE --> CTX
    AM -->|no tool calls| SS["session_stop<br/>(main session only)"]
    SS -->|allow| AE["agent_end / yield"]
    SS -->|"block + reason"| CTX
  end

  subgraph HZ["Horizon extension (this repo)"]
    START["/horizon start [skill] or --horizon<br/>bind Horizon Contract, pin Verifier dir"]
    INJ["Inject ledger + pacing header<br/>(ephemeral; read-only in subagents)"]
    GUARD["Block write/edit into pinned Verifier dir"]
    BRK["Failure Signature tracker<br/>trip: setActiveTools(read-only + ledger) + steer directive"]
    VRES["verify result: Best Checkpoint (hidden ref)<br/>or Regression steer"]
    SCHED["Extraction scheduler<br/>(every N action steps)"]
    UNLOCK["Unlock breaker after reflection<br/>(Graveyard written, max 2 calls)<br/>verify-due steer"]
    KICK["Kick Extraction catch-up<br/>(never blocks compaction)"]
    GATE["Stop gate: latest verify fresh + pinned + passed?<br/>N identical rejections: outcome blocked"]
    TOOLS["Registered tools: ledger, verify"]
  end

  START -.-> IN
  INJ -.-> CTX
  GUARD -.-> TC
  BRK -.-> TR
  VRES -.-> TR
  SCHED -.-> TR
  UNLOCK -.-> TE
  KICK -.-> SBC
  GATE -.-> SS
  TOOLS -.-> EX
```

## State and data flow

```mermaid
flowchart LR
  J[("Session journal<br/>(source of truth, per branch)")]

  subgraph LIVE["During a Horizon Run"]
    EXT["Extraction<br/>(background, watermark)"] -->|"omp -p --model @smol (ADR-0004)"| SMOL[("smol role")]
    SMOL -->|"ops: add / supersede / set_frontier"| MERGE["Deterministic merge"]
    LT["ledger tool (main agent)"] -->|ops| MERGE
    MERGE -->|"appendEntry ledger revision"| J
    J -->|"new entries past watermark"| EXT
    J -->|"latest revision, render budget"| INJ2["context injection"]
    VT["verify tool"] -->|"hash check"| VD[["Pinned Verifier dir"]]
    VD -->|"criteria JSON or Invalid Result"| VT
    VT -->|"result entry"| J
    VT -->|"strict superset of best"| REF[("git refs/omp-horizon/run/n<br/>or checkpoint_cmd")]
  end

  J --> RED["Redaction (Ledger Export)"]
  RED --> MIRROR[".omp/WORKING_MEMORY.md (read-only)"]

  subgraph POST["After the run (offline)"]
    PARSE["Trace parser<br/>action steps, Failure Signatures, Churn Windows"] --> REFL["Reflection model"]
    REFL --> RED2["Redaction"]
    RED2 --> P1["SKILL.md patch"]
    RED2 --> P2["horizon.yml patch"]
    RED2 --> P3["SECURITY-CONTEXT.md patch"]
  end
  J --> PARSE
```

## Stock OMP vs Horizon Run

| Concern | Stock OMP | Horizon Run |
|---|---|---|
| Memory across compaction | Summary compaction, or experimental notes mode (model-maintained `context_notes`) | Harness-extracted Working Memory Ledger in the journal, injected on every LLM call |
| Tool thrashing | Nothing deterministic (advisor is optional, advisory) | Circuit Breaker keyed on Failure Signature; tools locked for one reflection call |
| Completion | Model decides; `session_stop` has no handlers by default | Stop gate on a fresh, pinned, passing Verifier result; `blocked` outcome on stall |
| Workspace/environment state | None (`checkpoint`/`rewind` are conversation-only) | Best Checkpoint as hidden git ref or `checkpoint_cmd`; Regression alerts |
| Pacing | Goal mode token/time accounting (interactive only) | Ephemeral pacing header: LLM calls, elapsed, context %, Verifier state, Best Checkpoint |
| Learning across runs | Experimental autolearn | trace-reflect: Churn Windows to reviewable, redacted patches split by scope |
| Model routing | Unchanged | Unchanged: no `setModel` calls (ADR-0003 covers interplay with the pre-flight router) |

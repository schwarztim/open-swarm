# Open Swarm — Architecture Document

> **Author:** Tim Schwarz  
> **Version:** 1.0 — February 2026  
> **Status:** Living document — updated as the system evolves

---

## 1. Vision

Open Swarm is a **three-tiered AI agent orchestration system** that breaks complex software engineering tasks into scoped, parallel workstreams while keeping each agent's context window as small as possible.

The core insight: **you want to break out all functions while keeping the context window as short as possible.** Managers coordinate scope boundaries. Workers execute within narrow scopes. The orchestrator maintains the big picture without drowning in implementation details.

The system is designed to:
- **Scale horizontally** — spin up as many agents as the task demands
- **Keep context windows small** — each agent only sees what it needs
- **Enable structured communication** — agents talk through a shared board, not shared context
- **Support adversarial quality** — debates and critiques catch errors that collaborative consensus misses
- **Run on commodity APIs** — built to work through GitHub Copilot's API via OpenCode

---

## 2. Three-Tier Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│                        L1 — ORCHESTRATOR                        │
│                                                                 │
│  • Owns the strategic goal                                      │
│  • Selects tier, assigns phases, manages lifecycle               │
│  • Reads ALL board messages                                     │
│  • Resolves L2 escalations and inter-manager debates            │
│  • Calls: swarm_init, swarm_next, swarm_dispatch, swarm_submit, │
│           swarm_gate, swarm_merge, swarm_status, swarm_throttle,│
│           swarm_relay, swarm_board, swarm_debate                │
│                                                                 │
│  Agent: @swarm (primary agent in OpenCode)                      │
│  Model: claude-opus-4.6                                         │
└────────┬────────────────────────┬───────────────────────┬───────┘
         │                        │                       │
    ┌────▼────┐             ┌────▼────┐             ┌────▼────┐
    │L2 MGR-0 │◄───board───►│L2 MGR-1 │◄───board───►│L2 MGR-N │
    │(Anthr.) │             │(OpenAI) │             │(Google) │
    └────┬────┘             └────┬────┘             └────┬────┘
         │                        │                       │
    ┌────▼────┐             ┌────▼────┐             ┌────▼────┐
    │L3 wkr-0 │             │L3 wkr-2 │             │L3 wkr-4 │
    │L3 wkr-1 │             │L3 wkr-3 │             │L3 wkr-5 │
    └─────────┘             └─────────┘             └─────────┘
```

### 2.1 L1 — Orchestrator

The **single top-level agent** that owns the entire task lifecycle. It never writes code directly. Its job is to:

1. Initialize the swarm (`swarm_init`) — selecting tier, concurrency, and phases
2. Step through phases (`swarm_next`) — getting the next action from the MCP server
3. Dispatch L2 managers (`swarm_dispatch` → `task()`) with full context
4. Merge parallel outputs (`swarm_merge`) when phases complete
5. Run quality gates (`swarm_gate`) — pass/fail with retry
6. Read the board for L2 escalations and resolve them
7. Trigger L1-level debates when managers disagree
8. Submit final outputs (`swarm_submit`) and advance phases

### 2.2 L2 — Managers

**Scope coordinators** that own a group of workers. Each manager:

1. Receives a scoped assignment from L1 (e.g., "implement backend group-0")
2. Plans how to split work across their L3 workers
3. Posts their plan to the board (so other managers can see it)
4. Dispatches workers in staggered batches (rate-limit aware)
5. Polls the board between batches for:
   - Worker questions/blockers (L3 → L2)
   - Cross-team findings from other managers (L2 ↔ L2)
   - Boss directives (L1 → L2)
6. Resolves worker conflicts — or escalates to L1 via blocker
7. Triggers L2-level debates for worker disagreements
8. Synthesizes worker outputs into a final report
9. Posts the report to the board for L1

**Agents:** `@manager-anthropic`, `@manager-openai`, `@manager-gemini`

### 2.3 L3 — Workers

**Narrow-scope executors** that do the actual work. Each worker:

1. Receives a specific, scoped task from their manager (via `task()` prompt)
2. Reads the board for manager directives before starting
3. Executes the task (code, test, review, etc.)
4. Posts findings/status to the board during work
5. Posts blockers if stuck — never guesses
6. Returns output to their manager

**Agents:** `@worker-coder`, `@worker-tester`, `@worker-security`, `@worker-architect`, `@worker-documenter`, `@worker-debugger`, plus provider-specific variants (`@worker-anthropic`, `@worker-openai`, `@worker-gemini`, `@worker-haiku`)

---

## 3. Communication Rules

The communication topology is the **most critical architectural constraint**. It ensures context isolation while enabling coordination.

```
L1 ↔ L2   Orchestrator talks to managers (and vice versa) via the board     ✅
L2 ↔ L2   Managers talk to each other via the board                         ✅
L2 → L3   Managers direct workers via task() prompts                        ✅
L3 → L2   Workers report to their manager via the board                     ✅
L3 ✗ L3   Workers NEVER talk directly to other workers                      🚫
```

### Why Workers Can't Talk to Workers

If workers communicated directly, every worker would need to understand every other worker's context. This would:
- Blow up context windows
- Create coordination chaos (N² communication paths)
- Bypass the manager's ability to maintain coherence

All worker-to-worker coordination goes **through the manager**. The manager reads worker board posts, makes decisions, and injects those decisions into subsequent worker prompts. This keeps the manager as the single source of truth for their scope.

### 3.1 The Board — Primary Communication Channel

All inter-agent communication flows through a **shared message board** stored in the MCP server's memory.

**Posting** (via `swarm_relay`):
```
swarm_relay(
  sessionId,
  workstream="group-0",     // who's posting
  level="L2",               // hierarchy level
  group="group-0",          // agent group
  type="finding|blocker|decision|status|plan|report",
  content="message"
)
```

**Reading** (via `swarm_board`):
```
swarm_board(sessionId)                          // Everything
swarm_board(sessionId, level="L2")              // Other managers' posts
swarm_board(sessionId, level="L3", group="g0")  // Your workers' posts
swarm_board(sessionId, level="L1")              // Boss directives
```

### 3.2 Message Types

| Type | Purpose | Posted By |
|------|---------|-----------|
| `plan` | Manager's work breakdown before dispatching workers | L2 |
| `finding` | Discovery that other agents should know about | L2, L3 |
| `status` | Progress update | L2, L3 |
| `blocker` | Something blocking work — needs resolution from above | L2, L3 |
| `decision` | Resolution of a question or blocker | L1, L2 |
| `report` | Final synthesized output from a phase | L2 |

### 3.3 Communication Flow Example

```
L1: Dispatches manager-anthropic (group-0) and manager-openai (group-1) in parallel

group-0 manager posts:        plan → "Splitting backend into 2 workers: API + DB"
group-1 manager posts:        plan → "Splitting frontend into 2 workers: components + pages"

group-0 worker-0 posts:       finding → "API endpoints need auth middleware"
group-0 manager reads:        swarm_board(level="L3", group="group-0")
group-0 manager posts:        decision → "RE: auth middleware — yes, add JWT validation"
group-1 manager reads:        swarm_board(level="L2")  ← sees group-0's auth finding
group-1 manager adjusts:      tells frontend workers to add auth headers

group-0 worker-1 posts:       blocker → "DB schema conflicts with worker-0's API changes"
group-0 manager reads:        can't resolve → escalates
group-0 manager posts:        blocker → "ESCALATION: DB schema vs API contract mismatch"
L1 reads board:               sees the blocker, makes decision
L1 posts:                     decision → "Use API contract as source of truth, adjust schema"
```

---

## 4. Debate System

When agents disagree and the disagreement can't be resolved by the immediate supervisor, the system supports **structured adversarial debates**.

### 4.1 When Debates Trigger

| Trigger | Level | Description |
|---------|-------|-------------|
| `disagreement` | L2 | Workers within a group produce conflicting outputs |
| `quality-split` | L2 | Quality scores diverge significantly (>3 point gap) |
| `explicit` | L1 or L2 | Supervisor explicitly requests a debate |
| `l1-directive` | L1 | Orchestrator forces debate between managers |

### 4.2 Debate Protocol

Debates follow a multi-round **position → critique → rebuttal** cycle:

```
Round 1:
  1. POSITION  — Each debater states their approach (parallel)
  2. CRITIQUE  — Each debater critiques the others (parallel)
  3. REBUTTAL  — Each debater defends against critiques (parallel)
  4. EVALUATE  — Score convergence, check for sycophancy, fast-track

If converged → SYNTHESIZE (merge into final decision)
If stalled   → ESCALATE to parent level
If max rounds reached → forced ESCALATION
```

### 4.3 Anti-Sycophancy

The debate system detects when debaters simply agree with each other instead of providing genuine critique. If sycophancy is detected, a **contrarian (devil's advocate)** is assigned to force rigorous challenge.

### 4.4 Post-Implementation Validation

After a debate's decision is implemented, a **validation checkpoint** verifies the outcome:
- `confirmed` — implementation matches decision, debate closed
- `partial` — partially implemented, debate continues
- `failed` — implementation contradicts decision, debate reopened with findings

### 4.5 Debate Hierarchy

```
L1 Debates:  Between L2 managers — L1 orchestrator synthesizes
L2 Debates:  Between L3 workers within a group — L2 manager synthesizes
```

If an L2 debate stalls, it **escalates to L1** with full context via `swarm_relay(type="blocker")`.

---

## 5. Swarm Lifecycle — Phases

Every swarm run progresses through a series of **phases** determined by the selected tier.

### 5.1 Tiers

| Tier | Phases | Agents | Use Case |
|------|--------|--------|----------|
| `duo` | 3 | 2 | Quick fixes, small changes |
| `trio` | 5 | 3 | Medium features, refactoring |
| `full-swarm` | 10 | 6-15 | Complex features, multi-file changes |
| `blitz` | 11 | 8-20 | Large-scale overhauls, full app rewrites |
| `debate` | 5 | 4+ | Design decisions, architecture choices |
| `unleashed` | 11 | 10-30+ | Maximum scale, no restraints |

### 5.2 Full-Swarm Phase Progression (most common)

```
Phase 0: EXPLORE      → Parallel explore agents scan the codebase
Phase 1: MERGE_EXPLORE → Merge exploration outputs into unified understanding
Phase 2: DESIGN       → Architect agent creates implementation plan
Phase 3: IMPLEMENT    → Parallel L2 managers dispatch L3 workers
Phase 4: MERGE_IMPL   → Merge implementation outputs
Phase 5: REVIEW       → Parallel code review agents critique changes
Phase 6: GATE         → Quality gate — pass (≥7/10) or retry
Phase 7: INTEGRATION  → Integration testing across workstreams
Phase 8: VALIDATE     → Final validation
Phase 9: SYNTHESIZE   → Architect produces final summary
```

### 5.3 Phase Types

| Property | Description |
|----------|-------------|
| `parallel` | Multiple agents run simultaneously (explore, implement, review) |
| `sync` | Single agent runs sequentially (design, merge, gate) |
| `background` | Agents launched as background tasks (parallel phases) |
| `isGate` | Quality gate — must score ≥7/10 to pass, retries on failure |

---

## 6. Rate Limiting & Model Management

### 6.1 The Problem

GitHub Copilot's API has per-model rate limits. Spawning 15 agents simultaneously would instantly hit limits and cascade failures.

### 6.2 Model Tiers & Limits

| Tier | Models | RPM | Burst | Interval | Cost |
|------|--------|-----|-------|----------|------|
| **Premium** | Opus 4.6, Opus 4.5, Codex-Max, GPT-5.3-Codex | 2 | 2 | 30s | 3x |
| **Standard** | Gemini 3 Pro, GPT-5.2, Sonnet 4.6/4.5, GPT-5.2-Codex | 10 | 5 | 6s | 1x |
| **Fast** | Gemini 3 Flash, Haiku 4.5, Codex-Mini | 15 | 8 | 4s | 0.33x |

### 6.3 Token Bucket Rate Limiter

Each session maintains per-tier token buckets. When `swarm_dispatch` is called:
1. Resolve the requested model (with fallback if unavailable)
2. Check the rate limiter for that model's tier
3. If tokens available → consume one, return dispatch
4. If depleted → return `retryAfterSeconds` so the agent can sleep and retry

### 6.4 Concurrency Presets

Control how many L2 managers run simultaneously:

| Preset | Concurrency | Max Agents | Plan |
|--------|-------------|------------|------|
| `conservative` | 2 | 10 | Any (Free, Pro, Business, Enterprise) |
| `standard` | 3 | 15 | Business or Enterprise |
| `aggressive` | 5 | 25 | Enterprise |
| `max` | 8 | 40 | Enterprise (may hit limits) |
| `unlimited` | 999 | 999 | YOLO |

### 6.5 Model Fallback Chains

When a requested model is unavailable, the system walks a fallback chain ordered by **Code Arena score** (llm-stats.com):

```
claude-opus-4.6 (#1, 2011) → opus-4.5 (#3) → codex-max → gpt-5.3 → gemini-3-pro (#2) → gpt-5.2 (#4)
gemini-3-pro (#2, 1563)    → gpt-5.2 (#4) → gemini-3.1-pro (#5) → sonnet-4.6 (#9) → ...
claude-haiku-4.5           → gemini-3-flash (#7, 1510!) → codex-mini → gemini-3-pro
```

**Key principle:** Better models always take precedence. Fallback always moves toward the highest-scoring available model.

---

## 7. Agent Roster

### 7.1 L1 Agents

| Agent | Model | Role |
|-------|-------|------|
| `@swarm` | claude-opus-4.6 | Primary orchestrator — delegates everything, writes nothing |

### 7.2 L2 Agents (Managers)

| Agent | Model | Provider Affinity |
|-------|-------|------------------|
| `@manager-anthropic` | claude-sonnet-4.5 | Anthropic workers |
| `@manager-openai` | gpt-5.2-codex | OpenAI workers |
| `@manager-gemini` | gemini-3-pro-preview | Google workers |

### 7.3 L3 Agents (Workers)

| Agent | Model | Specialty |
|-------|-------|-----------|
| `@worker-coder` | claude-opus-4.6 | Implementation, refactoring |
| `@worker-tester` | claude-opus-4.6 | Unit/integration tests, coverage |
| `@worker-security` | claude-opus-4.6 | Vulnerability analysis, auth review |
| `@worker-architect` | claude-opus-4.6 | System design, API design |
| `@worker-documenter` | claude-haiku-4.5 | READMEs, API docs, changelogs |
| `@worker-debugger` | claude-opus-4.6 | Root cause analysis, log analysis |
| `@worker-anthropic` | claude-opus-4.6 | Provider-routed (Anthropic) |
| `@worker-openai` | gpt-5.2-codex | Provider-routed (OpenAI) |
| `@worker-gemini` | gemini-3-pro-preview | Provider-routed (Google) |
| `@worker-haiku` | claude-haiku-4.5 | Fast/merge tasks |

---

## 8. MCP Tools Reference

All orchestration state lives in the **Open Swarm MCP server** — an in-memory Node.js process communicating over stdio via the MCP protocol.

### 8.1 Lifecycle Tools

| Tool | Called By | Purpose |
|------|-----------|---------|
| `swarm_init` | L1 | Create a new swarm session |
| `swarm_next` | L1 | Get the next phase action |
| `swarm_dispatch` | L1 | Resolve a prompt + model with rate limiting and fallback |
| `swarm_submit` | L1 | Submit phase output and advance |
| `swarm_merge` | L1 | Merge parallel outputs |
| `swarm_gate` | L1 | Evaluate quality gate scores |
| `swarm_status` | L1 | Check current swarm state |
| `swarm_collect` | L1 | Batch-collect subprocess outputs |
| `swarm_throttle` | L1 | Adjust rate limiting mid-session |
| `swarm_models` | L1 | List/set available models |

### 8.2 Communication Tools

| Tool | Called By | Purpose |
|------|-----------|---------|
| `swarm_relay` | L1, L2, L3 | Post a message to the shared board |
| `swarm_board` | L1, L2, L3 | Read messages from the shared board |

### 8.3 Coordination Tools

| Tool | Called By | Purpose |
|------|-----------|---------|
| `swarm_debate` | L1, L2 | Start/advance/evaluate structured debates |
| `swarm_claim` | L2, L3 | Claim file ownership to prevent edit conflicts |
| `swarm_memory` | L2, L3 | Store/search successful patterns from prior tasks |
| `swarm_consensus` | L2 | Lightweight worker consensus for complex decisions |

---

## 9. Runtime Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     GitHub Copilot API                                │
│                   (claude, gpt, gemini models)                       │
└─────────────────────────────┬────────────────────────────────────────┘
                              │ LLM requests
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         OpenCode                                     │
│                                                                      │
│  ┌──────────┐  task()  ┌──────────┐  task()  ┌──────────┐           │
│  │ @swarm   │────────►│@mgr-anth │────────►│@wkr-coder│           │
│  │   (L1)   │         │   (L2)   │         │   (L3)   │           │
│  └────┬─────┘         └────┬─────┘         └────┬─────┘           │
│       │                     │                     │                  │
│       │  MCP stdio          │  MCP stdio          │  MCP stdio      │
│       ▼                     ▼                     ▼                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    MCPU (MCP Proxy)                           │   │
│  │              Routes tool calls to MCP servers                │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ stdio
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   Open Swarm MCP Server                              │
│                    (Node.js, in-memory)                               │
│                                                                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │  Sessions  │  │   Board    │  │   Debates  │  │ Rate Limiter │  │
│  │  (phases,  │  │ (messages, │  │ (rounds,   │  │ (token       │  │
│  │   groups,  │  │  levels,   │  │  positions,│  │  buckets,    │  │
│  │   claims)  │  │  filters)  │  │  consensus)│  │  fallback)   │  │
│  └────────────┘  └────────────┘  └────────────┘  └──────────────┘  │
│                                                                      │
│  Hosted by: ToolHive (thv) — container-managed MCP server            │
│  Port: 38546 (stdio bridge)                                          │
└──────────────────────────────────────────────────────────────────────┘
```

### 9.1 Key Architectural Decisions

1. **Board is in-memory, not file-based.** The MCP server holds all board state. This avoids file I/O contention and makes reads/writes instant. Trade-off: state is lost if the MCP server restarts.

2. **Communication is batch-async, not real-time.** Workers post to the board; managers poll between batches. There is no push notification. This is a structural limitation of OpenCode's `task()` model (fire-and-wait).

3. **Subagents require explicit MCP tool permissions.** OpenCode denies all tools not listed in a subagent's config. Every manager and worker must have `swarm_relay: true` and `swarm_board: true` in their tools config, or board communication silently fails.

4. **Context isolation is by design.** Each subagent gets its own context window. The only shared state is the board. This is a feature, not a limitation — it forces agents to communicate through structured channels.

---

## 10. Quality Gates

Quality gates are the **only hard checkpoint** in the swarm lifecycle. A phase marked `isGate: true` requires:

- All workstreams scored
- Every score ≥ 7/10
- Zero critical issues

If the gate fails:
1. The MCP server returns `retry: true` with specific feedback
2. The orchestrator re-dispatches failed workstreams
3. Up to `maxLoops` retries (default: 3)
4. If still failing after retries, the orchestrator must decide: force-proceed or abort

---

## 11. File Claim System

When multiple workers might edit the same file, the **claim system** prevents conflicts:

```
swarm_claim(action="claim", paths=["src/auth.ts"], workstreamId="ws-0")
  → { claimed: ["src/auth.ts"], conflicts: [] }

swarm_claim(action="claim", paths=["src/auth.ts"], workstreamId="ws-1")
  → { claimed: [], conflicts: [{ path: "src/auth.ts", owner: "ws-0" }] }
```

Workers must claim files before editing and release them when done. Managers should check claims when planning work distribution.

---

## 12. Pattern Memory

Successful patterns from prior tasks are stored and searchable:

```
swarm_memory(action="store", taskType="auth-implementation",
  approach="JWT with refresh tokens", qualityScore=9,
  tags=["auth", "jwt", "security"])

swarm_memory(action="search", query="authentication")
  → Returns similar patterns with approaches and quality scores
```

Only patterns with quality score ≥ 8 are stored. Workers should search for relevant patterns before starting work.

---

## 13. Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Batch-async communication | Workers can't interrupt managers in real-time | Managers poll board between worker batches |
| No concurrent L2↔L2 reaction | Managers running in parallel can't react to each other's posts until their batch completes | Staggered batches + board polling |
| Context window isolation | No shared memory beyond board + prompt | Board messages kept concise; prompts include relevant history |
| OpenCode streaming Zod errors | Cosmetic validation errors in terminal from Copilot API streaming | Does not affect functionality; OpenCode internal issue |
| Rate limits | Copilot API limits constrain parallelism | Token bucket rate limiter + staggered dispatch + model fallback |
| State is in-memory | MCP server restart loses all session state | Accepted trade-off for speed; persistence layer planned |

---

## 14. Design Principles

1. **Context is the scarcest resource.** Every architectural decision optimizes for keeping context windows small and focused.

2. **Communication goes through channels, not context.** Agents don't share memory — they communicate through the board protocol.

3. **Managers own coherence.** Workers execute. Managers ensure the pieces fit together. The orchestrator ensures the managers align with the goal.

4. **Adversarial quality beats collaborative consensus.** Debates, critiques, and quality gates catch errors that "looks good to me" reviews miss.

5. **Better models take precedence.** The fallback system always prefers higher-capability models. When in doubt, use the best model available.

6. **Fail loudly, not silently.** Workers post blockers instead of guessing. Managers escalate instead of making uninformed decisions. The system is designed to surface problems early.

---

## 15. Future Directions

- **Persistent state** — SQLite or Redis backing for session/board data to survive restarts
- **Real-time push notifications** — WebSocket or SSE channel for instant L3→L2 notification
- **Adaptive concurrency** — auto-tune rate limits based on observed API behavior
- **Cross-session learning** — pattern memory that persists across swarm runs
- **Visual dashboard** — real-time visualization of agent hierarchy, board messages, and phase progression
- **Multi-codebase orchestration** — coordinating swarms across multiple repositories

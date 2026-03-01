# Open Swarm — Architecture Document

> **Author:** Tim Schwarz  
> **Version:** 2.0 — February 2026  
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

**Agent:** `@manager-anthropic` (claude-sonnet-4.6)

### 2.3 L3 — Workers

**Narrow-scope executors** that do the actual work. Each worker:

1. Receives a specific, scoped task from their manager (via `task()` prompt)
2. Reads the board for manager directives before starting
3. Executes the task (code, test, review, etc.)
4. Posts findings/status to the board during work
5. Posts blockers if stuck — never guesses
6. Returns output to their manager

**Agents:** See §7 for the full 15-agent roster.

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

All worker-to-worker coordination goes **through the manager**. The manager reads worker board posts, makes decisions, and injects those decisions into subsequent worker prompts.

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
L1: Dispatches manager-anthropic (group-0) in parallel

group-0 manager posts:        plan → "Splitting backend into 2 workers: API + DB"

group-0 worker-0 posts:       finding → "API endpoints need auth middleware"
group-0 manager reads:        swarm_board(level="L3", group="group-0")
group-0 manager posts:        decision → "RE: auth middleware — yes, add JWT validation"

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

Detection signals:
- Rebuttal collapse (rebuttals <30% length of positions)
- Hollow agreement (agreement markers without substantive reasoning)
- Soft critiques (3:1 ratio of hedging vs substantive critique markers)
- Position mimicry (positions copying each other's prior content)
- Minimal defense ("Position unchanged" with <200 chars)

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

| Tier | Phases | Use Case |
|------|--------|----------|
| `duo` | 3 | Quick fixes, single-file changes |
| `trio` | 8 | Medium features, refactoring |
| `full-swarm` | 17 | Complex features, security-critical, multi-domain |
| `blitz` | 13 | Large-scale overhauls, 50+ file codebases |
| `debate` | 5 | Design decisions, architecture choices |
| `unleashed` | 18 | Maximum scale, no restraints (32 parallel agents) |

### 5.2 Phase Definitions per Tier

#### `duo` (3 phases)

| # | Phase | Agent Type | Mode | Notes |
|---|-------|-----------|------|-------|
| 0 | `implement` | clean-code | sync | Implementation |
| 1 | `review` | code-review | sync | Quality critique |
| 2 | `gate` | task | sync | **Quality gate** (≥7/10) |

#### `trio` (8 phases)

| # | Phase | Agent Type | Mode | Notes |
|---|-------|-----------|------|-------|
| 0 | `design` | architect | sync | High-level planning |
| 1 | `architect` | worker-architect | sync | Detailed design |
| 2 | `implement` | clean-code | sync | Implementation |
| 3 | `review` | code-review | sync | Quality critique |
| 4 | `gate` | task | sync | **Quality gate** (≥7/10) |
| 5 | `validate-static` | task | sync | Static validation |
| 6 | `validate-integration` | task | background/parallel | Integration tests |
| 7 | `validate-gate` | task | sync | **Validation gate** |

#### `full-swarm` (17 phases)

| # | Phase | Agent Type | Mode | Notes |
|---|-------|-----------|------|-------|
| 0 | `explore` | explore | background/parallel | Codebase recon |
| 1 | `merge_explore` | general-purpose | sync | Merge findings |
| 2 | `architect` | worker-architect | sync | Detailed design |
| 3 | `design` | architect | sync | System planning |
| 4 | `implement` | clean-code | background/parallel | Parallel coding |
| 5 | `security` | worker-security | background/parallel | Security audit (auto-invoked) |
| 6 | `merge_impl` | general-purpose | sync | Merge implementations |
| 7 | `integration` | worker-integration | background/parallel | Frontend-backend wiring |
| 8 | `merge_integration` | general-purpose | sync | Merge integration work |
| 9 | `review` | code-review | background/parallel | Parallel code review |
| 10 | `gate` | task | sync | **Quality gate** (≥7/10) |
| 11 | `validate-static` | task | sync | Static analysis |
| 12 | `validate-integration` | task | background/parallel | Integration tests |
| 13 | `validate-gate` | task | sync | **Validation gate** |
| 14 | `document` | worker-documenter | background/parallel | Auto-documentation |
| 15 | `devops` | worker-devops | sync | CI/CD, containers |
| 16 | `synthesize` | architect | sync | Final summary |

> **Note:** `full-swarm` is 17 phases (0–16). The security and integration phases are automatically inserted — no manual configuration required.

#### `blitz` (13 phases)

| # | Phase | Agent Type | Mode |
|---|-------|-----------|------|
| 0 | `recon` | explore | background/parallel |
| 1 | `merge_recon` | general-purpose | sync |
| 2 | `triage` | architect | sync |
| 3 | `architect` | worker-architect | sync |
| 4 | `build` | clean-code | background/parallel |
| 5 | `merge_build` | general-purpose | sync |
| 6 | `review` | code-review | background/parallel |
| 7 | `merge_review` | general-purpose | sync |
| 8 | `gate` | task | sync |
| 9 | `validate-static` | task | sync |
| 10 | `validate-integration` | task | background/parallel |
| 11 | `validate-gate` | task | sync |
| 12 | `synthesize` | architect | sync |

#### `debate` (5 phases)

| # | Phase | Agent Type | Mode |
|---|-------|-----------|------|
| 0 | `propose` | architect | background/parallel |
| 1 | `critique` | code-review | background/parallel |
| 2 | `rebuttal` | architect | background/parallel |
| 3 | `merge_debate` | general-purpose | sync |
| 4 | `synthesize` | architect | sync |

#### `unleashed` (18 phases)

Identical to `full-swarm` plus `security`, `integration`, `document`, `devops` phases, with separate `merge_review` and 32-agent parallel execution. Uses subprocess execution mode for true OS-level parallelism.

### 5.3 Phase Types

| Property | Description |
|----------|-------------|
| `parallel` | Multiple agents run simultaneously (explore, implement, review) |
| `sync` | Single agent runs sequentially (design, merge, gate) |
| `background` | Agents launched as background tasks (parallel phases) |
| `isGate` | Quality gate — must score ≥7/10 to pass, retries on failure |
| `isValidationGate` | Post-implementation validation gate |
| `requiresMerge` | Phase output must be merged before advancing |

### 5.4 Tier Auto-Selection

`swarm_init` can auto-select a tier based on task analysis. The `analyzeTaskComplexity()` function scans the task description for signals:

| Signal | Keywords |
|--------|----------|
| architect | architect, design, system, microservice, scale |
| database | database, schema, migration, prisma, drizzle, postgres, sql |
| auth | auth, jwt, rbac, oauth, login, session |
| integration | frontend, backend, api, react, next, full-stack |
| devops | deploy, docker, kubernetes, ci/cd, terraform |
| testing | test, coverage, e2e, integration-test |

**Selection rule:** ≥4 signals → `full-swarm`, ≥2 signals → `trio`, otherwise → `duo`. Explicit `fileCount > 50` → `blitz`. Keywords like `unleashed`/`debate` override auto-selection.

---

## 6. Rate Limiting & Model Management

### 6.1 The Problem

GitHub Copilot's API has per-model rate limits. Spawning many agents simultaneously would instantly hit limits and cascade failures.

### 6.2 Model Tiers & Limits

| Tier | Models | RPM | Burst | Interval | Cost Multiplier |
|------|--------|-----|-------|----------|-----------------|
| **Premium** | claude-opus-4.6, gemini-2.5-pro | 2 | 2 | 30s | 3× |
| **Standard** | claude-sonnet-4.6, gpt-4.1, gpt-4o, gemini-2.5-pro | 10 | 5 | 6s | 1× |
| **Fast** | claude-haiku-4.5, o4-mini, gemini-2.5-flash | 15 | 8 | 4s | 0.33× |

### 6.3 Token Bucket Rate Limiter

Each session maintains per-tier token buckets. When `swarm_dispatch` is called:
1. Resolve the requested model (with fallback if unavailable)
2. Check the rate limiter for that model's tier
3. If tokens available → consume one, dispatch
4. If depleted → return `retryAfterMs` so the agent can sleep and retry

### 6.4 Concurrency Presets

| Preset | Concurrency | Max Agents | Plan |
|--------|-------------|------------|------|
| `conservative` | 2 | 10 | Any (Free, Pro, Business, Enterprise) |
| `standard` | 3 | 15 | Business or Enterprise |
| `aggressive` | 4 | 20 | Enterprise |
| `max` | 8 | 40 | Enterprise (may hit limits) |
| `unlimited` | 0 | ∞ | YOLO |

### 6.5 Model Registry

The model registry (`model-registry.ts`) maintains four **role-based pools** rebuilt dynamically from available models:

| Pool | Purpose | Default Models |
|------|---------|---------------|
| `premiumPool` | Architect, synthesizer | claude-opus-4.6, gemini-2.5-pro |
| `coderPool` | Implementation workers | claude-sonnet-4.6, gpt-4.1, gpt-4o (interleaved by provider) |
| `criticPool` | Code review, security | Alternating standard-tier models |
| `fastPool` | Explore, merge | claude-haiku-4.5, o4-mini, gemini-2.5-flash |

### 6.6 Model Fallback Chains

When a requested model is unavailable, the resolver walks (in order):
1. **Explicit fallback chain** (e.g., `claude-opus-4.6` → `claude-sonnet-4.6`)
2. **Same tier + same provider**
3. **Same tier, any provider**
4. **Any available model** (last resort)

Additionally, **model upgrades** are applied automatically: if `claude-sonnet-4.5` is requested but `claude-sonnet-4.6` is available, the newer model is used.

---

## 7. Agent Roster

### 7.1 L1 Agents

| Agent | Model | Role |
|-------|-------|------|
| `@swarm` | claude-opus-4.6 | Primary orchestrator — delegates everything, writes nothing |

### 7.2 L2 Agents (Managers)

| Agent | Model | Role |
|-------|-------|------|
| `@manager-anthropic` | claude-sonnet-4.6 | L2 manager — coordinates workers, synthesizes reports |

> Additional manager variants (`@manager-openai`, `@manager-gemini`) may be defined globally; the system routes by provider affinity from `swarm_dispatch`.

### 7.3 L3 Agents (Workers) — 15 total

| Agent | Model | Specialty |
|-------|-------|-----------|
| `@worker-coder` | claude-opus-4.6 | Implementation, refactoring, feature development |
| `@worker-tester` | claude-opus-4.6 | Unit/integration tests, coverage |
| `@worker-security` | claude-opus-4.6 | Vulnerability analysis, auth review, dependency audit |
| `@worker-architect` | claude-opus-4.6 | System design, component structure, API design |
| `@worker-documenter` | claude-haiku-4.5 | READMEs, API docs, guides, changelogs |
| `@worker-debugger` | claude-opus-4.6 | Root cause analysis, stack traces, log analysis |
| `@worker-integration` | claude-sonnet-4.6 | API clients, React Query hooks, frontend-backend wiring |
| `@worker-database` | claude-sonnet-4.6 | Schema design (Prisma/Drizzle), migrations, query optimization |
| `@worker-devops` | claude-sonnet-4.6 | CI/CD pipelines, Docker, K8s manifests, IaC |
| `@worker-auth` | claude-sonnet-4.6 | JWT, RBAC, OAuth2/OIDC, session management |
| `@worker-anthropic` | claude-opus-4.6 | Provider-routed (Anthropic) |
| `@worker-openai` | *(global config)* | Provider-routed (OpenAI) |
| `@worker-gemini` | *(global config)* | Provider-routed (Google) |
| `@worker-haiku` | claude-haiku-4.5 | Fast/merge tasks, lightweight analysis |
| `@worker` | claude-opus-4.6 | Default fallback worker |

### 7.4 WorkerRole Types

The `WorkerRole` type enumerates all valid roles for task classification and routing:

```
coder | tester | reviewer | security | architect | documenter |
debugger | devops | integration | database | auth | meta-worker
```

---

## 8. MCP Tools Reference

All orchestration state lives in the **Open Swarm MCP server** — a Node.js process communicating via the MCP protocol.

### 8.1 Lifecycle Tools

| Tool | Handler File | Called By | Purpose |
|------|-------------|-----------|---------|
| `swarm_init` | `tools/init.ts` | L1 | Create a new swarm session |
| `swarm_next` | `tools/lifecycle.ts` | L1 | Get the next phase action |
| `swarm_submit` | `tools/lifecycle.ts` | L1 | Submit phase output and advance |
| `swarm_status` | `tools/lifecycle.ts` | L1 | Check current swarm state |
| `swarm_dispatch` | `tools/dispatch.ts` | L1 | Resolve a prompt + model with rate limiting |
| `swarm_collect` | `tools/dispatch.ts` | L1 | Batch-collect subprocess outputs |
| `swarm_worker` | `tools/dispatch.ts` | L1 | Dispatch/status/results for background workers |
| `swarm_gate` | `tools/gate.ts` | L1 | Evaluate quality gate scores |
| `swarm_merge` | `tools/gate.ts` | L1 | Merge parallel outputs with convergence guidance |
| `swarm_validate` | `tools/gate.ts` | L1 | Run acceptance test validation |

### 8.2 Communication Tools

| Tool | Handler File | Called By | Purpose |
|------|-------------|-----------|---------|
| `swarm_relay` | `tools/communication.ts` | L1, L2, L3 | Post a message to the shared board |
| `swarm_board` | `tools/communication.ts` | L1, L2, L3 | Read messages from the shared board |
| `swarm_debate` | `tools/communication.ts` | L1, L2 | Start/advance/evaluate structured debates |

### 8.3 Coordination Tools

| Tool | Handler File | Called By | Purpose |
|------|-------------|-----------|---------|
| `swarm_consensus` | `tools/consensus.ts` | L2 | Lightweight worker consensus for complex decisions |
| `swarm_claim` | `tools/claim.ts` | L2, L3 | Claim file ownership to prevent edit conflicts |
| `swarm_memory` | `tools/intelligence.ts` | L2, L3 | Store/search successful patterns |
| `swarm_learn` | `tools/intelligence.ts` | L1 | Self-learning: retrieve/judge/distill/consolidate/route |
| `swarm_watch` | `tools/intelligence.ts` | L1 | Subscribe background workers to trigger events |
| `swarm_throttle` | `tools/throttle.ts` | L1 | Adjust rate limiting mid-session |
| `swarm_models` | `tools/throttle.ts` | L1 | List/set available models |

---

## 9. Codebase Structure

### 9.1 MCP Server Source Layout

```
mcp-server/src/
├── index.ts              Entry point — registers all MCP tools
├── state.ts              Barrel re-export (maintains backward compatibility)
├── tools.ts              Barrel re-export for tools
│
├── swarm-types.ts        All type definitions (Tier, WorkerRole, SessionState, etc.)
├── model-registry.ts     Model resolution, pools, fallback chains, upgrades
├── rate-limiter.ts       Token bucket rate limiting, concurrency presets
├── phase-engine.ts       Phase definitions per tier, phase transition validation
├── session.ts            Session lifecycle (create, get, destroy, cleanup)
├── board.ts              Inter-agent message board (post, read, filter, anonymize)
├── prompt-builder.ts     L2 manager prompt construction, anonymous history
├── hierarchy.ts          Tier selection, workstream grouping, task complexity
│                         analysis, drift detection, consensus protocol
├── debate.ts             Structured debate protocol (rounds, scoring, sycophancy)
├── file-claims.ts        File ownership tracking (claim, release, conflict check)
├── scoring.ts            Quality scoring dimensions, critic prompts, retry prompts
├── memory.ts             SQLite-backed pattern memory (better-sqlite3 + fallbacks)
├── embeddings.ts         384-dim ONNX embeddings (all-MiniLM-L6-v2) with LRU cache
├── vector-store.ts       HNSW-style nearest-neighbor semantic search
├── learning.ts           5-stage self-learning loop (retrieve/judge/distill/
│                         consolidate/route)
├── workers.ts            Background analysis workers (audit, optimize, testgaps,
│                         document)
│
└── tools/
    ├── index.ts          Barrel re-export for all tool handlers
    ├── shared.ts         Shared utilities (ok/err builders, validation helpers)
    ├── init.ts           swarm_init
    ├── lifecycle.ts      swarm_next, swarm_submit, swarm_status
    ├── dispatch.ts       swarm_dispatch, swarm_collect, swarm_worker
    ├── gate.ts           swarm_gate, swarm_merge, swarm_validate
    ├── communication.ts  swarm_relay, swarm_board, swarm_debate
    ├── consensus.ts      swarm_consensus
    ├── claim.ts          swarm_claim
    ├── intelligence.ts   swarm_memory, swarm_learn, swarm_watch
    └── throttle.ts       swarm_throttle, swarm_models
```

### 9.2 Agent Configuration Layout

```
opencode/
├── opencode.json         OpenCode agent registry (15 agents defined)
└── agents/
    ├── swarm.md          L1 orchestrator prompt
    ├── manager.md        L2 manager prompt (shared across all manager variants)
    ├── worker.md         Default fallback worker prompt
    ├── worker-coder.md
    ├── worker-tester.md
    ├── worker-security.md
    ├── worker-architect.md
    ├── worker-documenter.md
    ├── worker-debugger.md
    ├── worker-integration.md
    ├── worker-database.md
    ├── worker-devops.md
    ├── worker-auth.md
    ├── worker-anthropic.md
    └── worker-haiku.md
```

---

## 10. Runtime Architecture

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
│  │ @swarm   │────────►│@manager  │────────►│@wkr-coder│           │
│  │   (L1)   │         │   (L2)   │         │   (L3)   │           │
│  └────┬─────┘         └────┬─────┘         └────┬─────┘           │
│       │                     │                     │                  │
│       │  MCP tools          │  MCP tools          │  MCP tools      │
│       ▼                     ▼                     ▼                  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    MCPU (MCP Proxy)                           │   │
│  │              Routes tool calls to MCP servers                │   │
│  └──────────────────────────┬───────────────────────────────────┘   │
└─────────────────────────────┼───────────────────────────────────────┘
                              │ HTTP (port 38546)
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
│  ┌────────────┐  ┌────────────┐  ┌────────────────────────────────┐ │
│  │  Patterns  │  │ Embeddings │  │       Self-Learning Loop       │ │
│  │  (SQLite)  │  │  (ONNX)    │  │ retrieve→judge→distill→route  │ │
│  └────────────┘  └────────────┘  └────────────────────────────────┘ │
│                                                                      │
│  Endpoint: http://127.0.0.1:38546/mcp                                │
└──────────────────────────────────────────────────────────────────────┘
```

### 10.1 Key Architectural Decisions

1. **Board is in-memory, not file-based.** The MCP server holds all board state. This avoids file I/O contention and makes reads/writes instant. Trade-off: state is lost if the MCP server restarts.

2. **Communication is batch-async, not real-time.** Workers post to the board; managers poll between batches. There is no push notification. This is a structural limitation of OpenCode's `task()` model (fire-and-wait).

3. **Subagents require explicit MCP tool permissions.** OpenCode denies all tools not listed in a subagent's config. Managers and workers must have `swarm_relay: true` and `swarm_board: true` in their tools config, or board communication silently fails.

4. **Context isolation is by design.** Each subagent gets its own context window. The only shared state is the board. This is a feature, not a limitation — it forces agents to communicate through structured channels.

5. **`state.ts` is a backward-compatibility barrel.** The original monolithic `state.ts` (3600+ lines) was refactored into focused modules. `state.ts` now re-exports everything under the same public surface for zero-impact consumption by existing tool code.

---

## 11. Enterprise Features

### 11.1 Task Complexity Analysis

`swarm_init` automatically analyzes the task description to:
- Detect which domains are involved (auth, database, devops, integration, etc.)
- Select the appropriate tier if none was specified
- Estimate the number of workstreams needed
- Report which specialist worker types will be auto-invoked (`requiresAuth`, `requiresDatabase`, etc.)

### 11.2 Architecture-First Planning

For `trio`, `full-swarm`, and `blitz` tiers, an `architect` phase precedes implementation. The `worker-architect` agent produces a structured design document that the coder pool then receives as context. This prevents implementation-level architectural drift.

### 11.3 Security Auto-Invocation

In `full-swarm` and `unleashed` tiers, a `security` phase runs in **parallel with implementation** using `worker-security`. Security review is not a post-implementation afterthought — it runs concurrently so findings can feed back before the merge phase.

### 11.4 Quality Gate Scoring

The quality gate (`swarm_gate`) uses a **multi-dimension scoring system**:

| Dimension | Max | What It Measures |
|-----------|-----|-----------------|
| Evidence Quality | 3 | Code refs, data, concrete examples |
| Reasoning Clarity | 3 | Logical structure, causal chains |
| Rebuttal Effectiveness | 3 | Addressed critiques with new evidence |
| Novel Contribution | 2 | Unique insights not in other positions |

Gates require **all workstreams ≥ 7/10** with zero critical issues. Failed gates return `retry: true` with specific feedback and re-dispatch failed workstreams (up to `maxLoops: 3`).

The gate also **auto-invokes learning** (`judge` + `distill`) to record outcomes and extract reusable patterns for future sessions.

### 11.5 Session Cleanup & Memory Management

- `cleanupStaleSessions()` — removes sessions idle beyond a configurable TTL
- `destroySession()` — tears down a session and clears its rate limiters
- Pattern memory with `qualityScore ≥ 8` threshold — only high-quality patterns are stored
- `swarm_init` auto-retrieves relevant patterns via semantic search before dispatching any work
- SQLite + ONNX vector embeddings for persistent, cross-session pattern search

### 11.6 Anti-Drift Enforcement

Every `swarm_submit` call runs `checkDrift()` comparing output alignment against the original task assignment:

- Configurable threshold (default: 0.6 alignment score)
- Uses structural analysis: keyword overlap, length ratio, section matching
- On drift detection: submission rejected with feedback, worker retries with corrective guidance

---

## 12. Security

### 12.1 Session IDs

Session IDs are generated with `randomUUID()` from Node's built-in `crypto` module:
```typescript
function generateId(): string {
  return `swarm-${randomUUID()}`;
}
```
This replaces any sequential or timestamp-based ID generation, preventing session enumeration attacks.

### 12.2 Shell Injection Prevention

Subprocess mode uses `writeFileSync` to write prompts to temporary files rather than interpolating them into shell heredocs. This prevents injection via malicious task descriptions.

### 12.3 Input Validation

All tool handlers validate required string parameters via a shared `validateString()` utility before processing. Invalid inputs return structured error responses rather than throwing.

### 12.4 Error Boundaries

Tool handlers catch errors at boundaries and return structured `{ok: false, error: "..."}` responses. Errors do not propagate as unhandled exceptions that could crash the MCP server.

### 12.5 Rate Limiting

Token bucket rate limiting is applied per-session per-model-tier, preventing runaway agent spawning from exhausting API quotas and incurring unexpected costs.

---

## 13. Quality Gates

Quality gates are the **only hard checkpoint** in the swarm lifecycle. A phase marked `isGate: true` requires:

- All workstreams scored
- Every score ≥ 7/10
- Zero critical issues

If the gate fails:
1. The MCP server returns `retry: true` with specific feedback
2. The orchestrator re-dispatches failed workstreams
3. Up to `maxLoops` retries (default: 3)
4. If still failing after retries, the orchestrator must decide: force-proceed or abort

Validation gates (`isValidationGate: true`) additionally run acceptance tests parsed from the original task description.

---

## 14. File Claim System

When multiple workers might edit the same file, the **claim system** prevents conflicts:

```
swarm_claim(action="claim", paths=["src/auth.ts"], workstreamId="ws-0")
  → { claimed: ["src/auth.ts"], conflicts: [] }

swarm_claim(action="claim", paths=["src/auth.ts"], workstreamId="ws-1")
  → { claimed: [], conflicts: [{ path: "src/auth.ts", owner: "ws-0" }] }
```

Workers must claim files before editing and release them when done. Managers should check claims when planning work distribution.

---

## 15. Pattern Memory & Self-Learning

### 15.1 Storage Layer

Successful patterns are stored in SQLite (`data/swarm.db`) backed by `better-sqlite3`, with Node 22.5+ `node:sqlite` and in-memory fallbacks for environments without native bindings.

### 15.2 Semantic Search

Patterns are indexed using **384-dimensional vector embeddings** (all-MiniLM-L6-v2 ONNX model, `embeddings.ts`) with an LRU cache. `vector-store.ts` provides HNSW-style nearest-neighbor search for retrieving similar patterns by semantic content.

### 15.3 Self-Learning Loop (5 stages)

```
RETRIEVE  →  Semantic search for relevant prior patterns (on swarm_init)
JUDGE     →  Record outcome quality after gate evaluation (on swarm_gate)
DISTILL   →  Extract reusable patterns from score ≥8 sessions
CONSOLIDATE → Merge near-duplicates, decay unused, prune dead patterns
ROUTE     →  Recommend models/approaches based on past successes (on swarm_dispatch)
```

This loop is **auto-wired**:
- `swarm_init` calls `retrieve()` — prior patterns are injected into the first prompt
- `swarm_gate` calls `judge()` + `distill()` — quality is recorded after every gate
- `swarm_dispatch` calls `route()` — model selection uses past success data

### 15.4 Pattern Retention

Only patterns with `qualityScore ≥ 8` are stored. Patterns from prior sessions are auto-imported on startup (old `patterns.json` is migrated to SQLite and renamed `.migrated`).

---

## 16. Known Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| Batch-async communication | Workers can't interrupt managers in real-time | Managers poll board between worker batches |
| No concurrent L2↔L2 reaction | Managers running in parallel can't react to each other's posts until their batch completes | Staggered batches + board polling |
| Context window isolation | No shared memory beyond board + prompt | Board messages kept concise; prompts include relevant history |
| OpenCode streaming Zod errors | Cosmetic validation errors in terminal from Copilot API streaming | Does not affect functionality; OpenCode internal issue |
| Rate limits | Copilot API limits constrain parallelism | Token bucket rate limiter + staggered dispatch + model fallback |
| State is in-memory | MCP server restart loses all session/board state | Pattern memory persists in SQLite; board state is session-scoped |

---

## 17. Design Principles

1. **Context is the scarcest resource.** Every architectural decision optimizes for keeping context windows small and focused.

2. **Communication goes through channels, not context.** Agents don't share memory — they communicate through the board protocol.

3. **Managers own coherence.** Workers execute. Managers ensure the pieces fit together. The orchestrator ensures the managers align with the goal.

4. **Adversarial quality beats collaborative consensus.** Debates, critiques, and quality gates catch errors that "looks good to me" reviews miss.

5. **Better models take precedence.** The fallback system always prefers higher-capability models. When in doubt, use the best model available.

6. **Fail loudly, not silently.** Workers post blockers instead of guessing. Managers escalate instead of making uninformed decisions. The system is designed to surface problems early.

7. **Self-improvement across sessions.** Pattern memory and the learning loop create a feedback cycle — the system gets better at routing, model selection, and task decomposition over time.

---

## 18. Future Directions

- **Persistent board state** — Redis or SSE channel for board messages to survive restarts and enable real-time push
- **Adaptive concurrency** — auto-tune rate limits based on observed API behavior and remaining quota
- **Cross-session consensus** — pattern memory that grows from every completed swarm run
- **Visual dashboard** — real-time visualization of agent hierarchy, board messages, and phase progression
- **Multi-codebase orchestration** — coordinating swarms across multiple repositories
- **L2 manager diversity** — openai and gemini manager variants for cross-provider manager-level diversity

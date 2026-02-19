---
name: swarm-orchestrator
description: >-
  Multi-agent orchestration using cooperative dynamics from arXiv:2602.16301. Spawns diverse
  agent swarms via the task tool that adapt through anonymous interaction history and converge
  on optimal solutions via mutual shaping. Use when tasks span 3+ files, need design decisions,
  or benefit from competing perspectives. Invoke with /swarm-orchestrator or "swarm this".
license: MIT
metadata:
  author: Tim Schwarz
  version: "5.0"
  paper: "arXiv:2602.16301 — Wołczyk, Weis, Nasser et al. (2026)"
---

# Swarm Orchestrator

Multi-agent orchestration where cooperation **emerges** from diverse subagents adapting to
each other through anonymous interaction history — not from centralized control.

## When to Use

Suggest this skill when:
- Task spans **3+ files** or **2+ domains** (frontend + backend, code + tests + docs)
- User asks for a **design decision** with multiple valid approaches
- User says "debate", "explore options", "best approach", or "swarm this"
- A sub-agent **fails** — escalate to swarm for multi-perspective retry
- Task is **ambiguous** and benefits from competing perspectives

**DO NOT** use for: single-file edits, typo fixes, lookups, one-liner changes.

## Pre-Flight

Before launching a swarm:
1. **Enable fleet mode** — Run `/fleet` for parallel subagent execution
2. **For Full Swarm, Blitz, or Debate** — Use `/plan` first. Workflow: explore → plan → code → commit
3. **Check context** — Run `/context`. Each subagent gets its own window, so swarms are efficient.

## Invocation

- **Automatic:** Copilot auto-selects when it detects swarm-appropriate tasks
- **Explicit:** `/swarm-orchestrator`, "swarm this", "debate this"
- **Monitor:** `/tasks` to view running subagents

## Core Rules (violating ANY causes failure — from paper ablations §3.1)

1. **DIVERSE MODELS** — Same model = agreeable mediocre output. Use ≥2 different models.
   - Opus → deep reasoning (architect, synthesizer)
   - Sonnet → implementation (coder)
   - Codex → code review (critic from a different model family)
   - **Haiku → ALL explorers** (fast, cheap, read-only — ALWAYS specify `model="claude-haiku-4.5"`)
2. **ANONYMOUS HISTORY** — "A contributor found..." never "The Architect found..."
3. **FULL HISTORY** — Every agent gets complete prior rounds. Never truncate.
4. **CROSS-COMMUNICATION** — Agents must observe and react to each other's outputs.
   Parallel agents working in silos produces mediocre results. The paper's core mechanism
   (§3.2) is **mutual shaping**: agents read each other's work, adapt, and this pressure
   drives quality. Implement cross-communication where relevant:
   - **Parallel coders** → each prompt includes a summary of ALL other workstreams
   - **Review loop** → critic output feeds back to coders (NEVER skip this)
   - **Cross-workstream check** → after parallel builds, verify integration
   - **Debate** → each proposer reads and critiques the OTHER proposals

## Parallel Safety

| Mode | Agents | Why |
|------|--------|-----|
| `mode: "background"` | Explorers, critics, testers, debate proposers | Read-only, no file conflicts |
| `mode: "sync"` | Coders writing to **different** files/dirs | Parallel-safe if non-overlapping |
| Sequential | Coders writing to **same** files | File conflict risk |

Collect background results with `read_agent(agent_id=ID)`. Monitor with `/tasks`.

## Execution Tiers

Pick a tier, follow the steps. Each step is a `task()` call. Subagents run in their own context windows.

### Tier: Duo (2 agents, ~3 calls)
For: implementation + review, simple refactor.
```
1. task(agent_type="clean-code", description="Implement X", model="claude-sonnet-4.6",
     prompt="[task context]\n" + TASK_DESCRIPTION)
2. task(agent_type="code-review", description="Review X", model="gpt-5.2-codex",
     prompt="[anonymous history]\n" + CRITIC_PROMPT)
3. MANDATORY: If score < 7 → repeat step 1 with history + critique. Max 2 loops.
```

### Tier: Trio (3 agents, ~6 calls)
For: multi-file feature needing design + code + validation.
```
1. task(agent_type="architect", description="Design X", model="claude-opus-4.6",
     prompt="[task context]\n Design approach for: TASK")
2. task(agent_type="clean-code", description="Implement X", model="claude-sonnet-4.6",
     prompt="[anon history: design]\n Implement this design.")
3. task(agent_type="code-review", description="Review X", model="gpt-5.2-codex",
     prompt="[anon history: design + impl]\n" + CRITIC_PROMPT)
4. MANDATORY GATE: Score. If < 7 → step 2 with full history. Max 3 loops.
5. task(agent_type="task", description="Run tests", prompt="Run test suite. Report pass/fail.")
```

### Tier: Full Swarm (6+ agents, ~14 calls)
For: complex architecture, security-critical changes, major refactoring.
**Run `/plan` first.**
```
PHASE 1 — EXPLORE (all parallel, all background, all haiku)
   task(agent_type="explore", description="Map code structure", model="claude-haiku-4.5",
     mode="background", prompt=EXPLORER_PROMPT_A)
   task(agent_type="explore", description="Find patterns", model="claude-haiku-4.5",
     mode="background", prompt=EXPLORER_PROMPT_B)
   task(agent_type="explore", description="Check dependencies", model="claude-haiku-4.5",
     mode="background", prompt=EXPLORER_PROMPT_C)
   → Collect all with read_agent. Merge findings anonymously.

PHASE 2 — DESIGN (sync, opus)
   task(agent_type="architect", description="Design approach", model="claude-opus-4.6",
     prompt="[anon history: 3 explorer findings]\n Design approach for: TASK")

PHASE 3 — IMPLEMENT (parallel coders on non-overlapping workstreams)
   Split the design into independent workstreams by file/directory.
   CROSS-COMMUNICATION: Each coder's prompt includes a brief summary of ALL workstreams
   so they share patterns and avoid conflicts (anonymous — "Other workstreams in progress:").
   Launch each coder in parallel with a DIFFERENT model:
   task(agent_type="clean-code", description="Build workstream A", model="claude-sonnet-4.6",
     mode="background", prompt="[anon history]\n Other workstreams in progress:
     - {workstream_b_summary}\n - {workstream_c_summary}\n\n=== YOUR TASK ===\nImplement: {workstream_a}")
   task(agent_type="clean-code", description="Build workstream B", model="gpt-5.1-codex",
     mode="background", prompt="[anon history]\n Other workstreams in progress:
     - {workstream_a_summary}\n - {workstream_c_summary}\n\n=== YOUR TASK ===\nImplement: {workstream_b}")
   task(agent_type="clean-code", description="Build workstream C", model="claude-sonnet-4.5",
     mode="background", prompt="[anon history]\n Other workstreams in progress:
     - {workstream_a_summary}\n - {workstream_b_summary}\n\n=== YOUR TASK ===\nImplement: {workstream_c}")
   → Collect all with read_agent.

PHASE 4 — REVIEW (MANDATORY — never skip. This is the mutual shaping mechanism from §3.2)
   task(agent_type="code-review", description="Review all changes", model="gpt-5.2-codex",
     prompt="[anon history: all findings + design + ALL implementations]\n" + CRITIC_PROMPT)
   GATE: Score each workstream. Any < 7 → feed critique back to ONLY that coder with
   full history including what OTHER coders built. This cross-awareness is critical.
   Max 3 loops per workstream.

PHASE 5 — CROSS-WORKSTREAM CHECK
   task(agent_type="code-review", description="Integration check", model="claude-sonnet-4.6",
     prompt="[anon: all workstream changes]\n Check for conflicts between workstreams:
     duplicated logic, broken imports, inconsistent patterns, shared state conflicts.")

PHASE 6 — VALIDATE
   task(agent_type="task", description="Run test suite", prompt="Run tests. Report pass/fail.")

PHASE 6 — SYNTHESIZE
   task(agent_type="general-purpose", description="Synthesize results", model="claude-opus-4.6",
     prompt="[full anon history]\n" + SYNTHESIZER_PROMPT)
```

### Tier: Blitz (10+ agents, ~20+ calls)
For: massive codebases, full-app rewires, multi-domain overhauls (50+ files).
**Run `/plan` first. This is the highest-throughput tier.**
```
PHASE 1 — RECON (5 parallel explorers, all haiku, all background)
   Launch 5 explorers with orthogonal focus areas:
   - Structure mapper: directory tree, entry points, startup flow
   - Pattern finder: existing conventions, coding patterns, shared utilities
   - Dependency tracer: imports, cross-module references, circular deps
   - Gap hunter: stubs, TODOs, dead code, unregistered routes, missing tests
   - Domain analyst: business logic, data models, API contracts
   Each uses model="claude-haiku-4.5", mode="background".
   → Collect all. Merge into single anonymous findings document.

PHASE 2 — TRIAGE (sync, opus)
   task(agent_type="architect", description="Triage and design", model="claude-opus-4.6",
     prompt="[anon: 5 explorer findings]\n Produce a prioritized fix plan. Group changes into
     independent workstreams that can be coded in parallel. For each workstream: list exact
     files, changes needed, and acceptance criteria. Tag P0/P1/P2.")

PHASE 3 — PARALLEL BUILD (N coders, each on a non-overlapping workstream)
   Launch one coder per workstream. Rotate models across coders:
   - Workstream 1 → claude-sonnet-4.6
   - Workstream 2 → gpt-5.1-codex
   - Workstream 3 → claude-sonnet-4.5
   - Workstream 4 → gpt-5.2-codex
   - Workstream 5+ → cycle back through models
   All use mode="background" (safe: non-overlapping files).
   CROSS-COMMUNICATION: Each prompt includes the FULL design + summary of ALL other
   workstreams: "Other workstreams being built in parallel: {ws1: files X,Y doing Z},
   {ws2: files A,B doing C}...". This ensures shared patterns and avoids duplication.
   → Collect all with read_agent.

PHASE 4 — PARALLEL REVIEW (MANDATORY — this is the mutual shaping mechanism §3.2)
   Split workstreams across multiple critics running in parallel:
   task(agent_type="code-review", description="Review batch 1", model="gpt-5.2-codex",
     mode="background", prompt="[anon history + workstream 1-3 changes]\n" + CRITIC_PROMPT)
   task(agent_type="code-review", description="Review batch 2", model="claude-sonnet-4.6",
     mode="background", prompt="[anon history + workstream 4-5 changes]\n" + CRITIC_PROMPT)
   → Collect all. GATE: Any workstream < 7 → re-run ONLY that coder WITH:
     (a) the critique, (b) what OTHER coders built (cross-awareness), (c) full history.
   Max 3 loops.

PHASE 5 — INTEGRATION CHECK (cross-communication between all workstreams)
   task(agent_type="code-review", description="Cross-workstream review", model="claude-opus-4.6",
     prompt="[anon: ALL workstream changes + ALL review findings]\n Check for conflicts,
     duplicated logic, broken imports, inconsistent patterns across all workstreams.
     Verify the pieces fit together. This is the final gate.")

PHASE 6 — VALIDATE
   task(agent_type="task", description="Run full test suite", prompt="Run all tests. Report.")

PHASE 7 — SYNTHESIZE
   task(agent_type="general-purpose", description="Final synthesis", model="claude-opus-4.6",
     prompt="[full anon history]\n" + SYNTHESIZER_PROMPT)
```

### Tier: Debate (N+1 agents, ~3N+1 calls)
For: design decisions, architecture choices, ambiguous requirements.
**Run `/plan` first.**
```
1. Frame the question. Identify 2-3 approaches.
2. [PARALLEL] Each proposer argues one approach with a different model.
   task(agent_type="general-purpose", description="Propose A", model=MODEL_A, prompt=...)
   task(agent_type="general-purpose", description="Propose B", model=MODEL_B, prompt=...)
3. [PARALLEL] Each critiques the OTHER proposals (anonymous history)
4. [PARALLEL] Each rebuts critiques
5. task(agent_type="general-purpose", description="Synthesize debate", model="claude-opus-4.6",
     prompt="[full anon debate history]\n" + SYNTHESIZER_PROMPT)
```

## Anonymous History Format

Each subagent receives history from **its own perspective**, no identity labels.
The history IS the cross-communication channel (paper §2: "policies are conditioned on interaction history").

```
=== INTERACTION HISTORY ===

[Round 1 — Exploration]
OBSERVATION: A contributor mapped the codebase and found {findings}.
OBSERVATION: Another contributor independently found {other findings}.
OBSERVATION: A third contributor traced dependencies and found {dep findings}.

[Round 2 — Design]
OBSERVATION: A contributor designed an approach: {design summary}

[Round 3 — Implementation]
YOUR OUTPUT: {this agent's code changes}  ← only if this agent contributed
OBSERVATION: A contributor implemented {workstream_b changes}.
OBSERVATION: Another contributor implemented {workstream_c changes}.
↑ Cross-communication: each coder sees what others built

[Round 4 — Review]
CHALLENGE: A reviewer identified issues in your work:
  "Issue 1 (critical): {problem with evidence}"
  "Issue 2 (major): {problem with evidence}"
CHALLENGE: A reviewer found cross-workstream conflicts:
  "Workstream A and B both define {duplicate pattern}"
SCORES: Correctness 2/3, Responsiveness N/A, Constructiveness 1/2, Novelty 2/2 → 7/10

=== YOUR TASK (Round 5) ===
Address each challenge. You can reference patterns from other workstreams in the history.
```

**Key:** The history grows with each round. Later agents see MORE context than earlier ones.
This is the "in-context learning" from the paper — agents adapt based on accumulated observations.

## Quality Scoring — MANDATORY GATE (the shaping pressure from §3.2)

**NEVER SKIP THE REVIEW LOOP.** The paper proves (§3.2) that mutual shaping through
critique is what drives cooperation/quality. Without it, agents produce mediocre isolated work.

Score every critique. This creates the improvement pressure:

| Dimension | Range | Measures |
|-----------|-------|----------|
| Correctness | 0-3 | Solves the problem without bugs? |
| Responsiveness | 0-3 | Addressed prior challenges? |
| Constructiveness | 0-2 | Improved overall quality? |
| Novelty | 0-2 | Surfaced something others missed? |
| **Total** | **0-10** | |

**Converge:** ≥ 7 for ALL workstreams AND no critical issues → proceed.
**Diverge:** Any < 7 OR critical bugs → re-run ONLY failing workstreams with:
  (a) full critique, (b) other workstreams' outputs for cross-awareness, (c) full history.
**Max 3 loops.** If still failing after 3, synthesizer forces a decision.
**Never skip scoring.** If critic output lacks scores, request them explicitly.

Track per-session:
```sql
CREATE TABLE IF NOT EXISTS swarm_rounds (
    round INT, workstream TEXT, agent TEXT, model TEXT, score INT, critical_issues INT, output TEXT,
    PRIMARY KEY (round, workstream)
);
```

## Prompt Templates

Custom agents have rich built-in prompts. Only these swarm-specific roles need explicit templates:

**Explorer** (always `agent_type="explore"`, always `model="claude-haiku-4.5"`):
> Find and summarize relevant code, patterns, and context for: {TASK}.
> Focus on: {SPECIFIC_FOCUS_AREA}. Output structured findings with file paths and snippets.
> Do NOT propose solutions — just report what you find.

**Critic** (use with `agent_type="code-review"`):
> Review the implementation in the history below. Find REAL problems only — bugs, security
> issues, logic errors, edge cases. Do NOT comment on style. For each issue: state problem,
> show evidence, rate severity (critical/major/minor). Check for cross-workstream conflicts:
> duplicated logic, inconsistent patterns, broken integration points. REQUIRED: Score using
> Correctness 0-3, Responsiveness 0-3, Constructiveness 0-2, Novelty 0-2. Provide total /10.

**Synthesizer** (use with `agent_type="general-purpose"`):
> You are a consensus observer. Review the full interaction history.
> Identify agreement that EMERGED from the rounds and formalize it.
> For disagreements, make a clear tiebreaker with reasoning.
> Provide a confidence score (0-100). Never produce "both approaches have merit" non-answers.

## Context & Session Management

- Each subagent gets **its own context window** — swarms don't bloat the main conversation
- Use `/context` to monitor token usage; `/compact` if orchestration overhead builds up
- SQL tables (`swarm_rounds`) are **per-session** and reset with `/clear`
- For cross-session lessons, append to `~/.copilot/swarm-lessons.jsonl`:
  ```json
  {"task":"archon rewire","tier":"blitz","workstreams":5,"rounds":2,"confidence":88,"lesson":"Split by directory, not by feature"}
  ```

## Design Principles (arXiv:2602.16301)

1. **Diversity → inference** — Mixed agent pool forces in-context strategy inference (§3.1)
2. **Inference from content, not labels** — Explicit IDs cause cooperation collapse (§3.1 ablation)
3. **Adaptation = vulnerability = cooperation** — Mutual shaping pressure converges to quality (§3.2)
4. **Decentralized** — Orchestrator sets up interaction; does NOT dictate outcomes (§4)
5. **Dual timescale** — Fast: within-swarm adaptation. Slow: cross-session lesson tracking (§1)

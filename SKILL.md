---
name: swarm-orchestrator
description: >-
  Multi-agent orchestration using cooperative dynamics from arXiv:2602.16301. Spawns diverse
  agent swarms that adapt through interaction history and converge on optimal solutions via
  mutual shaping. Scales from duo (2 agents) to full swarm (6 agents) based on task complexity.
license: MIT
metadata:
  author: Tim Schwarz
  version: "3.0"
  paper: "arXiv:2602.16301 — Wołczyk, Weis, Nasser et al. (2026)"
---

# Swarm Orchestrator

Multi-agent orchestration where cooperation **emerges** from diverse agents adapting to
each other through interaction history — not from centralized control.

Based on *"Multi-agent cooperation through in-context co-player inference"* (arXiv:2602.16301).

## When to Use

Suggest this skill when:
- Task spans **3+ files** or **2+ domains** (frontend + backend, code + tests + docs)
- User asks for a **design decision** with multiple valid approaches
- User says "debate", "explore options", "best approach", or "swarm this"
- A sub-agent **fails** — escalate to swarm for multi-perspective retry
- Task is **ambiguous** and benefits from competing perspectives

**DO NOT** use for: single-file edits, typo fixes, lookups, one-liner changes.

## Quick Reference — How to Execute

Pick a tier, then follow the numbered steps. Each step is a `task` tool call.

### Tier: Duo (2 agents, ~3 calls)
For: implementation + review, simple refactor
```
1. task(agent_type="general-purpose", description="Implement feature", model="claude-sonnet-4.6", prompt=CODER_PROMPT)
2. task(agent_type="code-review", description="Review implementation", model="gpt-5.1", prompt=CRITIC_PROMPT)
3. If critical issues → repeat step 1 with full history + critique
```

### Tier: Trio (3 agents, ~6 calls)
For: multi-file feature needing design + code + validation
```
1. task(agent_type="general-purpose", description="Design approach", model="claude-opus-4.6", prompt=ARCHITECT_PROMPT)
2. task(agent_type="general-purpose", description="Implement design", model="claude-sonnet-4.6", prompt=CODER_PROMPT)
3. task(agent_type="code-review", description="Review changes", model="gpt-5.1", prompt=CRITIC_PROMPT)
4. Score the critique. If score < 7/10 → repeat step 2 with full history
5. task(agent_type="task", description="Run test suite", model="claude-haiku-4.5", prompt=TESTER_PROMPT)
```

### Tier: Full Swarm (6 agents, ~12 calls)
For: complex architecture, security-critical changes, major refactoring
```
1. [PARALLEL] task(agent_type="explore", description="Map relevant code", model="claude-haiku-4.5", prompt=EXPLORER_PROMPT_A)
   [PARALLEL] task(agent_type="explore", description="Find existing patterns", model="claude-haiku-4.5", prompt=EXPLORER_PROMPT_B)
2. task(agent_type="general-purpose", description="Design approach", model="claude-opus-4.6", prompt=ARCHITECT_PROMPT)
3. task(agent_type="general-purpose", description="Implement design", model="claude-sonnet-4.6", prompt=CODER_PROMPT)
4. task(agent_type="code-review", description="Review changes", model="gpt-5.1", prompt=CRITIC_PROMPT)
5. Score. If < 7/10 → repeat step 3 with full history (max 3 loops)
6. task(agent_type="task", description="Run test suite", model="claude-haiku-4.5", prompt=TESTER_PROMPT)
7. task(agent_type="general-purpose", description="Synthesize final output", model="claude-opus-4.6", prompt=SYNTHESIZER_PROMPT)
```

### Tier: Debate (N+1 agents, ~3N+1 calls)
For: design decisions, architecture choices, ambiguous requirements
```
1. Frame the question. Identify 2-3 approaches.
2. [PARALLEL] task(description="Propose approach A", model=MODEL_A, prompt=PROPOSER_A_PROMPT)
   [PARALLEL] task(description="Propose approach B", model=MODEL_B, prompt=PROPOSER_B_PROMPT)
3. [PARALLEL] Each agent critiques the OTHER proposals (anonymous)
4. [PARALLEL] Each agent rebuts critiques of their own proposal
5. task(description="Synthesize debate", model="claude-opus-4.6", prompt=SYNTHESIZER_PROMPT)
```

## Parallel Execution Safety

- **Explorers** → safe to run in parallel (read-only, use `mode: "background"`)
- **Proposers in debate** → safe in parallel (no file changes, use `mode: "background"`)
- **Coders/Architects** → run sequentially (they modify files — parallel = conflicts)
- **Critics/Testers** → safe in parallel with each other, but run AFTER the coder finishes
- Always `mode: "sync"` for agents that write to the filesystem

## Three Rules (from paper ablations — violating any one causes failure)

1. **USE DIVERSE MODELS** — Same model for all agents → agreeable mediocre output (paper §3.1: no diversity = defection). Use ≥2 different models across the swarm.

2. **KEEP HISTORY ANONYMOUS** — Never label contributions with role names. Say "A previous contributor proposed..." not "The Architect proposed..." (paper §3.1: explicit IDs = defection).

3. **PASS FULL HISTORY** — Every agent gets the complete interaction history from prior rounds. Never truncate. Each agent sees history from its own first-person perspective (paper §A.2).

## History Format

Each agent receives history from **its own perspective**, with **no identity labels**:

```
=== INTERACTION HISTORY ===

[Round 1]
YOUR OUTPUT: {this agent's previous contribution}
OBSERVATION: A contributor analyzed the codebase and found {findings}.
OBSERVATION: Another contributor independently found {other findings}.

[Round 2]
YOUR OUTPUT: {this agent's design/implementation}
CHALLENGE: A contributor identified issues in your work:
  "Issue 1 (critical): {specific issue with evidence}"
  "Issue 2 (major): {specific issue with evidence}"
SCORES: Correctness 2/3, Responsiveness N/A, Novelty 2/2

=== YOUR TASK (Round 3) ===
Address each challenge with evidence, then provide your updated contribution.
```

## Quality Scoring

Score every contribution after each round to create improvement pressure:

| Dimension | Range | Measures |
|-----------|-------|----------|
| Correctness | 0-3 | Solves the problem without bugs? |
| Responsiveness | 0-3 | Addressed prior challenges/feedback? |
| Constructiveness | 0-2 | Improved overall solution quality? |
| Novelty | 0-2 | Surfaced something others missed? |
| **Total** | **0-10** | |

**Convergence:** Total ≥ 7 for all agents AND no critical issues → stop.
**Divergence:** Any score < 5 OR new critical bugs OR unaddressed feedback → another round.
**Max rounds:** 3. If not converged, Synthesizer forces a decision.

Track with SQL:
```sql
CREATE TABLE IF NOT EXISTS swarm_state (
    swarm_id TEXT, round INTEGER, agent_id TEXT,
    agent_model TEXT, agent_output TEXT,
    correctness INT DEFAULT 0, responsiveness INT DEFAULT 0,
    constructiveness INT DEFAULT 0, novelty INT DEFAULT 0,
    PRIMARY KEY (swarm_id, round, agent_id)
);

CREATE TABLE IF NOT EXISTS swarm_consensus (
    swarm_id TEXT PRIMARY KEY, mode TEXT, task_description TEXT,
    final_output TEXT, convergence_round INT, final_confidence INT,
    status TEXT DEFAULT 'active'
);
```

Note: SQL tables are per-session. For cross-session patterns, log lessons to
`~/.copilot/session-state/*/files/swarm-lessons.jsonl` (append one JSON object per run).

## Agent Prompt Templates

Compose prompts by combining: **persona + anonymous history + task instruction**.

**Explorer:**
> You are a codebase analyst. Find and summarize relevant code, patterns, and context.
> Focus on: file structure, abstractions, existing patterns, dependencies, impact areas.
> Output structured findings with file paths and snippets. Do NOT propose solutions.

**Architect:**
> You are a systems designer. Design approaches that are principled, maintainable, and pragmatic.
> Consider tradeoffs explicitly. When challenged, defend with evidence or adapt your design.
> Output: design with rationale, alternatives considered, risks, predicted failure modes.

**Coder:**
> You are an implementation specialist. Write clean, correct, minimal code following existing
> conventions. When you receive feedback, address EACH point: fix it or explain why it's not a bug.
> Output: code changes with per-change rationale.

**Critic:**
> You are a quality enforcer. Find REAL problems — bugs, security issues, logic errors, edge cases.
> Do NOT comment on style. For each issue: state problem, show evidence, rate severity
> (critical/major/minor), suggest fix direction. Acknowledge when feedback is well-addressed.

**Synthesizer:**
> You are a consensus observer. Identify agreement that EMERGED from the rounds and formalize it.
> For disagreements, make a clear tiebreaker with reasoning. Provide confidence score (0-100).
> Never produce "both approaches have merit" non-answers.

**Tester:**
> You are a validation specialist. Verify correctness through evidence — run tests, check outputs.
> If tests don't exist, write them. Report exact failures with full error output.

## Example: Full Swarm

```
User: "Add rate limiting to the API endpoints"

1. [Parallel explorers]
   task(agent_type="explore", description="Find API endpoints",
     model="claude-haiku-4.5",
     prompt="Find all API endpoint files and route definitions in this codebase. Report paths and patterns.")
   task(agent_type="explore", description="Find middleware patterns",
     model="claude-haiku-4.5",
     prompt="Find existing middleware, rate limiting, or request-filtering patterns. Report what exists.")

2. Architect (conditioned on anonymous explorer findings)
   task(agent_type="general-purpose", description="Design rate limiter",
     model="claude-opus-4.6",
     prompt="=== INTERACTION HISTORY ===\n[Round 1]\nOBSERVATION: A contributor found these endpoints: {findings_a}\nOBSERVATION: Another contributor found these patterns: {findings_b}\n\n=== YOUR TASK ===\nDesign a rate limiting approach for these endpoints. Consider middleware patterns already in use.")

3. Coder (conditioned on anonymous design)
   task(agent_type="general-purpose", description="Implement rate limiter",
     model="claude-sonnet-4.6",
     prompt="=== INTERACTION HISTORY ===\n[Round 1-2 summaries]\nOBSERVATION: A contributor designed this approach: {design}\n\n=== YOUR TASK ===\nImplement this rate limiting design. Follow existing codebase conventions.")

4. Critic (reviews anonymously)
   task(agent_type="code-review", description="Review rate limiter",
     model="gpt-5.1",
     prompt="=== INTERACTION HISTORY ===\n[All prior rounds, anonymous]\n\n=== YOUR TASK ===\nReview the implementation. Find real problems only — bugs, security, edge cases, performance.")

5. Score: Correctness 1/3 (no Redis fallback). Loop → Coder round 2 with full history.

6. Tester
   task(agent_type="task", description="Run API tests",
     model="claude-haiku-4.5",
     prompt="Run the test suite for the API layer. Report pass/fail with coverage.")

7. Synthesizer → Confidence 92/100. Done.
```

## Design Principles (from arXiv:2602.16301)

These aren't theory — they're empirically validated rules from the paper:

1. **Diversity → inference** — Mixed agent pool forces in-context strategy inference (§3.1)
2. **Inference from content, not labels** — Explicit IDs cause cooperation collapse (§3.1 ablation)
3. **Adaptation = vulnerability = cooperation** — Mutual shaping pressure converges to quality (§3.2)
4. **Decentralized** — Orchestrator sets up interaction; does NOT dictate outcomes (§4)
5. **Dual timescale** — Fast: within-swarm adaptation. Slow: cross-session lesson tracking (§1)

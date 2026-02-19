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
  version: "4.0"
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

## Pre-Flight Setup

Before launching a swarm:
1. **Enable fleet mode** — Run `/fleet` to enable parallel subagent execution
2. **For Full Swarm or Debate** — Use `/plan` or `Shift+Tab` to plan mode first. The best practice workflow is: explore → plan → code → commit
3. **Check context** — Run `/context` to verify sufficient token space. Each subagent gets its own context window, so swarms are efficient despite multiple agents

## How Invocation Works

- **Automatic:** Copilot auto-selects this skill when it detects swarm-appropriate tasks
- **Explicit:** User says `/swarm-orchestrator`, "swarm this", "debate this", or "use the swarm-orchestrator skill"
- **Monitor progress:** Use `/tasks` to view and manage running subagents

## Quick Reference — Execution Checklists

Pick a tier, then follow the numbered steps. Each step is a `task` tool call.
Subagents run in **their own context window** — this keeps the main conversation clean.

### Tier: Duo (2 agents, ~3 calls)
For: implementation + review, simple refactor
```
1. task(agent_type="clean-code", description="Implement feature", model="claude-sonnet-4.6",
     prompt="[anonymous history + task]\n" + TASK_DESCRIPTION)
2. task(agent_type="code-review", description="Review implementation", model="gpt-5.2-codex",
     prompt="[anonymous history]\n Review the implementation. Find real problems only.")
3. If critical issues → repeat step 1 with full anonymous history + critique
```

### Tier: Trio (3 agents, ~6 calls)
For: multi-file feature needing design + code + validation
```
1. task(agent_type="architect", description="Design approach", model="claude-opus-4.6",
     prompt="[task context]\n Design an approach for: TASK_DESCRIPTION")
2. task(agent_type="clean-code", description="Implement design", model="claude-sonnet-4.6",
     prompt="[anonymous history: design from step 1]\n Implement this design.")
3. task(agent_type="code-review", description="Review changes", model="gpt-5.2-codex",
     prompt="[anonymous history: design + implementation]\n Review for bugs, security, edge cases.")
4. Score the critique (see Quality Scoring). If < 7/10 → repeat step 2 with full history
5. task(agent_type="task", description="Run test suite", prompt="Run the test suite. Report pass/fail.")
```

### Tier: Full Swarm (5-6 agents, ~12 calls)
For: complex architecture, security-critical changes, major refactoring.
**Recommend `/plan` first.**
```
1. [PARALLEL — use mode: "background", then read_agent to collect results]
   task(agent_type="explore", description="Map relevant code", prompt=EXPLORER_PROMPT_A)
   task(agent_type="explore", description="Find existing patterns", prompt=EXPLORER_PROMPT_B)
2. task(agent_type="architect", description="Design approach", model="claude-opus-4.6",
     prompt="[anonymous history: explorer findings]\n Design approach for: TASK")
3. task(agent_type="clean-code", description="Implement design", model="claude-sonnet-4.6",
     prompt="[anonymous history: findings + design]\n Implement this design.")
4. task(agent_type="code-review", description="Review changes", model="gpt-5.2-codex",
     prompt="[anonymous history: all prior rounds]\n Review for bugs, security, edge cases.")
5. Score. If < 7/10 → repeat step 3 with full history (max 3 loops)
6. task(agent_type="task", description="Run test suite", prompt="Run tests. Report pass/fail.")
7. task(agent_type="general-purpose", description="Synthesize consensus", model="claude-opus-4.6",
     prompt="[full anonymous history]\n" + SYNTHESIZER_PROMPT)
```

### Tier: Debate (N+1 agents, ~3N+1 calls)
For: design decisions, architecture choices, ambiguous requirements.
**Recommend `/plan` first.**
```
1. Frame the question. Identify 2-3 approaches.
2. [PARALLEL]
   task(agent_type="general-purpose", description="Propose approach A", model=MODEL_A, prompt=PROPOSER_PROMPT_A)
   task(agent_type="general-purpose", description="Propose approach B", model=MODEL_B, prompt=PROPOSER_PROMPT_B)
3. [PARALLEL] Each agent critiques the OTHER proposals (pass anonymous history)
4. [PARALLEL] Each agent rebuts critiques of their own proposal
5. task(agent_type="general-purpose", description="Synthesize debate", model="claude-opus-4.6",
     prompt="[full anonymous debate history]\n" + SYNTHESIZER_PROMPT)
```

## Three Rules (violating any one causes failure — from paper ablations)

1. **USE DIVERSE MODELS** — Same model = agreeable mediocre output. Use ≥2 different models.
   - Opus for deep reasoning (architect, synthesizer)
   - Sonnet for implementation (coder)
   - Codex for code review (critic) — recommended by GitHub best practices for reviewing code from other models
   - Haiku for fast read-only tasks (explorer, tester)

2. **KEEP HISTORY ANONYMOUS** — Never label contributions with role names in history passed between agents. Say "A previous contributor proposed..." not "The Architect proposed..."

3. **PASS FULL HISTORY** — Every agent gets the complete interaction history from prior rounds. Never truncate. Each agent sees history from its own first-person perspective.

## Parallel Safety & Monitoring

**Safe in parallel** (read-only, use `mode: "background"`):
- Explorers, Proposers in debate, Critics/Testers (after coder finishes)
- Use `read_agent(agent_id=ID)` to collect results from background agents

**Sequential only** (writes files, use `mode: "sync"`):
- Coders, Architects implementing changes

**Monitoring:** Use `/tasks` to view all running subagents and their status.

## Anonymous History Format

Each subagent receives history from **its own perspective**, with **no identity labels**:

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

Score every contribution to create improvement pressure:

| Dimension | Range | Measures |
|-----------|-------|----------|
| Correctness | 0-3 | Solves the problem without bugs? |
| Responsiveness | 0-3 | Addressed prior challenges/feedback? |
| Constructiveness | 0-2 | Improved overall solution quality? |
| Novelty | 0-2 | Surfaced something others missed? |
| **Total** | **0-10** | |

**Converge:** ≥ 7 for all agents AND no critical issues → stop.
**Diverge:** Any < 5 OR new critical bugs → another round. **Max 3 rounds.**

Track with SQL (per-session):
```sql
CREATE TABLE IF NOT EXISTS swarm_rounds (
    round INT, agent TEXT, model TEXT, score INT, output TEXT,
    PRIMARY KEY (round, agent)
);
```

## Swarm-Specific Prompt Templates

Custom agents (`architect`, `clean-code`, `code-review`, `debugger`) already have rich built-in prompts.
Only these swarm-specific roles need explicit prompts:

**Explorer** (use with `agent_type="explore"`):
> Find and summarize relevant code, patterns, and context for: {TASK}.
> Focus on: file structure, existing patterns, dependencies, impact areas.
> Output structured findings with file paths and snippets. Do NOT propose solutions.

**Synthesizer** (use with `agent_type="general-purpose"`):
> You are a consensus observer. Review the full interaction history below.
> Identify agreement that EMERGED from the rounds and formalize it.
> For disagreements, make a clear tiebreaker with reasoning.
> Provide a confidence score (0-100). Never produce "both approaches have merit" non-answers.

**Critic override** (use with `agent_type="code-review"` when you need swarm-style scoring):
> Review the implementation in the history below. Find REAL problems only — bugs, security
> issues, logic errors, edge cases. Do NOT comment on style. For each issue: state problem,
> show evidence, rate severity (critical/major/minor). Score using: Correctness 0-3,
> Responsiveness 0-3, Constructiveness 0-2, Novelty 0-2.

## Example: Full Swarm

```
User: "Add rate limiting to the API endpoints"

Pre-flight: /fleet (enable parallel subagents)

1. [Parallel explorers — mode: "background"]
   task(agent_type="explore", description="Find API endpoints",
     prompt="Find all API endpoint files and route definitions. Report paths and patterns.")
   task(agent_type="explore", description="Find middleware patterns",
     prompt="Find existing middleware or rate limiting patterns. Report what exists.")

2. Architect (anonymous explorer findings in history)
   task(agent_type="architect", description="Design rate limiter", model="claude-opus-4.6",
     prompt="=== INTERACTION HISTORY ===\n[Round 1]\nOBSERVATION: A contributor found: {findings_a}\nOBSERVATION: Another found: {findings_b}\n\n=== YOUR TASK ===\nDesign a rate limiting approach.")

3. Coder (anonymous design in history)
   task(agent_type="clean-code", description="Implement rate limiter", model="claude-sonnet-4.6",
     prompt="=== INTERACTION HISTORY ===\n...\nOBSERVATION: A contributor designed: {design}\n\n=== YOUR TASK ===\nImplement this rate limiting design.")

4. Critic (anonymous review)
   task(agent_type="code-review", description="Review rate limiter", model="gpt-5.2-codex",
     prompt="=== INTERACTION HISTORY ===\n[all prior, anonymous]\n\n=== YOUR TASK ===\nReview. Find real problems — bugs, security, edge cases. Score each dimension.")

5. Score: Correctness 1/3 (no fallback). Loop → step 3 with full history.

6. task(agent_type="task", description="Run API tests", prompt="Run tests. Report pass/fail.")

7. Synthesizer → Confidence 92/100. Done.
```

## Context & Session Management

- Each subagent runs in **its own context window** — swarms don't bloat the main conversation
- Use `/context` to monitor main agent token usage before/after swarm runs
- Use `/compact` if the main context gets heavy from orchestration overhead
- SQL tables (`swarm_rounds`) are **per-session** and reset with `/clear`
- For cross-session lessons, append to `~/.copilot/swarm-lessons.jsonl`:
  ```json
  {"task":"rate limiting","tier":"full","rounds":2,"confidence":92,"lesson":"Always check for existing middleware first"}
  ```

## Design Principles (arXiv:2602.16301)

1. **Diversity → inference** — Mixed agent pool forces in-context strategy inference (§3.1)
2. **Inference from content, not labels** — Explicit IDs cause cooperation collapse (§3.1 ablation)
3. **Adaptation = vulnerability = cooperation** — Mutual shaping pressure converges to quality (§3.2)
4. **Decentralized** — Orchestrator sets up interaction; does NOT dictate outcomes (§4)
5. **Dual timescale** — Fast: within-swarm adaptation. Slow: cross-session lesson tracking (§1)

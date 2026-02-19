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
  version: "5.2"
  paper: "arXiv:2602.16301 — Wołczyk, Weis, Nasser et al. (2026)"
---

# Swarm Orchestrator

Multi-agent orchestration where cooperation **emerges** from diverse subagents adapting to
each other through anonymous interaction history — not from centralized control.

## ⛔ KNOWN FAILURES — READ FIRST

These bugs were observed in real sessions. You MUST avoid all of them:

1. **NEVER use default model for explorers.** Every explorer call MUST have `model="claude-haiku-4.5"`.
   If you write `task(agent_type="explore", ...)` without `model="claude-haiku-4.5"`, it is a BUG.
2. **NEVER skip MERGE_STEP.** After every parallel fan-out (≥2 agents), you MUST run the merge
   agent before passing results to the next phase. Concatenating raw outputs is a BUG.
3. **NEVER stop after planning/triage.** If user asked for swarm/blitz execution, you MUST
   execute ALL phases through synthesis. Planning is phase 2-3 of 7-10. After creating a plan,
   switch out of plan mode (shift+tab) and IMMEDIATELY continue to the build phase.
4. **NEVER leave agents uncollected.** Call `read_agent(agent_id=X, wait=true)` for EVERY
   background agent. If you launched 5, you must collect 5.
5. **NEVER skip review.** Every tier MUST include the review phase. No exceptions.

## When to Use

- Task spans **3+ files** or **2+ domains** (frontend + backend, code + tests + docs)
- User says "debate", "explore options", "best approach", or "swarm this"
- User asks for a **design decision** with multiple valid approaches
- A sub-agent **fails** — escalate to swarm for multi-perspective retry

**DO NOT** use for: single-file edits, typo fixes, lookups, one-liner changes.

## Auto Pre-Flight — Run Before ANY Tier

When this skill is invoked, IMMEDIATELY do this before any other work:

1. **Fleet mode:** Use `ask_user` to tell the user:
   "Swarm orchestrator needs fleet mode for parallel agents. Please run `/fleet` if not already enabled, then say 'go'."
   Wait for confirmation before proceeding. If the user already said "fleet deployed" or similar
   in prior messages, skip this step.
2. **Plan mode (Full Swarm, Blitz, Debate only):** After fleet is confirmed, tell the user:
   "This tier benefits from plan mode. Please run `/plan` to switch, then say 'go'."
   For Duo and Trio tiers, skip this — go straight to execution.

This replaces any manual pre-flight. The user should never need to remember these steps.

## State Machine — Initialize at Swarm Start

Track progress in SQL. You MUST update status before/after each phase.

```sql
CREATE TABLE IF NOT EXISTS swarm_state (
  phase TEXT PRIMARY KEY,
  status TEXT DEFAULT 'pending',
  agent_ids TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS swarm_rounds (
  round INT, workstream TEXT, model TEXT, score INT, critical_issues INT,
  PRIMARY KEY (round, workstream)
);
```

Before each phase: `UPDATE swarm_state SET status='in_progress' WHERE phase='{name}';`
After each phase: `UPDATE swarm_state SET status='done' WHERE phase='{name}';`

**Before proceeding to next phase, ALWAYS run:**
```sql
SELECT phase FROM swarm_state WHERE status NOT IN ('done','skipped')
  AND phase < '{current_phase}' ORDER BY rowid;
```
If any rows returned → you skipped a phase. Go back and complete it.

## Core Rules (violating ANY causes failure — paper §3.1)

1. **DIVERSE MODELS** — Use ≥2 different models. Model assignments:
   - `model="claude-opus-4.6"` → architect, synthesizer
   - `model="claude-sonnet-4.6"` or `model="claude-sonnet-4.5"` → coders (alternate)
   - `model="gpt-5.2-codex"` or `model="gpt-5.1-codex"` → critics, coders (alternate)
   - `model="claude-haiku-4.5"` → ALL explorers and ALL merge steps (MANDATORY)
2. **ANONYMOUS HISTORY** — "A contributor found..." NEVER "The Architect found..."
3. **FULL HISTORY** — Every agent gets complete prior rounds. Never truncate.
4. **CROSS-COMMUNICATION** — Parallel coders MUST see other workstream summaries in prompt.

## MERGE_STEP — Exact Call (run after every parallel fan-out)

```
task(agent_type="explore", description="Merge N findings", model="claude-haiku-4.5",
  prompt="You are a synthesis editor. Below are N independent contributions.
  Produce ONE structured summary:
  1. Deduplicate overlapping findings
  2. Preserve ALL unique insights
  3. Flag contradictions between contributors
  4. Use anonymous language ('A contributor found...')
  5. Organize by topic, not by contributor\n\n" + collected_outputs)
```

## Execution Tiers

Execute EVERY step in order. **DO NOT stop partway through a tier.**

---

### Tier: Duo (2 agents, ~3 calls)
For: implementation + review, simple refactor.

**STEP 1:** `task(agent_type="clean-code", description="Implement X", model="claude-sonnet-4.6", prompt=TASK)`
**STEP 2:** `task(agent_type="code-review", description="Review X", model="gpt-5.2-codex", prompt=HISTORY + CRITIC_PROMPT)`
**STEP 3 — GATE:** Score ≥ 7 → done. Score < 7 → STEP 1 with history + critique. Max 2 loops.

---

### Tier: Trio (3 agents, ~6 calls)
For: multi-file feature needing design + code + validation.

**STEP 1:** `task(agent_type="architect", description="Design X", model="claude-opus-4.6", prompt=TASK)`
**STEP 2:** `task(agent_type="clean-code", description="Implement X", model="claude-sonnet-4.6", prompt=HISTORY + design)`
**STEP 3:** `task(agent_type="code-review", description="Review X", model="gpt-5.2-codex", prompt=HISTORY + CRITIC_PROMPT)`
**STEP 4 — GATE:** Score ≥ 7 → STEP 5. Score < 7 → STEP 2 with full history. Max 3 loops.
**STEP 5:** `task(agent_type="task", description="Run tests", prompt="Run test suite. Report pass/fail.")`

---

### Tier: Full Swarm (6+ agents, ~16 calls)
For: complex architecture, security-critical changes, major refactoring.

**Initialize:**
```sql
INSERT INTO swarm_state (phase) VALUES
  ('1_explore'),('2_merge_explore'),('3_design'),('4_implement'),
  ('5_merge_impl'),('6_review'),('7_gate'),('8_integration'),('9_validate'),('10_synthesize');
```

**STEP 1 — EXPLORE** (launch ALL simultaneously):
```
task(agent_type="explore", description="Map code structure", model="claude-haiku-4.5", mode="background", prompt=...)
task(agent_type="explore", description="Find patterns",     model="claude-haiku-4.5", mode="background", prompt=...)
task(agent_type="explore", description="Check dependencies", model="claude-haiku-4.5", mode="background", prompt=...)
```
⛔ **VERIFY:** All 3 have `model="claude-haiku-4.5"`. Collect ALL 3 with `read_agent(agent_id=X, wait=true)`.
```sql
UPDATE swarm_state SET status='done' WHERE phase='1_explore';
```

**STEP 2 — MERGE EXPLORE:** Run MERGE_STEP on 3 outputs → `merged_findings`.
```sql
UPDATE swarm_state SET status='done' WHERE phase='2_merge_explore';
```

**STEP 3 — DESIGN:**
```
task(agent_type="architect", description="Design approach", model="claude-opus-4.6",
  prompt="=== FINDINGS ===\n" + merged_findings + "\n=== TASK ===\nDesign approach. Split into independent workstreams by file/dir.")
```
→ Extract workstream list from output.
```sql
UPDATE swarm_state SET status='done' WHERE phase='3_design';
```

**STEP 4 — IMPLEMENT** (one coder per workstream, rotating models):
```
WS-A: task(agent_type="clean-code", description="Build WS-A", model="claude-sonnet-4.6", mode="background",
  prompt="=== HISTORY ===\n{merged_findings}\nDesign: {summary}\nOther workstreams: {ws_b, ws_c summaries}\n=== YOUR TASK ===\n{ws_a_spec}")
WS-B: task(agent_type="clean-code", description="Build WS-B", model="gpt-5.1-codex", mode="background",
  prompt="=== HISTORY ===\n{merged_findings}\nDesign: {summary}\nOther workstreams: {ws_a, ws_c summaries}\n=== YOUR TASK ===\n{ws_b_spec}")
WS-C: task(agent_type="clean-code", description="Build WS-C", model="claude-sonnet-4.5", mode="background",
  prompt="=== HISTORY ===\n{merged_findings}\nDesign: {summary}\nOther workstreams: {ws_a, ws_b summaries}\n=== YOUR TASK ===\n{ws_c_spec}")
```
⛔ **VERIFY:** Each coder has a DIFFERENT model. Each prompt includes other workstream summaries. Collect ALL.
```sql
UPDATE swarm_state SET status='done' WHERE phase='4_implement';
```

**STEP 5 — MERGE IMPL:** Run MERGE_STEP on all coder outputs → `merged_impl`.

**STEP 6 — REVIEW** (MANDATORY):
```
task(agent_type="code-review", description="Review all changes", model="gpt-5.2-codex",
  prompt="=== HISTORY ===\n{merged_findings}\nDesign: {summary}\n{merged_impl}\n=== TASK ===\n" + CRITIC_PROMPT)
```

**STEP 7 — GATE:** Parse scores per workstream. Any < 7 → re-run ONLY that coder with
critique + other coders' outputs + full history. Max 3 loops. Record in `swarm_rounds`.

**STEP 8 — INTEGRATION CHECK:**
```
task(agent_type="code-review", description="Integration check", model="claude-sonnet-4.6",
  prompt="=== ALL CHANGES ===\n{all_changes}\n=== TASK ===\nCheck for conflicts: duplicated logic, broken imports, inconsistent patterns.")
```

**STEP 9 — VALIDATE:**
```
task(agent_type="task", description="Run test suite", prompt="Run all tests. Report pass/fail.")
```

**STEP 10 — SYNTHESIZE:**
```
task(agent_type="general-purpose", description="Synthesize results", model="claude-opus-4.6",
  prompt="=== FULL HISTORY ===\n{everything}\n=== TASK ===\n" + SYNTHESIZER_PROMPT)
```

**FINAL VERIFY:**
```sql
SELECT phase, status FROM swarm_state WHERE status != 'done';
-- MUST return 0 rows. If any phase is not done, go back and complete it.
```

---

### Tier: Blitz (10+ agents, ~22+ calls)
For: massive codebases, full-app rewires, multi-domain overhauls (50+ files).

**Initialize:**
```sql
INSERT INTO swarm_state (phase) VALUES
  ('1_recon'),('2_merge_recon'),('3_triage'),('4_build'),('5_merge_build'),
  ('6_review'),('7_merge_review'),('8_gate'),('9_integration'),('10_validate'),('11_synthesize');
```

**STEP 1 — RECON** (5 parallel explorers):
```
task(agent_type="explore", description="Map structure",      model="claude-haiku-4.5", mode="background", prompt="Map directory tree, entry points, startup flow for: {TASK}")
task(agent_type="explore", description="Find patterns",      model="claude-haiku-4.5", mode="background", prompt="Find conventions, coding patterns, shared utilities for: {TASK}")
task(agent_type="explore", description="Trace dependencies", model="claude-haiku-4.5", mode="background", prompt="Trace imports, cross-module refs, circular deps for: {TASK}")
task(agent_type="explore", description="Hunt gaps",          model="claude-haiku-4.5", mode="background", prompt="Find stubs, TODOs, dead code, unregistered routes for: {TASK}")
task(agent_type="explore", description="Analyze domain",     model="claude-haiku-4.5", mode="background", prompt="Analyze business logic, data models, API contracts for: {TASK}")
```
⛔ **VERIFY:** ALL 5 have `model="claude-haiku-4.5"`. Collect ALL 5 with `read_agent(wait=true)`.

**STEP 2 — MERGE RECON:** Run MERGE_STEP on 5 outputs → `merged_recon`.

**STEP 3 — TRIAGE:**
```
task(agent_type="architect", description="Triage and design", model="claude-opus-4.6",
  prompt="=== RECON ===\n{merged_recon}\n=== TASK ===\nPrioritized fix plan. Group into parallel workstreams by file/dir. Tag P0/P1/P2. For each: exact files, changes, acceptance criteria.")
```
→ Extract workstream definitions.

**⚡ DO NOT STOP HERE. Triage is step 3 of 11. Continue to STEP 4 immediately.**

**STEP 4 — PARALLEL BUILD** (N coders, rotating models):
Model rotation: `claude-sonnet-4.6` → `gpt-5.1-codex` → `claude-sonnet-4.5` → `gpt-5.2-codex` → cycle.
Each coder prompt MUST include: (1) merged recon, (2) triage design, (3) other workstream summaries.
All use `mode="background"`.
⛔ **VERIFY:** Each coder has a DIFFERENT model. Each prompt has cross-workstream context. Collect ALL.

**STEP 5 — MERGE BUILD:** Run MERGE_STEP on all coder outputs → `merged_build`.

**STEP 6 — PARALLEL REVIEW** (split across 2+ critics):
```
task(agent_type="code-review", description="Review batch 1", model="gpt-5.2-codex",   mode="background", prompt=HISTORY + batch_1_changes + CRITIC_PROMPT)
task(agent_type="code-review", description="Review batch 2", model="claude-sonnet-4.6", mode="background", prompt=HISTORY + batch_2_changes + CRITIC_PROMPT)
```
Collect ALL critics.

**STEP 7 — MERGE REVIEW:** Run MERGE_STEP on critic outputs.

**STEP 8 — GATE:** Parse scores. Any workstream < 7 → re-run ONLY that coder with critique +
other coders' outputs + full history. Max 3 loops. Record in `swarm_rounds`.

**STEP 9 — INTEGRATION CHECK:**
```
task(agent_type="code-review", description="Cross-workstream check", model="claude-opus-4.6",
  prompt="=== ALL CHANGES ===\n{everything}\n=== TASK ===\nCheck for cross-workstream conflicts.")
```

**STEP 10 — VALIDATE:**
```
task(agent_type="task", description="Run full test suite", prompt="Run all tests. Report.")
```

**STEP 11 — SYNTHESIZE:**
```
task(agent_type="general-purpose", description="Final synthesis", model="claude-opus-4.6",
  prompt="=== FULL HISTORY ===\n{everything}\n=== TASK ===\n" + SYNTHESIZER_PROMPT)
```

**FINAL VERIFY:**
```sql
SELECT phase, status FROM swarm_state WHERE status != 'done';
-- MUST return 0 rows.
```

---

### Tier: Debate (N+1 agents, ~3N+1 calls)
For: design decisions, architecture choices, ambiguous requirements.

**STEP 1:** Frame the question. Identify 2-3 approaches.
**STEP 2:** [PARALLEL] Each proposer argues one approach with a DIFFERENT model.
**STEP 3:** [PARALLEL] Each critiques the OTHER proposals (anonymous history).
**STEP 4:** [PARALLEL] Each rebuts critiques.
**STEP 5:** Run MERGE_STEP on all proposals + critiques + rebuttals.
**STEP 6:** `task(agent_type="general-purpose", description="Synthesize debate", model="claude-opus-4.6", prompt=HISTORY + SYNTHESIZER_PROMPT)`

---

## Anonymous History Format

Each subagent receives history with NO identity labels:
```
=== INTERACTION HISTORY ===
[Round 1 — Exploration]
OBSERVATION: A contributor mapped the codebase and found {findings}.
OBSERVATION: Another contributor independently found {other findings}.

[Round 2 — Design]
OBSERVATION: A contributor designed an approach: {design summary}

[Round 3 — Implementation]
YOUR OUTPUT: {this agent's code changes}
OBSERVATION: A contributor implemented {other workstream changes}.

[Round 4 — Review]
CHALLENGE: A reviewer found: "Issue 1 (critical): {problem}"
SCORES: Correctness 2/3, Responsiveness N/A, Constructiveness 1/2, Novelty 2/2 → 7/10

=== YOUR TASK (Round 5) ===
```

## Quality Scoring — MANDATORY GATE

| Dimension | Range | Measures |
|-----------|-------|----------|
| Correctness | 0-3 | Solves the problem without bugs? |
| Responsiveness | 0-3 | Addressed prior challenges? |
| Constructiveness | 0-2 | Improved overall quality? |
| Novelty | 0-2 | Surfaced something others missed? |
| **Total** | **0-10** | |

**≥ 7** → proceed. **< 7** → re-run failing workstream with critique + cross-awareness. **Max 3 loops.**

## Prompt Templates

**Critic** (use with `agent_type="code-review"`):
> Find REAL problems only — bugs, security issues, logic errors. Do NOT comment on style.
> Check cross-workstream conflicts. REQUIRED: Score Correctness 0-3, Responsiveness 0-3,
> Constructiveness 0-2, Novelty 0-2. Total /10.

**Synthesizer** (use with `agent_type="general-purpose"`):
> Review full history. Identify emerged agreement. Tiebreak disagreements with reasoning.
> Confidence score 0-100. Never produce "both approaches have merit" non-answers.

## Parallel Safety

| Mode | Use For |
|------|---------|
| `mode: "background"` | Explorers, critics, proposers (read-only) |
| `mode: "sync"` or `mode: "background"` | Coders on DIFFERENT files (non-overlapping) |
| Sequential only | Coders on SAME files |

## Session Management

- Each subagent gets **its own context window** — swarms don't bloat main conversation
- `/fleet` enables parallel execution. `/tasks` monitors running agents. `/context` checks tokens.
- SQL tables are per-session. For cross-session lessons: `~/.copilot/swarm-lessons.jsonl`

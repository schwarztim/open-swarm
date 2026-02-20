---
name: swarm-orchestrator
description: >-
  Multi-agent orchestration using cooperative dynamics from arXiv:2602.16301. Spawns diverse
  agent swarms via task tool or independent copilot CLI subprocesses. Agents adapt through
  anonymous interaction history and converge on optimal solutions via mutual shaping.
  Use when tasks span 3+ files, need design decisions, or benefit from competing perspectives.
  Invoke with /swarm-orchestrator or "swarm this".
license: MIT
metadata:
  author: Tim Schwarz
  version: "6.2"
  paper: "arXiv:2602.16301 — Wołczyk, Weis, Nasser et al. (2026)"
  mcp: open-swarm
---

# ⛔ MANDATORY FIRST ACTION — READ BEFORE DOING ANYTHING ELSE

When this skill is invoked — whether by name, by "/swarm-orchestrator", or because the user
said "swarm", "blitz", "fleet", "debate this", or any multi-agent request — you MUST do this:

**Step 0: Call the `swarm_init` MCP tool IMMEDIATELY.**

```
swarm_init(task="<the user's full task description>", tier="<if user specified one>", fileCount=<if known>)
```

DO NOT launch any task() calls yourself.
DO NOT create your own plan.
DO NOT pick models.
DO NOT explore the codebase first.
DO NOT do anything except call `swarm_init`.

The MCP server controls everything. You are the executor, not the planner.

# Execution Loop — Follow Exactly

After `swarm_init` returns a `sessionId`, enter this loop and DO NOT exit it:

```
LOOP:
  1. Call swarm_next(sessionId)           → server returns exact task() parameters
  2. Execute task() with EXACT params     → do not change model, agent_type, or mode
  3. Collect output (read_agent if background, or direct result if sync)
  4. Call swarm_submit(sessionId, output)  → server tells you what to do next
  5. If server says "call swarm_merge"     → call swarm_merge(sessionId, outputs=[...])
     then call swarm_submit with merge result
  6. If server says "call swarm_gate"      → call swarm_gate(sessionId, scores=[...])
  7. If server says "All phases complete"  → STOP. Otherwise → go to step 1.
```

# Subprocess Execution Mode (True Process Isolation)

When the user says "subprocess mode", "independent agents", or "copilot subprocess", OR when you
want maximum isolation per arXiv:2602.16301, use subprocess mode:

**Step 0:** Call swarm_init with executionMode:
```
swarm_init(task="...", executionMode="subprocess")
```

**Subprocess Loop:**
```
LOOP:
  1. Call swarm_next(sessionId)           → server returns spawnCommands with copilot CLI commands
  2. Create output directory:              mkdir -p <outputDir>
  3. For EACH spawnCommand:
     a. Write prompt: printf '%s' "<prompt>" > <promptFile>
     b. Spawn: bash(command="<command>", mode="async", detach=true)
     c. Note the PID
  4. Monitor: poll log files for completion (check file size stops growing)
  5. Read outputs: cat each outputFile or logFile
  6. Call swarm_collect(sessionId, outputs=[{workstream, output}, ...])
  7. If server says "call swarm_merge"     → call swarm_merge, then swarm_collect with merge result
  8. If server says "call swarm_gate"      → call swarm_gate with scores
  9. If server says "All phases complete"  → STOP. Otherwise → go to step 1.
```

**Why subprocess mode?** Each copilot process gets:
- Its own 200k context window (no shared context pollution)
- Its own model via `--model` flag (true diversity)
- Its own MCP connections (independent tool access)
- Zero visibility into other workstreams (true anonymity per §3.1)
- Fault isolation (one crash doesn't affect others)

**When to use subprocess vs task mode:**
| Scenario | Mode |
|----------|------|
| Quick fix, small scope | task (duo/trio) |
| Large codebase, many files | subprocess (blitz) |
| Need max diversity/isolation | subprocess (any tier) |
| Debate between approaches | subprocess (debate) |
| Default / unsure | task |

# ⛔ Violations That Break The System

These have been observed in real sessions. Each one causes failure:

1. **Using DEFAULT model.** Every task() call MUST include the `model` field from swarm_next.
   If you write `task(agent_type="explore", ...)` without a model, it is a BUG.
2. **Skipping swarm_init.** If you launch task() calls without first calling swarm_init,
   you are not using the swarm — you are freelancing. This defeats the entire system.
3. **Ignoring swarm_next.** The server picks models, agent types, and modes. You do not.
   Copy the task() parameters from swarm_next responses exactly. Do not improvise.
4. **Skipping merge.** When swarm_submit says "call swarm_merge", you MUST merge.
   Going directly to the next build phase without merging is a BUG.
5. **Stopping after planning.** Blitz has 11 phases. If you stop at phase 3 (triage),
   you completed 27% of the work. Continue the loop until the server says done.
6. **Making your own plan.** Do not enter plan mode. Do not create a plan.md.
   The server's triage/design phase IS the plan. Execute it.

# Pre-Flight

For full-swarm, blitz, or debate tiers: use `ask_user` to prompt:
"Swarm orchestrator needs fleet mode. Please run /fleet if not already enabled, then say go."
Wait for confirmation. Then call `swarm_init`.

For duo or trio: call `swarm_init` directly. No pre-flight needed.

# Tiers (server auto-selects, or user specifies)

| Tier | Agents | Phases | Trigger |
|------|--------|--------|---------|
| duo | 2 | 3 | Simple fix, single-file |
| trio | 3 | 5 | "design", "feature", multi-file |
| full-swarm | 6+ | 10 | "refactor", "security", "architecture" |
| blitz | 10+ | 11 | "massive", "entire codebase", 50+ files |
| debate | N+1 | 5 | "debate", "which approach", "tradeoff" |

All tiers support both `task` and `subprocess` execution modes.

# Why This Architecture

Based on arXiv:2602.16301. The paper proves cooperation emerges from:
- **Diverse models** (server assigns different models to each agent)
- **Anonymous history** (server strips identity from all outputs)
- **Mutual shaping** (quality gates force iterative improvement)

Remove any one of these → agents defect instead of cooperating.
The MCP server enforces all three. Your only job is to follow the loop.

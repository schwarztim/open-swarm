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
  version: "6.0"
  paper: "arXiv:2602.16301 — Wołczyk, Weis, Nasser et al. (2026)"
  mcp: open-swarm
---

# Swarm Orchestrator v6.0 — MCP-Enforced

This skill is powered by the **open-swarm** MCP server running on ToolHive.
The server enforces model diversity, phase ordering, merge steps, and quality gates
as mandatory tool calls — not suggestions.

## How It Works

When the user asks to "swarm this", "use fleet mode", or "blitz this":

1. **Call `swarm_init`** with the task description. The server auto-selects the tier
   (duo/trio/full-swarm/blitz/debate) or accepts an explicit tier.
2. **Call `swarm_next`** to get the exact `task()` parameters for the current phase.
   The server picks the model, agent type, and mode. You execute exactly what it returns.
3. **After each task completes, call `swarm_submit`** with the output.
4. **When the server says to merge, call `swarm_merge`** with the parallel outputs.
5. **At gate phases, call `swarm_gate`** with scores. Server decides proceed/retry.
6. **Repeat `swarm_next` → execute → `swarm_submit`** until all phases complete.

## Rules

1. **NEVER pick your own models.** The server assigns models via `swarm_next`. Use them exactly.
2. **NEVER skip merge.** If `swarm_submit` says "call swarm_merge", you MUST merge before advancing.
3. **NEVER stop early.** Continue the `swarm_next` loop until the server says "All phases complete."
4. **NEVER expose agent identity.** The server anonymizes history. Do not add model or agent names to prompts.
5. **Check `swarm_status`** if you lose track of where you are.

## Tiers

| Tier | Agents | Phases | When |
|------|--------|--------|------|
| duo | 2 | 3 | Simple fixes, single-file |
| trio | 3 | 5 | Design + implement + review |
| full-swarm | 6+ | 10 | Multi-file refactors, architecture |
| blitz | 10+ | 11 | Massive codebases, full-app overhauls |
| debate | N+1 | 5 | Architecture decisions, tradeoff analysis |

## Quick Start

When user says "swarm this" or similar:
```
1. swarm_init(task="<user's task description>")  → get sessionId
2. swarm_next(sessionId)                         → get task() params
3. task(…exact params from step 2…)              → execute
4. swarm_submit(sessionId, output=result)         → advance
5. Repeat 2-4 until done
```
## Pre-Flight

When invoked, if the tier is full-swarm, blitz, or debate, prompt the user:
"Swarm needs fleet mode for parallel agents. Please run `/fleet` if not already enabled."

## Paper Reference

Based on arXiv:2602.16301 — cooperation emerges from diversity + anonymous history + mutual shaping.
The MCP server implements this: diverse models assigned server-side, anonymous history built server-side,
quality gates enforce mutual shaping through iterative improvement loops.

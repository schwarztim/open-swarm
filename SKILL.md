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
  version: "7.0"
  paper: "arXiv:2602.16301 — Wołczyk, Weis, Nasser et al. (2026)"
  mcp: open-swarm
---

# Swarm Orchestrator — Launcher

When this skill is invoked, you have ONE job: **launch the swarm-runner agent**.

Do this IMMEDIATELY — no exploration, no planning, no codebase analysis:

```
task(
  agent_type="swarm-runner",
  description="Swarm: <brief summary>",
  prompt="<paste the user's COMPLETE request here verbatim — include every detail, objective, config, and constraint they provided>",
  mode="sync"
)
```

That's it. The swarm-runner agent handles everything:
- Calls swarm_init on the Open Swarm MCP server
- Gets workstream assignments, models, and phases from the server
- Dispatches sub-agents via task() with server-assigned parameters
- Manages merges, quality gates, and retries
- Reports final results

## Rules

1. Do NOT call swarm_init yourself — the swarm-runner agent does that
2. Do NOT launch multiple task() agents yourself — the swarm-runner manages sub-agents
3. Do NOT create a plan or explore the codebase — pass the request through
4. Do NOT modify or summarize the user's prompt — pass it VERBATIM
5. If the user says "subprocess mode" or "independent agents", append that to the prompt

## After swarm-runner completes

Report its output to the user. If it failed, you may retry once with a refined prompt.

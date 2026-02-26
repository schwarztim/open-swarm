# Open Swarm — OpenCode Instructions

## Project Overview

Open Swarm is an MCP server providing enterprise-grade multi-agent orchestration.
It implements a strict 3-tier hierarchy (L1 Orchestrator → L2 Managers → L3 Workers)
based on arXiv:2602.16301 (cooperative dynamics through anonymous interaction history).

## Architecture

```
L1 ORCHESTRATOR (swarm agent) — strategic decisions, MCP tools only, no file access
  ├── L2 MANAGER (manager-*) — plans, delegates workers, synthesizes reports
  │     ├── L3 WORKER (worker-coder) — writes code
  │     ├── L3 WORKER (worker-tester) — writes tests
  │     └── L3 WORKER (worker-security) — security audit
  └── L2 MANAGER (different provider for model diversity)
        └── L3 WORKERS...
```

## Key Rules

- L1 orchestrator NEVER reads/writes files — it delegates via task() and MCP tools
- L2 managers coordinate workers and synthesize reports — they CAN read/write files
- L3 workers execute specific tasks — they have full file tools but NO MCP tools
- Model diversity is enforced: managers and workers use different AI providers

## MCP Server

- **Location:** `mcp-server/` (TypeScript, Node.js)
- **Endpoint:** `http://127.0.0.1:38546/mcp`
- **Build:** `cd mcp-server && npm run build`
- **Start:** `cd mcp-server && npm start`
- **Tools:** 16 MCP tools (swarm_init, swarm_next, swarm_submit, swarm_merge, etc.)

## Agent Definitions

Agent prompts live in `opencode/agents/*.md` with YAML frontmatter.
Agent registry is in `opencode/opencode.json` under the `agent` key.
All agents use `{file:opencode/agents/<name>.md}` for prompt references.

## Build & Test

```bash
cd mcp-server && npm run build   # Must pass with zero errors
cd mcp-server && npm start       # Starts MCP server at :38546
```

## Swarm Usage

Use `@swarm` agent to orchestrate multi-agent tasks. Example:
```
@swarm Build an authentication system with JWT tokens
```

The swarm agent calls swarm_init(), then follows the protocol:
swarm_init → swarm_next → dispatch managers → collect outputs → swarm_submit → swarm_gate

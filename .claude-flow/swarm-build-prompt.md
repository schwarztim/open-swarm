# Claude Flow Swarm Build Prompt — Open Swarm v16

> **Purpose:** This is a complete specification prompt for Claude Flow to build, validate, and enhance the Open Swarm multi-agent orchestration system. Give this entire document as the task to Claude Flow. It contains everything an autonomous swarm needs to understand, build, and improve Open Swarm.

---

## 1. WHAT IS OPEN SWARM

Open Swarm is an **MCP (Model Context Protocol) server** that provides enterprise-grade multi-agent orchestration for OpenCode (https://opencode.ai). It implements a strict 3-tier hierarchy based on arXiv:2602.16301 (cooperative dynamics through anonymous interaction history):

```
L1 ORCHESTRATOR ──── Strategic decisions, debate resolution, sees everything
  │
  ├── L2 MANAGER [group-0] ──── Plans, delegates workers, synthesizes, debates peers
  │     ├── L3 WORKER (coder) ──── Writes code
  │     ├── L3 WORKER (tester) ──── Writes tests
  │     └── L3 WORKER (security) ──── Security audit
  │
  ├── L2 MANAGER [group-1] ──── Different provider (model diversity)
  │     ├── L3 WORKER (architect) ──── System design
  │     └── L3 WORKER (documenter) ──── Documentation
  │
  └── L2 MANAGER [group-N] ──── Scales horizontally (4-20+ managers)
        └── L3 WORKERS...
```

**Key innovation:** Context window management. Each agent's context stays small and focused — L1 never sees code, L3 never sees strategy. Managers bridge the gap.

**Repository:** `/Users/timothy.schwarz/open-swarm` (https://github.com/schwarztim/open-swarm.git)

---

## 2. HOW OPEN SWARM INTEGRATES WITH OPENCODE

### 2.1 The Invocation Chain

```
User types: /swarm "Build an auth system"
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ COPILOT CLI SKILL: swarm-orchestrator (SKILL.md)            │
│ → Immediately calls: task(agent_type="swarm-runner", ...)   │
│ → Passes user prompt VERBATIM. Does nothing else.           │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ SWARM-RUNNER AGENT (swarm-runner.agent.yaml)                │
│ → Calls swarm_init() on Open Swarm MCP server               │
│ → Gets sessionId, tier, manager assignments                 │
│ → Dispatches L2 managers via task()                         │
│ → Manages phases, gates, merges, debates                    │
│ → Reports final result back up                              │
└─────────────────────────────────────────────────────────────┘
     │
     ▼
┌─────────────────────────────────────────────────────────────┐
│ OPEN SWARM MCP SERVER (TypeScript, HTTP at :38546/mcp)      │
│ → 16 MCP tools for orchestration                            │
│ → State management, phase tracking, debate protocol         │
│ → Model pool assignment, rate limiting                      │
│ → Pattern memory, file claims, consensus                    │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 The Two Runtime Environments

Open Swarm operates across TWO different runtime environments simultaneously:

**Environment A: Copilot CLI (GitHub Copilot CLI agent)**
- Triggered by `/swarm-orchestrator` skill
- Uses `task()` to spawn sub-agents
- Agent definitions in: `~/.copilot/skills/` (SKILL.md format)
- Agent configs in: Copilot CLI's own agent system (YAML)
- The swarm-runner.agent.yaml lives here

**Environment B: OpenCode (terminal IDE with built-in agent system)**
- Agent definitions in: `opencode/agents/*.md` (Markdown with YAML frontmatter)
- Agent registry in: `opencode/opencode.json`
- Uses `task(subagent_type="<agent-name>")` to spawn sub-agents
- MCP servers connected via opencode.json `mcp` section
- L1, L2, L3 agents all live here

**CRITICAL:** The swarm MUST work in BOTH environments. The MCP server is the shared protocol layer — it doesn't care which environment calls it. The agent definitions are environment-specific.

---

## 3. WHAT TO BUILD / IMPROVE

### 3.1 Missing: Agent Definition Documentation
Add `docs/agent-definition-guide.md` explaining YAML frontmatter schema, tool permission matrix, registration in opencode.json, role mapping, prompt references, temperature guidelines, and a full example of creating "worker-devops" from scratch.

### 3.2 Missing: Dynamic Agent Definition at Runtime
Investigate if opencode.json can be hot-reloaded. If yes, L2 managers can write new .md files and register them. If no, document the "prompt injection" pattern for embedding role specialization in task prompts.

### 3.3 Missing: Persistent Pattern Memory
Add patterns.json or SQLite persistence in mcp-server/data/. Load patterns on server start, write after successful quality gates, support cross-session pattern sharing.

### 3.4 Missing: Anti-Drift Enforcement
Wire checkDrift() into handleSwarmSubmit(). Add configurable drift threshold (default: 0.6). On drift: reject submission with feedback. Optionally use generateDriftCheckPrompt() for LLM-based scoring.

### 3.5 Missing: Meta-Worker L1 Approval Gate
Add swarm_approve tool or reuse swarm_relay(type="approval"). Meta-worker submits diffs, L1 reviews, only approved changes commit. Validate with npm run build before commit.

### 3.6 Missing: End-to-End Integration Tests
Add mcp-server/test/ directory. Test: swarm lifecycle, debate protocol, file claims, pattern memory, consensus, tier selection, model pool assignment.

### 3.7 Missing: Comprehensive README for L3 Architecture
Add L3 Worker Architecture section with lifecycle diagram, role assignment flowchart, tool permission matrix, agent definition guide, dynamic spawning mechanics, sub-agent delegation rules.

---

## 4. SUCCESS CRITERIA

1. All agent definitions are documented
2. Dynamic spawning is clear and documented
3. Pattern memory persists across restarts
4. Anti-drift is wired into submit handler
5. Integration tests exist for core protocol
6. README covers L3 architecture comprehensively
7. `npm run build` succeeds with zero errors
8. All changes committed and pushed

---

## 5. CONSTRAINTS

- TypeScript only for MCP server code
- Markdown with YAML frontmatter for OpenCode agent definitions
- No new runtime dependencies without justification
- Backward compatible — all existing tools/agents must continue to work
- Model-agnostic — must work with Claude, GPT, Gemini providers
- Context-window conscious — keep prompts under 8K tokens per agent

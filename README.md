# Open Swarm

**Multi-agent cooperation system where AI models from different providers coordinate autonomously without a central controller.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![arXiv](https://img.shields.io/badge/arXiv-2602.16301-b31b1b.svg)](https://arxiv.org/abs/2602.16301)
[![Version](https://img.shields.io/badge/version-17.0-blue.svg)](#changelog)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6.svg)](https://www.typescriptlang.org)

---

## Research Basis

This system is a direct implementation of the cooperative dynamics described in:

> Wołczyk, M., Weis, J., Nasser, R., et al. (2026). **Cooperation Emerges from Diverse Agents Adapting to Each Other Through Anonymous Interaction History.** arXiv:2602.16301.

The paper identifies a causal mechanism by which cooperation arises without programming or central direction:

1. **Diversity** — agents trained against a diverse pool of co-players develop flexible strategies
2. **In-context inference** — agents infer co-player behavior from anonymous interaction history
3. **Cross-communication** — agents observe and react to each other's outputs
4. **Mutual shaping** — adaptiveness creates pressure that drives genuine cooperation
5. **Convergence** — cooperation emerges as a stable equilibrium (§4)

Open Swarm translates each step into a practical orchestration mechanism operating over real software engineering tasks across multiple LLM providers.

---

## How It Works

Traditional multi-agent systems route work through a central coordinator that issues explicit instructions at every step. Open Swarm removes the central controller. Agents coordinate through a shared message board, observe each other's anonymous outputs, critique and adapt, and converge toward a quality threshold — without any single agent directing the others.

```
Traditional:    Controller → Agent A → Agent B → Agent C → Output
                     centralized decisions at every step

Open Swarm:     Agent A <--> Agent B <--> Agent C --> Consensus
                     agents shape each other through observed outputs
```

The convergence condition is concrete: quality scores across all agents must reach 7/10 or above before a phase closes. Agents that fall short receive critiques from their peers — including outputs from agents on different providers — and revise. Disagreements that cannot be resolved within a workstream escalate through the hierarchy and, when necessary, trigger a structured debate protocol.

---

## Architecture

### Three-Tier Hierarchy

```
L1 — ORCHESTRATOR (1 agent)
     Owns the strategic goal. Initializes swarm, steps through phases,
     dispatches L2 managers, resolves escalations, runs quality gates.
     Model: Claude Opus
     |
     +-- L2 — MANAGERS (1 per provider group)
     |        Scope coordinators. Splits work, dispatches workers in
     |        staggered batches, reads cross-team board posts, resolves
     |        worker conflicts or escalates to L1.
     |        Models: Claude Sonnet, GPT-4o, Gemini Pro
     |
     +-- L3 — WORKERS (14 agents)
              Narrow-scope executors. Each receives a single scoped task,
              posts findings and blockers to the board, never communicates
              directly with workers outside their group.
              Models: distributed across Claude, GPT, and Gemini
```

Total agents: 16 (1 orchestrator + 1 manager per provider + 14 workers)

### Agent Roster

| Agent | Level | Role | Model |
|-------|-------|------|-------|
| swarm | L1 | Orchestrator | claude-opus-4 |
| manager-anthropic | L2 | Scope coordinator | claude-sonnet-4 |
| worker-coder | L3 | Implementation | claude-opus-4 |
| worker-tester | L3 | Test authoring | claude-opus-4 |
| worker-security | L3 | Security audit | claude-opus-4 |
| worker-architect | L3 | System design | claude-opus-4 |
| worker-debugger | L3 | Root cause analysis | claude-opus-4 |
| worker-integration | L3 | API wiring | claude-sonnet-4 |
| worker-database | L3 | Schema and migrations | claude-sonnet-4 |
| worker-devops | L3 | CI/CD and infrastructure | claude-sonnet-4 |
| worker-auth | L3 | Authentication and RBAC | claude-sonnet-4 |
| worker-documenter | L3 | Documentation | claude-haiku |
| worker-anthropic | L2-3 | Anthropic workstream | claude-opus-4 |
| worker-openai | L2-3 | OpenAI workstream | gpt-4o |
| worker-gemini | L2-3 | Google workstream | gemini-pro |
| worker-haiku | L2-3 | Fast merge and synthesis | claude-haiku |

### Communication Rules

Inter-agent communication is strictly typed and flows through a shared board, not shared context:

| Path | Allowed |
|------|---------|
| L1 <-> L2 | Orchestrator and managers communicate via board |
| L2 <-> L2 | Managers observe each other's plans and findings |
| L2 -> L3 | Managers dispatch workers via task prompt |
| L3 -> L2 | Workers post findings and blockers to board |
| L3 <-> L3 | Direct worker-to-worker communication is prohibited |

Workers never communicate directly. All cross-worker coordination passes through the manager, which reads board posts, makes decisions, and injects those decisions into subsequent worker prompts. This keeps each agent's context window small and prevents N-squared coordination overhead.

### Message Board

All coordination uses a typed message protocol:

| Type | Purpose | Posted By |
|------|---------|-----------|
| `plan` | Manager's work breakdown before dispatching workers | L2 |
| `finding` | Discovery other agents should know about | L2, L3 |
| `status` | Progress update | L2, L3 |
| `blocker` | Something blocking work, needs resolution from above | L2, L3 |
| `decision` | Resolution of a question or blocker | L1, L2 |
| `report` | Final synthesized output from a completed phase | L2 |

### Cross-Provider Dynamic Routing

The MCP server assigns models to workstreams and returns a `subagent_type` that maps directly to an agent name. No model names are hardcoded. When workers spawn sub-agents, they are required to dispatch to a different provider than themselves:

```
worker-anthropic (Claude)  -->  spawns worker-openai (GPT) + worker-gemini (Gemini)
worker-openai (GPT)        -->  spawns worker-anthropic (Claude) + worker-gemini (Gemini)
worker-gemini (Gemini)     -->  spawns worker-anthropic (Claude) + worker-openai (GPT)
```

This enforces the diversity condition from §3.1 of the paper at the execution layer.

### Execution Tiers

The orchestrator selects a tier based on task complexity at initialization:

| Tier | Phases | Use Case |
|------|--------|----------|
| `duo` | 3 | Single-file fixes |
| `trio` | 8 | Medium features, refactoring |
| `full-swarm` | 17 | Complex features, security-critical, multi-domain |
| `blitz` | 13 | Large-scale overhauls, 50+ file codebases |
| `debate` | 5 | Architecture decisions, design ambiguity |
| `unleashed` | 18 | Maximum scale, up to 32 parallel agents |

### Debate Protocol

When agents disagree and the disagreement cannot be resolved by their immediate supervisor, a structured adversarial debate is triggered:

```
Round N:
  1. POSITION   -- Each debater states their approach (parallel)
  2. CRITIQUE   -- Each debater critiques the others (parallel)
  3. REBUTTAL   -- Each debater defends against critiques (parallel)
  4. EVALUATE   -- Check for convergence and sycophancy

Converged  -->  SYNTHESIZE
Stalled    -->  ESCALATE to parent level
Max rounds -->  Forced ESCALATION
```

The system detects sycophancy (agents agreeing without genuine critique) using signal detection: rebuttal collapse, hollow agreement markers, soft critique ratios, and position mimicry. When sycophancy is detected, a contrarian is assigned to force rigorous challenge.

---

## Key Features

- **No central controller** — cooperation emerges from peer observation and mutual shaping pressure, not top-down instruction
- **Cross-provider diversity** — Claude, GPT, and Gemini models participate in every workstream; provider homogeneity is prohibited at the sub-agent level
- **Quality convergence gate** — phases do not close until all agents score 7/10 or above; low-scoring agents receive peer critique and revise
- **Structured debate system** — disagreements escalate through a position/critique/rebuttal protocol with anti-sycophancy detection
- **Narrow context windows** — each agent sees only what it needs; managers maintain coherence instead of broadcasting everything to everyone
- **Typed board communication** — all inter-agent messages are typed (`plan`, `finding`, `blocker`, `decision`, `report`) and filtered by level and group
- **Dynamic model routing** — model assignments are resolved at runtime by the MCP server; adding new models requires no config changes
- **Six execution tiers** — from a 3-phase duo to an 18-phase unleashed run with 32 parallel agents

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.x |
| Runtime | Node.js 18+ |
| MCP server | Model Context Protocol (streamable-http) |
| Agent runtime | OpenCode |
| MCP gateway | MCPU |
| Providers | Anthropic (Claude), OpenAI (GPT), Google (Gemini) |

---

## Getting Started

### Prerequisites

- Node.js 18 or later
- [OpenCode](https://github.com/anomalyco/opencode) installed
- [MCPU](https://github.com/nicosql/mcpu) for MCP routing
- API access to at least one of: Anthropic, OpenAI, Google AI (cross-provider diversity requires two or more)

### Setup

```bash
# Clone the repository
git clone https://github.com/schwarztim/open-swarm.git
cd open-swarm

# Build the MCP server
cd mcp-server && npm install && npm run build && cd ..

# Deploy agent configs and register MCP with MCPU
./setup.sh

# Start the MCP server
cd mcp-server && npm start &
```

### Manual Setup

```bash
# Copy agent prompts to global config
mkdir -p ~/.config/opencode/agents
cp opencode/agents/*.md ~/.config/opencode/agents/

# Copy or merge the opencode config
cp opencode/opencode.json ~/.config/opencode/opencode.json

# Register the MCP server
mcpu add open-swarm --type http --url http://127.0.0.1:38546/mcp

# Optional shell alias
echo 'alias swarm="opencode --agent swarm"' >> ~/.zshrc
```

### Running a Swarm

```bash
# Launch the orchestrator agent
opencode --agent swarm
# or with alias:
swarm
```

The orchestrator will prompt for a task, select a tier, initialize the swarm, and begin dispatching managers and workers. The session ends when all phases complete and the final quality gate passes.

### Build and Test

```bash
npm run build
npm test
npm run lint
```

---

## Project Structure

```
open-swarm/
  mcp-server/          MCP server implementation (TypeScript)
  opencode/
    agents/            Agent prompt definitions (one .md per agent)
    opencode.json      OpenCode configuration with model assignments
  docs/                Architecture and design documentation
  setup.sh             Deployment script
  ARCHITECTURE.md      Full system architecture reference
```

---

## Reference

Wołczyk, M., Weis, J., Nasser, R., et al. (2026). Cooperation Emerges from Diverse Agents Adapting to Each Other Through Anonymous Interaction History. *arXiv preprint arXiv:2602.16301*. https://arxiv.org/abs/2602.16301

---

## License

MIT. See [LICENSE](LICENSE).

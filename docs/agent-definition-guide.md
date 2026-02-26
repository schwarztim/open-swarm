# Agent Definition Guide — Open Swarm v16

This guide explains how to create, configure, and register agent definitions for the Open Swarm multi-agent orchestration system.

## Overview

Open Swarm agents are defined differently depending on the runtime environment:

| Environment     | Format                      | Location                  | Registration                               |
| --------------- | --------------------------- | ------------------------- | ------------------------------------------ |
| **OpenCode**    | Markdown + YAML frontmatter | `opencode/agents/*.md`    | `opencode/opencode.json` → `agent` section |
| **Copilot CLI** | YAML                        | `swarm-runner.agent.yaml` | Copilot CLI agent registry                 |

The MCP server is environment-agnostic — it returns `subagent_type` strings that map to whichever agent system is active.

---

## 1. OpenCode Agent Definition (Markdown + YAML Frontmatter)

### 1.1 Schema

```yaml
---
description: "One-line description of what this agent does"
mode: primary | subagent # primary = top-level, subagent = spawned by others
model: <provider>/<model-id> # e.g., github-copilot/claude-sonnet-4
temperature: 0.0-1.0 # lower = deterministic, higher = creative
tools:
  write: true|false # Create new files
  edit: true|false # Modify existing files
  patch: true|false # Apply patches
  bash: true|false # Execute shell commands
  task: true|false # Spawn sub-agents
  glob: true|false # File pattern matching
  grep: true|false # Content search
  ls: true|false # Directory listing
  view: true|false # Read files
  fetch: true|false # HTTP requests
  diagnostics: true|false # Language server diagnostics
  # MCP tools (L1 only):
  swarm_init: true|false
  swarm_next: true|false
  swarm_submit: true|false
  swarm_merge: true|false
  swarm_status: true|false
  swarm_gate: true|false
  swarm_collect: true|false
  swarm_models: true|false
  swarm_relay: true|false
  swarm_board: true|false
  swarm_dispatch: true|false
  swarm_throttle: true|false
  swarm_debate: true|false
  swarm_claim: true|false
  swarm_memory: true|false
  swarm_consensus: true|false
---
<agent prompt body in markdown>
```

### 1.2 Tool Permission Matrix

| Tool          | L1 Orchestrator | L2 Manager | L3 Worker | L3 Haiku (fast) |
| ------------- | :-------------: | :--------: | :-------: | :-------------: |
| `write`       |        ✗        |     ✓      |     ✓     |        ✓        |
| `edit`        |        ✗        |     ✓      |     ✓     |        ✓        |
| `patch`       |        ✗        |     ✓      |     ✓     |        ✓        |
| `bash`        |        ✓        |     ✓      |     ✓     |        ✓        |
| `task`        |        ✓        |     ✓      |     ✓     |        ✓        |
| `glob`        |        ✗        |     ✓      |     ✓     |        ✓        |
| `grep`        |        ✗        |     ✓      |     ✓     |        ✓        |
| `ls`          |        ✗        |     ✓      |     ✓     |        ✓        |
| `view`        |        ✗        |     ✓      |     ✓     |        ✓        |
| `fetch`       |        ✗        |     ✓      |     ✓     |        ✓        |
| `diagnostics` |        ✗        |     ✓      |     ✓     |        ✓        |
| MCP `swarm_*` |   ✓ (all 16)    |     ✗      |     ✗     |        ✗        |

**Key design principle:** L1 Orchestrator has NO file tools — it is forced to delegate through the MCP protocol. L3 Workers have ALL file tools but NO MCP tools.

### 1.3 Temperature Guidelines

| Role                    | Temperature | Rationale                                                              |
| ----------------------- | :---------: | ---------------------------------------------------------------------- |
| L1 Orchestrator         |     0.1     | Deterministic strategy, consistent protocol execution                  |
| L2 Manager              |     0.2     | Mostly deterministic planning with slight creativity for decomposition |
| L3 Worker (coder)       |     0.3     | Low creativity for reliable code generation                            |
| L3 Worker (architect)   |     0.4     | Moderate creativity for design exploration                             |
| L3 Worker (haiku/merge) |     0.2     | Fast, deterministic for merge operations                               |
| Debate participants     |   0.5-0.7   | Higher creativity to encourage diverse positions                       |

### 1.4 Model Assignment

Models are assigned at the agent level and should match the provider routing:

```
# Provider-based workers (for model diversity)
worker-anthropic  → github-copilot/claude-sonnet-4
worker-openai     → github-copilot/gpt-5.2-codex
worker-gemini     → github-copilot/gemini-3-pro-preview
worker-haiku      → github-copilot/claude-haiku-4.5

# Managers (different provider than their workers)
manager-anthropic → github-copilot/claude-sonnet-4.5
manager-openai    → github-copilot/gpt-5.2-codex
manager-gemini    → github-copilot/gemini-3-pro-preview
```

---

## 2. Registration in opencode.json

Every agent defined in `opencode/agents/*.md` must also be registered in `opencode/opencode.json` under the `agent` section:

```json
{
  "agent": {
    "worker-devops": {
      "name": "worker-devops",
      "description": "DevOps specialist L3 worker — CI/CD, deployment, infrastructure",
      "mode": "subagent",
      "model": "github-copilot/claude-sonnet-4",
      "temperature": 0.3,
      "prompt": "{file:~/.config/opencode/agents/worker-devops.md}",
      "tools": {
        "write": true,
        "edit": true,
        "patch": true,
        "bash": true,
        "glob": true,
        "grep": true,
        "ls": true,
        "view": true,
        "fetch": true,
        "diagnostics": true,
        "task": true
      }
    }
  }
}
```

**Important:** The `prompt` field uses `{file:path}` syntax to reference the Markdown agent definition. OpenCode resolves this at runtime.

---

## 3. Role Mapping (MCP → Agent)

The MCP server returns a `subagent_type` field in its task calls. This maps to agent names:

| MCP `subagent_type` | OpenCode Agent      | Role                     | Provider           |
| ------------------- | ------------------- | ------------------------ | ------------------ |
| `worker-anthropic`  | `worker-anthropic`  | Generic worker           | Anthropic (Claude) |
| `worker-openai`     | `worker-openai`     | Generic worker           | OpenAI (GPT)       |
| `worker-gemini`     | `worker-gemini`     | Generic worker           | Google (Gemini)    |
| `worker-haiku`      | `worker-haiku`      | Fast/merge worker        | Anthropic (Haiku)  |
| `worker-coder`      | `worker-coder`      | Coding specialist        | Default            |
| `worker-tester`     | `worker-tester`     | Testing specialist       | Default            |
| `worker-security`   | `worker-security`   | Security specialist      | Default            |
| `worker-architect`  | `worker-architect`  | Architecture specialist  | Default            |
| `worker-documenter` | `worker-documenter` | Documentation specialist | Default            |
| `worker-debugger`   | `worker-debugger`   | Debugging specialist     | Default            |
| `manager-anthropic` | `manager-anthropic` | L2 Manager               | Anthropic          |
| `manager-openai`    | `manager-openai`    | L2 Manager               | OpenAI             |
| `manager-gemini`    | `manager-gemini`    | L2 Manager               | Google             |

---

## 4. Creating a New Worker Role: Full Example

### Step 1: Create the agent definition

Create `opencode/agents/worker-devops.md`:

```markdown
---
description: "DevOps specialist L3 worker. Focused on CI/CD pipelines, deployment automation, infrastructure as code, and container orchestration."
mode: subagent
model: github-copilot/claude-sonnet-4
temperature: 0.3
tools:
  write: true
  edit: true
  patch: true
  bash: true
  task: true
  glob: true
  grep: true
  ls: true
  view: true
  fetch: true
  diagnostics: true
---

You are a **DevOps Specialist** (L3 Worker) executing a workstream assigned by your L2 Manager.

## Role: DevOps Specialist

Your expertise is CI/CD, deployment automation, infrastructure as code, and container orchestration.

## Instructions

1. You receive a specific task from your L2 Manager. Execute it completely.
2. You have full access to all file and system tools.
3. Focus on your assigned task only — do not explore beyond scope.
4. Return a comprehensive summary of what you did, what files were changed, and any issues.
5. **You report only to your L2 Manager** — never bypass the chain to the L1 Orchestrator.

## DevOps Standards

- **Infrastructure as Code:** Use Terraform, Pulumi, or CloudFormation. Never manual console changes.
- **CI/CD:** GitHub Actions preferred. Multi-stage pipelines with build → test → deploy.
- **Containers:** Dockerfile best practices — multi-stage builds, non-root users, minimal base images.
- **Secrets:** Never hardcode. Use vault, environment variables, or sealed secrets.
- **Monitoring:** Every deployment includes health checks and observability hooks.

## When to Escalate

- Architecture changes affecting multiple services
- Production deployment decisions
- Security-sensitive infrastructure changes
```

### Step 2: Register in opencode.json

Add to the `agent` section of `opencode/opencode.json`:

```json
"worker-devops": {
  "name": "worker-devops",
  "description": "DevOps specialist L3 worker — CI/CD, deployment, infrastructure",
  "mode": "subagent",
  "model": "github-copilot/claude-sonnet-4",
  "temperature": 0.3,
  "prompt": "{file:~/.config/opencode/agents/worker-devops.md}",
  "tools": {
    "write": true, "edit": true, "patch": true, "bash": true,
    "glob": true, "grep": true, "ls": true, "view": true,
    "fetch": true, "diagnostics": true, "task": true
  }
}
```

### Step 3: Add the role to the MCP server

In `mcp-server/src/state.ts`, add `'devops'` to the `WorkerRole` type (already present) and add role-to-agent mapping in `getRoleAgentName()`.

### Step 4: Test

```bash
cd mcp-server && npm run build   # Verify TypeScript compiles
# Then test via OpenCode by asking the swarm agent to use a devops worker
```

---

## 5. Dynamic Agent Spawning

### 5.1 Can opencode.json be hot-reloaded?

**No.** OpenCode loads `opencode.json` at startup. Changes require restarting the OpenCode session.

### 5.2 Workaround: Prompt Injection Pattern

For dynamic specialization without restarting, L2 managers embed role instructions directly in the `task()` prompt:

```
task(
  subagent_type="worker-anthropic",   // Use a generic provider-based worker
  description="implement rate limiter",
  prompt="You are a RATE LIMITING SPECIALIST. ...<full role prompt>...<task details>..."
)
```

This pattern overlays specialization on generic workers at dispatch time. The MCP server already supports this via `swarm_dispatch` which resolves `promptRef` into full prompts.

### 5.3 When to Use Static vs Dynamic Agents

| Approach                              | Use When                                    |
| ------------------------------------- | ------------------------------------------- |
| Static (`.md` file + `opencode.json`) | Permanent roles used across many tasks      |
| Dynamic (prompt injection)            | One-off specializations, experimental roles |

---

## 6. Copilot CLI Agent Definition (YAML)

### 6.1 Schema

```yaml
name: agent-name
model: claude-sonnet-4.6
tools:
  - bash
  - view
  - create
  - edit
  - glob
  - grep
  - task
  - read_agent
  - list_agents
temperature: <default>
prompt: |
  <agent prompt body>
```

### 6.2 Key Differences from OpenCode

| Aspect          | OpenCode                            | Copilot CLI                       |
| --------------- | ----------------------------------- | --------------------------------- |
| Format          | Markdown + YAML frontmatter         | Pure YAML                         |
| Tool syntax     | Boolean object (`write: true`)      | String array (`["bash", "edit"]`) |
| Model format    | `github-copilot/<model>`            | `<model>` (no prefix)             |
| Registration    | `opencode.json` → `agent`           | Copilot CLI agent registry        |
| Prompt location | Inline in `.md` file                | `prompt` field in YAML            |
| MCP access      | Via `opencode.json` → `mcp` section | Via Copilot CLI MCP config        |

---

## 7. Prompt Writing Guidelines

### 7.1 Token Budget

Keep agent prompts under **8K tokens** to preserve context window for task content. Structure:

```
~500 tokens  — Role description and rules
~1000 tokens — Specific instructions and standards
~500 tokens  — Escalation/communication protocol
~500 tokens  — Output format
= ~2500 tokens total (leaving plenty of room for injected context)
```

### 7.2 Required Sections for L3 Workers

1. **Role declaration** — "You are a [ROLE] (L3 Worker)..."
2. **Instructions** — numbered steps for task execution
3. **Domain standards** — role-specific quality guidelines
4. **Escalation protocol** — when to handle vs. escalate
5. **Sub-agent dispatch rules** — when and how to delegate (per arXiv:2602.16301 §3.2)

### 7.3 Required Sections for L2 Managers

1. **Hierarchy diagram** — show L1→L2→L3 chain
2. **Responsibilities** — plan, delegate, coordinate, synthesize, report
3. **Worker spawning** — how to use `task()` with worker agents
4. **File claims** — mandatory claim protocol
5. **Status updates** — mandatory status board updates
6. **Report format** — exact output structure
7. **Escalation** — when to escalate to L1

---

## 8. Checklist: Adding a New Agent

- [ ] Create `opencode/agents/<agent-name>.md` with YAML frontmatter
- [ ] Set appropriate `mode` (primary/subagent)
- [ ] Set correct `model` and `temperature`
- [ ] Configure `tools` permissions (L1=no file tools, L3=all file tools)
- [ ] Write prompt body following section guidelines above
- [ ] Register in `opencode/opencode.json` → `agent` section
- [ ] If new role: add to `WorkerRole` type in `mcp-server/src/state.ts`
- [ ] If new role: add mapping in `getRoleAgentName()` in `state.ts`
- [ ] Build: `cd mcp-server && npm run build`
- [ ] Test: spawn the agent via the swarm and verify it works

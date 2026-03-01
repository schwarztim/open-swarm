// ── Workstream Management ─────────────────────────────────────────────
// Workstream dependency resolution and grouping.

import type { SwarmSession, Workstream, AgentGroup, WorkerSlot, WorkerMode } from "./swarm-types.js";
import {
  resolveModel,
  getAvailableModels,
  getModelProvider,
  coderPool,
} from "./model-registry.js";
import { getManagerAgentName, getRoleAgentName, inferWorkerRole } from "./agent-naming.js";
import { classifyTaskComplexity, getModelForComplexity } from "./tier-selection.js";

// ── Manager Definitions ───────────────────────────────────────────────

const MANAGER_AGENT_DEFS: Array<{
  agent: string;
  model: string;
  provider: string;
}> = [
  {
    agent: "manager-anthropic",
    model: "claude-sonnet-4.6",
    provider: "anthropic",
  },
  {
    agent: "manager-openai",
    model: "gpt-4.1",
    provider: "openai",
  },
  {
    agent: "manager-gemini",
    model: "gemini-2.5-pro",
    provider: "google",
  },
];

/** Get a validated manager definition — resolves model with fallback */
function getValidManagerDef(index: number): {
  agent: string;
  model: string;
  provider: string;
} {
  const def = MANAGER_AGENT_DEFS[index % MANAGER_AGENT_DEFS.length];
  const resolved = resolveModel(def.model);
  const resolvedProvider = getModelProvider(resolved);
  const agent =
    resolvedProvider !== "unknown" ? getManagerAgentName(resolved) : def.agent;
  return {
    agent,
    model: resolved,
    provider: resolvedProvider !== "unknown" ? resolvedProvider : def.provider,
  };
}

// Workers assigned to each manager should use DIFFERENT providers than the manager
function getWorkerModelsForManager(
  managerProvider: string,
  workerCount: number,
): string[] {
  const availableModels = getAvailableModels();
  const otherModels = coderPool.filter((m) => {
    const entry = availableModels.find((am: { id: string }) => am.id === m);
    return entry && entry.provider !== managerProvider;
  });
  const allModels = otherModels.length > 0 ? otherModels : coderPool;
  const result: string[] = [];
  for (let i = 0; i < workerCount; i++) {
    result.push(resolveModel(allModels[i % allModels.length]));
  }
  return result;
}

// ── Workstream Dependency Helpers ──────────────────────────────────────

export function updateReadyWorkstreams(session: SwarmSession): void {
  for (const ws of session.workstreams) {
    if (ws.status !== "pending") continue;
    const depsReady = ws.dependencies.every((depId) => {
      const dep = session.workstreams.find((w) => w.id === depId);
      return dep && dep.status === "done";
    });
    if (depsReady) ws.status = "ready";
  }
}

export function getReadyWorkstreams(session: SwarmSession): Workstream[] {
  updateReadyWorkstreams(session);
  return session.workstreams.filter((ws) => ws.status === "ready");
}

export function getBlockedWorkstreams(session: SwarmSession): Workstream[] {
  return session.workstreams.filter((ws) => {
    if (ws.status !== "pending") return false;
    return ws.dependencies.some((depId) => {
      const dep = session.workstreams.find((w) => w.id === depId);
      return !dep || dep.status !== "done";
    });
  });
}

export function groupWorkstreams(session: SwarmSession): AgentGroup[] {
  const wsCount = session.workstreams.length;
  if (wsCount === 0) return [];

  let workersPerGroup: number;
  if (wsCount <= 4) workersPerGroup = 2;
  else if (wsCount <= 12) workersPerGroup = 3;
  else workersPerGroup = 4;

  const groupCount = Math.ceil(wsCount / workersPerGroup);
  const groups: AgentGroup[] = [];

  for (let g = 0; g < groupCount; g++) {
    const managerDef = getValidManagerDef(g);
    const startIdx = g * workersPerGroup;
    const endIdx = Math.min(startIdx + workersPerGroup, wsCount);
    const groupWorkstreamSlice = session.workstreams.slice(startIdx, endIdx);

    const workerModels = getWorkerModelsForManager(
      managerDef.provider,
      groupWorkstreamSlice.length,
    );

    const workerSlots: WorkerSlot[] = groupWorkstreamSlice.map((ws, i) => {
      const role = inferWorkerRole(ws.description);
      const complexity = classifyTaskComplexity(ws.description, ws.files);
      const model = resolveModel(getModelForComplexity(complexity, i));
      return {
        workstreamId: ws.id,
        agentType: getRoleAgentName(role, model),
        model,
        description: ws.description,
        files: ws.files,
        role,
        mode: "implement" as WorkerMode,
        complexity,
      };
    });

    groups.push({
      id: `group-${g}`,
      managerAgent: managerDef.agent,
      managerModel: managerDef.model,
      workerSlots,
      plan: "",
      status: "pending",
    });
  }

  session.agentGroups = groups;
  return groups;
}

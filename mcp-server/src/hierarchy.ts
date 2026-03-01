// ── Hierarchy & Coordination ──────────────────────────────────────────
// Tier selection, workstream grouping, manager/worker naming,
// task complexity classification, drift detection, consensus protocol,
// acceptance test parsing, and verifier prompt building.

import type {
  Tier,
  SwarmSession,
  Workstream,
  AgentGroup,
  WorkerSlot,
  WorkerRole,
  WorkerMode,
  TaskComplexity,
  DriftCheck,
  ConsensusState,
  ConsensusProposal,
  AcceptanceTest,
  FileClaim,
} from "./swarm-types.js";
import {
  resolveModel,
  getModelProvider,
  getCoderModel,
  getCriticModel,
  getFastModel,
  getAvailableModels,
  premiumPool,
  coderPool,
  criticPool,
} from "./model-registry.js";

// ── Tier Auto-Selection ────────────────────────────────────────────────

export function analyzeTaskComplexity(task: string): {
  tier: Tier;
  requiresArchitect: boolean;
  requiresIntegration: boolean;
  requiresDatabase: boolean;
  requiresDevops: boolean;
  requiresAuth: boolean;
  estimatedWorkstreams: number;
} {
  const signals = {
    architect: /architect|design|system|microservice|monolith|scale/i.test(task),
    database: /database|schema|migration|prisma|drizzle|postgres|mongo|sql/i.test(task),
    auth: /auth|jwt|rbac|oauth|login|session|password|role/i.test(task),
    integration: /frontend|backend|api|react|next|express|full.?stack/i.test(task),
    devops: /deploy|docker|kubernetes|k8s|ci.?cd|pipeline|terraform/i.test(task),
    testing: /test|coverage|e2e|integration.?test/i.test(task),
  };

  const componentCount = Object.values(signals).filter(Boolean).length;

  return {
    tier: componentCount >= 4 ? "full-swarm" : componentCount >= 2 ? "trio" : "duo",
    requiresArchitect: signals.architect || componentCount >= 3,
    requiresIntegration: signals.integration || componentCount >= 2,
    requiresDatabase: signals.database,
    requiresDevops: signals.devops,
    requiresAuth: signals.auth,
    estimatedWorkstreams: Math.max(2, componentCount * 2),
  };
}

export function selectTier(taskDescription: string, fileCount?: number): Tier {
  const lower = taskDescription.toLowerCase();

  if (fileCount !== undefined && fileCount > 50) return "blitz";
  if (/massive|full app|entire codebase/.test(lower)) return "blitz";

  if (/debate|decide|which approach|tradeoff/.test(lower)) return "debate";

  if (
    /unleashed|max|pedal to the metal|no restraints|hurt|pain|destroy/.test(
      lower,
    )
  )
    return "unleashed";

  if (/refactor|security|architecture|complex/.test(lower)) return "full-swarm";

  if (/design|multi-file|feature/.test(lower)) return "trio";

  // Enterprise task detection: use complexity analysis for multi-component tasks
  const complexity = analyzeTaskComplexity(taskDescription);
  if (complexity.tier !== "duo") return complexity.tier;

  return "duo";
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

// ── 3-Tier Hierarchy: Grouping & Manager Assignment ───────────────────

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

export function getManagerAgentName(modelId: string): string {
  const provider = getModelProvider(modelId);
  switch (provider) {
    case "anthropic":
      return "manager-anthropic";
    case "openai":
      return "manager-openai";
    case "google":
      return "manager-gemini";
    default:
      return "manager-anthropic";
  }
}

export function getWorkerAgentName(modelId: string): string {
  const provider = getModelProvider(modelId);
  switch (provider) {
    case "anthropic":
      return "worker-anthropic";
    case "openai":
      return "worker-openai";
    case "google":
      return "worker-gemini";
    default:
      return "worker";
  }
}

export function getRoleAgentName(role: WorkerRole, modelId: string): string {
  const roleAgents: Record<WorkerRole, string> = {
    coder: "worker-coder",
    tester: "worker-tester",
    reviewer: "worker",
    security: "worker-security",
    architect: "worker-architect",
    documenter: "worker-documenter",
    debugger: "worker-debugger",
    devops: "worker-devops",
    integration: "worker-integration",
    database: "worker-database",
    auth: "worker-auth",
    "meta-worker": "worker",
  };
  return roleAgents[role] ?? getWorkerAgentName(modelId);
}

export function classifyTaskComplexity(
  description: string,
  files: string[],
): TaskComplexity {
  const lower = description.toLowerCase();

  if (/\breview\b|\baudit\b|\bcheck\b|\binspect\b|\bvalidate\b/.test(lower)) {
    return "review";
  }

  if (
    /\bsecurity\b|\bvulnerab|\barchitect|\bdesign\b|\bscalabil|\bperformance\b|\bmigrat|\brefactor\b/.test(
      lower,
    )
  ) {
    return "complex";
  }

  if (files.length > 5) {
    return "complex";
  }

  if (
    /\bdoc\b|\breadme\b|\bcomment\b|\brename\b|\bconfig\b|\bformat\b|\btypo\b|\bfix\s+typo\b/.test(
      lower,
    )
  ) {
    return "trivial";
  }

  return "standard";
}

export function inferWorkerRole(description: string): WorkerRole {
  const lower = description.toLowerCase();

  if (
    /\btest\b|\bspec\b|\bcoverage\b|\bunit test\b|\bintegration test\b/.test(
      lower,
    )
  )
    return "tester";
  if (/\breview\b|\baudit\b|\bcode review\b|\bquality\b/.test(lower))
    return "reviewer";
  if (
    /\bsecurity\b|\bvulnerab|\bencrypt\b|\bsanitiz|\binjection\b/.test(lower)
  )
    return "security";
  if (/\bauth\b|\bjwt\b|\brbac\b|\boauth\b|\blogin\b|\bsession\b|\bpassword\b|\brole\b/.test(lower))
    return "auth";
  if (
    /\barchitect|\bdesign\b|\bapi contract\b|\bschema\b|\bdata model\b/.test(
      lower,
    )
  )
    return "architect";
  if (/\bdoc\b|\breadme\b|\bchangelog\b|\bcomment\b|\bdiagram\b/.test(lower))
    return "documenter";
  if (
    /\bdebug\b|\broot cause\b|\bbisect\b|\breproducg?\b|\bstack trace\b|\bfix\b.*\bbug\b/.test(
      lower,
    )
  )
    return "debugger";
  if (
    /\bdeploy\b|\bci\/cd\b|\bdocker\b|\bpipeline\b|\binfra\b|\bterraform\b|\bkubernetes\b|\bk8s\b/.test(
      lower,
    )
  )
    return "devops";
  if (
    /\bdatabase\b|\bschema\b|\bmigration\b|\bprisma\b|\bdrizzle\b|\bpostgres\b|\bmongo\b|\bsql\b|\borm\b/.test(
      lower,
    )
  )
    return "database";
  if (
    /\bintegration\b|\bwire\b|\bapi client\b|\bfrontend.backend\b|\bfull.?stack\b/.test(
      lower,
    )
  )
    return "integration";

  return "coder";
}

export function getModelForComplexity(
  complexity: TaskComplexity,
  index: number,
): string {
  switch (complexity) {
    case "trivial":
      return getFastModel(index);
    case "standard":
      return getCoderModel(index);
    case "complex":
      return premiumPool.length > 0
        ? premiumPool[index % premiumPool.length]
        : getCoderModel(index);
    case "review":
      return getCriticModel(index);
  }
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

// ── Anti-Drift Detection ──────────────────────────────────────────────

export const DRIFT_THRESHOLD = 0.3;

/** Extract bigrams from a token array. */
function driftBigrams(tokens: string[]): Set<string> {
  const bg = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    bg.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bg;
}

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? inter.length / union.size : 0;
}

export function checkDrift(taskGoal: string, output: string): DriftCheck {
  const goalTokens = taskGoal
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 3);
  const outputTokens = output
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 3);

  const goalSet = new Set(goalTokens);
  const outputSet = new Set(outputTokens);

  let unigramOverlap = 0;
  for (const token of goalSet) {
    if (outputSet.has(token)) unigramOverlap++;
  }
  const unigramScore = goalSet.size > 0 ? unigramOverlap / goalSet.size : 1;

  const goalBigrams = driftBigrams(goalTokens);
  const outputBigrams = driftBigrams(outputTokens);
  const bigramScore = jaccard(goalBigrams, outputBigrams);

  const alignmentScore =
    goalSet.size > 0 ? 0.6 * unigramScore + 0.4 * bigramScore : 1;

  const driftSignals: string[] = [];

  if (alignmentScore < DRIFT_THRESHOLD) {
    driftSignals.push("Output has very low keyword overlap with original task");
  }

  if (output.length < taskGoal.length * 0.5 && output.length < 200) {
    driftSignals.push(
      "Output is much shorter than expected for the task scope",
    );
  }

  const scopeCreepPatterns =
    /\b(also|additionally|while I was at it|bonus|extra|unrelated)\b/gi;
  const scopeMatches = output.match(scopeCreepPatterns);
  if (scopeMatches && scopeMatches.length >= 2) {
    driftSignals.push(
      `Possible scope creep detected (${scopeMatches.length} tangential markers)`,
    );
  }

  const outputSummary =
    output.substring(0, 200) + (output.length > 200 ? "..." : "");

  return { taskGoal, outputSummary, alignmentScore, driftSignals };
}

// ── Worker Consensus Protocol ─────────────────────────────────────────

let consensusCounter = 0;

export function createConsensus(
  session: SwarmSession,
  groupId: string,
  topic: string,
): ConsensusState {
  const consensus: ConsensusState = {
    id: `consensus-${++consensusCounter}`,
    sessionId: session.id,
    groupId,
    topic,
    proposals: [],
    status: "collecting",
    createdAt: Date.now(),
  };
  session.consensuses.push(consensus);
  return consensus;
}

export function getConsensus(
  session: SwarmSession,
  id: string,
): ConsensusState | undefined {
  return session.consensuses.find((c) => c.id === id);
}

export function submitProposal(
  consensus: ConsensusState,
  workstreamId: string,
  slotId: string,
  model: string,
  content: string,
): void {
  consensus.proposals.push({
    workstreamId,
    slotId,
    model,
    content,
    submittedAt: Date.now(),
  });
}

export function evaluateConsensus(consensus: ConsensusState): {
  convergenceScore: number;
  recommendation: "implement-best" | "debate" | "need-more-proposals";
} {
  if (consensus.proposals.length < 2) {
    return { convergenceScore: 0, recommendation: "need-more-proposals" };
  }

  const tokenSets = consensus.proposals.map(
    (p) =>
      new Set(
        p.content
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 3),
      ),
  );

  let totalSim = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const intersection = [...tokenSets[i]].filter((t) =>
        tokenSets[j].has(t),
      ).length;
      const union = new Set([...tokenSets[i], ...tokenSets[j]]).size;
      totalSim += union > 0 ? intersection / union : 0;
      pairs++;
    }
  }
  const convergenceScore = pairs > 0 ? totalSim / pairs : 0;
  consensus.convergenceScore = convergenceScore;

  if (convergenceScore >= 0.6) {
    consensus.status = "decided";
    return { convergenceScore, recommendation: "implement-best" };
  } else {
    return { convergenceScore, recommendation: "debate" };
  }
}

// ── Acceptance Test Parsing ────────────────────────────────────────────

export function parseAcceptanceTests(
  task: string,
): Map<string, AcceptanceTest[]> {
  const result = new Map<string, AcceptanceTest[]>();
  const blockMatch = task.match(
    /ACCEPTANCE_TESTS:\s*\n([\s\S]*?)(?:\n(?=[A-Z_]+:)|\n---|\n$|$)/,
  );
  if (!blockMatch) return result;

  const block = blockMatch[1];
  const wsRegex = /^(\S+):\s*$/gm;
  let match: RegExpExecArray | null;
  const wsPositions: Array<{ id: string; start: number }> = [];
  while ((match = wsRegex.exec(block)) !== null) {
    wsPositions.push({ id: match[1], start: match.index + match[0].length });
  }

  for (let i = 0; i < wsPositions.length; i++) {
    const end =
      i + 1 < wsPositions.length ? wsPositions[i + 1].start : block.length;
    const wsBlock = block.substring(wsPositions[i].start, end);
    const tests: AcceptanceTest[] = [];

    const testRegex =
      /- name:\s*"([^"]+)"\s+command:\s*"([^"]+)"\s+expect:\s*"([^"]+)"(?:\s+category:\s*"([^"]+)")?/g;
    let testMatch: RegExpExecArray | null;
    while ((testMatch = testRegex.exec(wsBlock)) !== null) {
      tests.push({
        name: testMatch[1],
        command: testMatch[2],
        expect: testMatch[3],
        category: (testMatch[4] as AcceptanceTest["category"]) ?? "integration",
      });
    }

    if (tests.length > 0) {
      result.set(wsPositions[i].id, tests);
    }
  }

  return result;
}

// ── Verifier Model Selection ──────────────────────────────────────────

export function getVerifierModel(builderModel: string, index: number): string {
  const builderProvider = getModelProvider(builderModel);
  const candidates = criticPool.filter(
    (m) => getModelProvider(m) !== builderProvider,
  );
  if (candidates.length > 0) return candidates[index % candidates.length];
  return criticPool[index % criticPool.length];
}

// ── Verifier Prompt Builder ───────────────────────────────────────────

export function buildVerifierPrompt(
  session: SwarmSession,
  workstream: Workstream,
  tests: AcceptanceTest[],
): string {
  const testList = tests
    .map(
      (t, i) =>
        `  ${i + 1}. ${t.name}\n     Command: ${t.command}\n     Expect: ${t.expect}\n     Category: ${t.category}`,
    )
    .join("\n");

  return [
    `=== VALIDATION TASK ===`,
    `You are an independent verifier. Your job is to run acceptance tests against the project.`,
    `You did NOT build this code — you are testing it from the outside.`,
    ``,
    `Project task: ${session.task}`,
    `Workstream: ${workstream.id} — ${workstream.description}`,
    `Files: ${workstream.files.join(", ") || "See project root"}`,
    ``,
    `=== STARTUP ===`,
    `1. Detect the project type from files (package.json → npm, setup.py → pip, go.mod → go, docker-compose.yml → docker)`,
    `2. Install dependencies if needed`,
    `3. Start the application (npm run dev / docker compose up -d / uvicorn / etc.)`,
    `4. Wait for the app to be ready (retry health check for up to 30s)`,
    ``,
    `=== ACCEPTANCE TESTS ===`,
    testList,
    ``,
    `=== EXECUTION ===`,
    `For each test:`,
    `- Run the command`,
    `- Compare output against the expect condition:`,
    `  - "status_code:NNN" → check HTTP status code`,
    `  - "exit_code:N" → check command exit code`,
    `  - "json:.field == value" → check JSON field in response`,
    `  - "contains:text" → check output contains text`,
    `- Record pass/fail with actual vs expected`,
    ``,
    `=== REPORTING ===`,
    `After running all tests, output a structured block:`,
    ``,
    `VALIDATION_RESULT:`,
    `{`,
    `  "workstream": "${workstream.id}",`,
    `  "results": [`,
    `    { "name": "test name", "category": "integration", "status": "pass|fail|skip|error", "actual": "...", "expected": "...", "error": "..." }`,
    `  ]`,
    `}`,
    ``,
    `Then shut down any processes you started.`,
  ].join("\n");
}

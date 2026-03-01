import {
  type Tier,
  type ExecutionMode,
  type RatePreset,
  TIER_PHASES,
  RATE_PRESETS,
  resolveRateLimit,
  createSession,
  selectTier,
  analyzeTaskComplexity,
  getCoderModel,
  getRateLimitStatus,
  parseAcceptanceTests,
  sessions,
} from "../state.js";
import { retrieve } from "../learning.js";
import { ok, validateString, type ToolResult } from "./shared.js";

// ── swarm_init ────────────────────────────────────────────────────────

export async function handleSwarmInit(args: {
  task: string;
  tier?: Tier;
  fileCount?: number;
  executionMode?: ExecutionMode;
  concurrency?: number | string; // number or preset name
  cleanSlate?: boolean;
}): Promise<ToolResult> {
  const taskValidation = validateString(args.task, "task");
  if (typeof taskValidation !== "string") return taskValidation;
  const task = taskValidation;
  const { fileCount } = args;

  const tier = args.tier ?? selectTier(task, fileCount);

  // Run complexity analysis for enterprise task detection
  const complexityAnalysis = analyzeTaskComplexity(task);
  // If no explicit tier was given and complexity analysis suggests a higher tier, use it
  const resolvedTier: Tier = args.tier
    ? tier
    : complexityAnalysis.tier === "full-swarm" && tier === "duo"
      ? "full-swarm"
      : complexityAnalysis.tier === "trio" && tier === "duo"
        ? "trio"
        : tier;

  // Resolve concurrency: accept a preset name ("conservative", "standard", etc.) or a number
  let resolvedConcurrency: number;
  if (args.concurrency === undefined || args.concurrency === null) {
    resolvedConcurrency = resolveRateLimit(undefined);
  } else if (
    typeof args.concurrency === "string" &&
    args.concurrency in RATE_PRESETS
  ) {
    resolvedConcurrency = resolveRateLimit(args.concurrency as RatePreset);
  } else {
    resolvedConcurrency = resolveRateLimit(Number(args.concurrency));
  }

  const session = createSession(
    resolvedTier,
    task,
    args.executionMode,
    resolvedConcurrency,
  );
  const phaseDefs = TIER_PHASES[resolvedTier];

  // WS6a: Check for existing sessions with same task (prior run detection)
  const STALE_PATHS = [
    "FINAL_REPORT.md",
    "COMPLETION_SUMMARY.txt",
    "CRITICAL_STUBS_FIXED.md",
    "FIXES_SUMMARY.txt",
  ];
  let priorRunWarning:
    | { sessionId: string; message: string; stalePaths: string[] }
    | undefined;
  const priorSession = Array.from(sessions.values()).find(
    (s) => s.id !== session.id && s.task === task,
  );
  if (priorSession) {
    priorRunWarning = {
      sessionId: priorSession.id,
      message: `Prior session "${priorSession.id}" found for this task. Stale artifacts may exist.`,
      stalePaths: STALE_PATHS,
    };
  }

  // WS6b: Clean slate — delete stored prompts from prior sessions with the same task
  let cleanSlateApplied = false;
  if (args.cleanSlate === true) {
    for (const [, s] of sessions) {
      if (s.id !== session.id && s.task === task) {
        s.promptStore.clear();
      }
    }
    cleanSlateApplied = true;
  }

  // Seed default workstreams for parallel tiers
  const hasParallel = phaseDefs.some((p) => p.parallel);
  if (hasParallel && session.workstreams.length === 0) {
    let count = 2;
    if (resolvedTier === "unleashed") count = 32;
    else if (resolvedTier === "blitz" || (fileCount && fileCount > 20)) count = 4;
    else if (complexityAnalysis.estimatedWorkstreams > 2) count = Math.min(complexityAnalysis.estimatedWorkstreams, 8);

    for (let i = 0; i < count; i++) {
      session.workstreams.push({
        id: `ws-${i}`,
        description: `Workstream ${i}`,
        files: [],
        modelAssigned: getCoderModel(i),
        dependencies: [],
        status: "ready",
      });
    }
  }

  // Parse and attach acceptance tests from task prompt
  const acceptanceTests = parseAcceptanceTests(task);
  let acceptanceTestInfo:
    | { workstreamsWithTests: number; totalTests: number }
    | undefined;
  for (const [wsId, tests] of acceptanceTests) {
    const ws = session.workstreams.find((w) => w.id === wsId);
    if (ws) ws.acceptanceTests = tests;
  }
  if (acceptanceTests.size > 0) {
    let totalTests = 0;
    for (const tests of acceptanceTests.values()) totalTests += tests.length;
    acceptanceTestInfo = {
      workstreamsWithTests: acceptanceTests.size,
      totalTests,
    };
  }

  // Build rate limit info for response
  const matchedPreset = Object.entries(RATE_PRESETS).find(
    ([_, v]) => v.concurrency === resolvedConcurrency,
  );
  const rateLimitInfo = {
    concurrency: resolvedConcurrency > 0 ? resolvedConcurrency : "unlimited",
    preset: matchedPreset ? matchedPreset[0] : "custom",
    maxEstimatedAgents:
      resolvedConcurrency > 0 ? resolvedConcurrency * 5 : "unlimited",
    description: matchedPreset
      ? matchedPreset[1].description
      : `Custom: ${resolvedConcurrency} concurrent L2 managers`,
    recommendedPlan: matchedPreset ? matchedPreset[1].plan : "depends on usage",
  };

  // Auto-retrieve relevant patterns from learning memory
  let priorPatterns:
    | { matchCount: number; injectionContext: string; patternIds: string[] }
    | undefined;
  try {
    const retrieved = await retrieve(session.id, task);
    if (retrieved.patterns.length > 0) {
      session.patternIdsUsed = retrieved.patternIds;
      priorPatterns = {
        matchCount: retrieved.patterns.length,
        injectionContext: retrieved.injectionContext,
        patternIds: retrieved.patternIds,
      };
    }
  } catch {
    // Learning retrieval is best-effort
  }

  return ok({
    sessionId: session.id,
    tier: resolvedTier,
    totalPhases: phaseDefs.length,
    firstPhase: phaseDefs[0].name,
    executionMode: session.executionMode,
    rateLimit: rateLimitInfo,
    apiRateLimits: getRateLimitStatus(session.id),
    priorPatterns,
    priorRunWarning,
    cleanSlate: cleanSlateApplied ? true : undefined,
    acceptanceTests: acceptanceTestInfo,
    complexityAnalysis: {
      requiresArchitect: complexityAnalysis.requiresArchitect,
      requiresIntegration: complexityAnalysis.requiresIntegration,
      requiresDatabase: complexityAnalysis.requiresDatabase,
      requiresDevops: complexityAnalysis.requiresDevops,
      requiresAuth: complexityAnalysis.requiresAuth,
      estimatedWorkstreams: complexityAnalysis.estimatedWorkstreams,
    },
    availablePresets: Object.fromEntries(
      Object.entries(RATE_PRESETS).map(([k, v]) => [
        k,
        { concurrency: v.concurrency, agents: v.maxAgents, plan: v.plan },
      ]),
    ),
    outputDir:
      session.executionMode === "subprocess" ? session.outputDir : undefined,
    nextAction: `Call swarm_next with sessionId "${session.id}" to get the first task.`,
  });
}

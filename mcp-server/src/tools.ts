import {
  type Tier,
  type ExecutionMode,
  type RatePreset,
  type PhaseDefinition,
  type SwarmSession,
  type PhaseState,
  type BoardMessage,
  type AgentGroup,
  type DebateState,
  type DebatePhase,
  type DebateTrigger,
  type DebateContribution,
  type DebateParticipant,
  type WorkerRole,
  type TaskComplexity,
  type WorkerMode,
  type FileClaim,
  type DriftCheck,
  type PatternEntry,
  type ConsensusState,
  type AcceptanceTest,
  type ValidationResult,
  TIER_PHASES,
  RATE_PRESETS,
  resolveRateLimit,
  resolveModel,
  resolveModelTracked,
  getFallbackLog,
  checkRateLimit,
  getRateLimitStatus,
  createSession,
  getSession,
  getPhaseDefinition,
  advancePhase,
  selectTier,
  buildAnonymousHistory,
  buildBoardContext,
  buildManagerPrompt,
  getReadyWorkstreams,
  getBlockedWorkstreams,
  groupWorkstreams,
  postToBoard,
  readBoard,
  storePrompt,
  getPrompt,
  getCoderModel,
  getAvailableModels,
  setAvailableModels,
  getModelProvider,
  getManagerAgentName,
  getWorkerAgentName,
  getRoleAgentName,
  classifyTaskComplexity,
  inferWorkerRole,
  getModelForComplexity,
  premiumPool,
  coderPool,
  criticPool,
  fastPool,
  stripIdentity,
  createDebate,
  getDebate,
  advanceDebatePhase,
  buildDebatePositionPrompt,
  buildDebateCritiquePrompt,
  buildDebateRebuttalPrompt,
  buildDebateSynthesisPrompt,
  buildEscalationContext,
  scoreDebatePositions,
  computeDebateConvergence,
  detectDebateSycophancy,
  buildDebateEvaluation,
  extractClaimsFromPositions,
  updateClaimConsensus,
  getPartialConsensus,
  checkFastTrack,
  assignContrarian,
  buildContrarianPrompt,
  createValidationCheckpoint,
  submitValidation,
  claimFiles,
  releaseFiles,
  checkFileClaims,
  getClaimsForWorkstream,
  getAllActiveClaims,
  checkDrift,
  createConsensus,
  getConsensus,
  submitProposal,
  evaluateConsensus,
  parseAcceptanceTests,
  getVerifierModel,
  buildVerifierPrompt,
  sessions,
} from "./state.js";
import { memoryStore } from "./memory.js";
import {
  retrieve,
  judge,
  distill,
  consolidate,
  route,
  getStats,
} from "./learning.js";
import {
  workerRegistry,
  TRIGGER_DESCRIPTIONS,
  WORKER_TYPE_DESCRIPTIONS,
} from "./workers.js";

// Anti-drift configuration
const DRIFT_THRESHOLD = 0.4; // Reject submissions below this alignment score (0-1)

// ── Helpers ───────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: string; text: string }> };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return ok({ error: message });
}

function buildTaskCall(
  session: SwarmSession,
  phaseDef: PhaseDefinition,
  description: string,
  prompt: string,
  model?: string,
) {
  const resolvedModel = model ?? phaseDef.model;
  const subagentType = getWorkerAgentName(resolvedModel);
  const promptRef = storePrompt(session, prompt);
  return {
    subagent_type: subagentType,
    description,
    promptRef,
  };
}

function workstreamCount(session: { workstreams: { id: string }[] }): number {
  return Math.max(session.workstreams.length, 2);
}

// ── Convergence Metrics (arXiv:2602.16301) ────────────────────────────

function computeConvergence(
  session: SwarmSession,
  currentRound: number,
  currentScores: Array<{ workstream: string; score: number }>,
) {
  const avgCurrent =
    currentScores.reduce((s, c) => s + c.score, 0) / currentScores.length;

  // Find previous round scores
  const prevRound = currentRound - 1;
  const prevScores = session.rounds.filter((r) => r.round === prevRound);
  const avgPrev =
    prevScores.length > 0
      ? prevScores.reduce((s, r) => s + r.score, 0) / prevScores.length
      : 0;

  const delta = prevScores.length > 0 ? avgCurrent - avgPrev : avgCurrent;
  const stalling = prevScores.length > 0 && Math.abs(delta) < 0.5;

  // Collect all round averages for trend
  const roundAvgs: Array<{ round: number; avg: number }> = [];
  const allRounds = new Set(session.rounds.map((r) => r.round));
  for (const r of allRounds) {
    const scores = session.rounds.filter((s) => s.round === r);
    roundAvgs.push({
      round: r,
      avg: scores.reduce((s, c) => s + c.score, 0) / scores.length,
    });
  }
  roundAvgs.push({ round: currentRound, avg: avgCurrent });
  roundAvgs.sort((a, b) => a.round - b.round);

  return {
    currentAvg: Math.round(avgCurrent * 100) / 100,
    previousAvg: prevScores.length > 0 ? Math.round(avgPrev * 100) / 100 : null,
    delta: Math.round(delta * 100) / 100,
    stalling,
    stallingWarning: stalling
      ? "Quality improvement < 0.5 across rounds. Consider changing approach or models."
      : undefined,
    trend: roundAvgs,
    totalRounds: currentRound,
  };
}

// ── swarm_init ────────────────────────────────────────────────────────

export async function handleSwarmInit(args: {
  task: string;
  tier?: Tier;
  fileCount?: number;
  executionMode?: ExecutionMode;
  concurrency?: number | string; // number or preset name
  cleanSlate?: boolean;
}): Promise<ToolResult> {
  const { task, fileCount } = args;
  if (!task) return err("Missing required field: task");

  const tier = args.tier ?? selectTier(task, fileCount);

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
    tier,
    task,
    args.executionMode,
    resolvedConcurrency,
  );
  const phaseDefs = TIER_PHASES[tier];

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
    if (tier === "unleashed") count = 32;
    else if (tier === "blitz" || (fileCount && fileCount > 20)) count = 4;

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
    tier,
    totalPhases: phaseDefs.length,
    firstPhase: phaseDefs[0].name,
    executionMode: session.executionMode,
    rateLimit: rateLimitInfo,
    apiRateLimits: getRateLimitStatus(session.id),
    priorPatterns,
    priorRunWarning,
    cleanSlate: cleanSlateApplied ? true : undefined,
    acceptanceTests: acceptanceTestInfo,
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

// ── swarm_next ────────────────────────────────────────────────────────

export function handleSwarmNext(args: {
  sessionId: string;
  workstreamIndex?: number;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  // Auto-advance past completed phases
  while (
    session.currentPhaseIndex < session.phases.length &&
    session.phases[session.currentPhaseIndex].status === "done"
  ) {
    const nextIdx = session.currentPhaseIndex + 1;
    if (nextIdx >= session.phases.length) {
      return ok({
        sessionId: session.id,
        complete: true,
        nextAction: "All phases complete. Swarm finished.",
      });
    }
    session.currentPhaseIndex = nextIdx;
  }

  const phaseIdx = session.currentPhaseIndex;
  const phaseDef = getPhaseDefinition(session);
  const phase = session.phases[phaseIdx];
  const history = buildAnonymousHistory(session);

  // WS2c: Check for degraded groups and generate reassignment dispatches
  const degradedGroups = session.agentGroups.filter(
    (g) => g.healthStatus === "degraded",
  );
  const reassignments: Array<{
    fromGroup: string;
    toGroup: string;
    workstreams: string[];
    reason: string;
  }> = [];
  const reassignmentManagerCalls: Array<{
    subagent_type: string;
    description: string;
    promptRef: string;
    model: string;
    groupId: string;
    workstreams: string[];
    reassignment: true;
  }> = [];

  for (const degradedGroup of degradedGroups) {
    // Collect incomplete workstreams (no score or score < 7)
    const incompleteWorkstreams = degradedGroup.workerSlots.filter((slot) => {
      const ws = session.workstreams.find((w) => w.id === slot.workstreamId);
      return !ws || ws.score === undefined || (ws.score as number) < 7;
    });

    if (incompleteWorkstreams.length === 0) continue;

    // Find a different provider model for diversity
    const degradedProvider = getModelProvider(degradedGroup.managerModel);
    const alternativeModel =
      coderPool.find((m) => getModelProvider(m) !== degradedProvider) ??
      premiumPool.find((m) => getModelProvider(m) !== degradedProvider);

    // WS2c: If no different-provider model exists, skip this group's reassignment
    if (!alternativeModel) {
      postToBoard(
        session,
        degradedGroup.id,
        "status",
        `Cannot reassign ${degradedGroup.id} workstreams — no alternative provider available`,
        "L1",
        degradedGroup.id,
      );
      continue;
    }

    const newManagerAgent = getManagerAgentName(alternativeModel);
    const newGroupId = `${degradedGroup.id}-retry-${Date.now()}`;

    const managerPrompt = buildManagerPrompt(
      session,
      degradedGroup,
      phaseDef.name,
      history,
    );
    const promptRef = storePrompt(session, managerPrompt);

    reassignments.push({
      fromGroup: degradedGroup.id,
      toGroup: newGroupId,
      workstreams: incompleteWorkstreams.map((s) => s.workstreamId),
      reason: degradedGroup.failureReason ?? "degraded",
    });

    reassignmentManagerCalls.push({
      subagent_type: newManagerAgent,
      description: `Reassignment: ${phaseDef.name} ${newGroupId} (${incompleteWorkstreams.length} workers)`,
      promptRef,
      model: alternativeModel,
      groupId: newGroupId,
      workstreams: incompleteWorkstreams.map((s) => s.workstreamId),
      reassignment: true,
    });
  }

  // ── Subprocess mode ──
  if (session.executionMode === "subprocess") {
    return handleSwarmNextSubprocess(
      session,
      phaseDef,
      phase,
      phaseIdx,
      history,
    );
  }

  // ── Task mode with 3-tier hierarchy ──
  // Parallel phases: dispatch L2 managers (not L3 workers directly)
  // Each L2 manager spawns its own L3 workers via task()
  if (phaseDef.parallel) {
    // Create agent groups if not yet done for this phase
    if (
      session.agentGroups.length === 0 ||
      session.agentGroups.every((g) => g.status === "done")
    ) {
      groupWorkstreams(session);
    }

    // Count in-flight managers (dispatched but not done)
    const inFlight = session.agentGroups.filter(
      (g) => g.status === "dispatched",
    ).length;
    const limit = session.concurrency > 0 ? session.concurrency : Infinity;
    const availableSlots = Math.max(0, limit - inFlight);

    // If concurrency is saturated, tell the orchestrator to wait
    if (availableSlots === 0) {
      const dispatched = session.agentGroups.filter(
        (g) => g.status === "dispatched",
      );
      const statusBoard = `${session.outputDir}/status-board.md`;
      return ok({
        sessionId: session.id,
        phase: phaseDef.name,
        phaseIndex: phaseIdx,
        parallel: true,
        rateLimited: true,
        concurrency: session.concurrency,
        inFlight,
        waitingFor: dispatched.map((g) => g.id),
        statusBoard,
        nextAction: [
          `⏳ Rate limit: ${session.concurrency} concurrent managers max, ${inFlight} in-flight.`,
          `Wait for current managers to complete, then call swarm_submit for each.`,
          `After submitting, call swarm_next again to dispatch the next wave.`,
          ``,
          `Monitor progress: bash("cat ${statusBoard} 2>/dev/null || echo 'Waiting...'")`,
        ].join("\n"),
      });
    }

    // Release only up to the concurrency limit
    const pending = session.agentGroups.filter((g) => g.status === "pending");
    const toDispatch = pending.slice(0, availableSlots);
    const managerCalls = [];

    for (const group of toDispatch) {
      const managerPrompt = buildManagerPrompt(
        session,
        group,
        phaseDef.name,
        history,
      );
      const promptRef = storePrompt(session, managerPrompt);
      group.status = "dispatched";

      managerCalls.push({
        subagent_type: group.managerAgent,
        description: `${phaseDef.name} ${group.id} (${group.workerSlots.length} workers)`,
        promptRef,
        model: group.managerModel, // resolved through fallback system
        groupId: group.id,
        workerCount: group.workerSlots.length,
        workstreams: group.workerSlots.map((ws) => ws.workstreamId),
      });
    }

    const remainingPending = session.agentGroups.filter(
      (g) => g.status === "pending",
    ).length;
    const totalGroups = session.agentGroups.length;

    phase.status = "in_progress";
    const statusBoard = `${session.outputDir}/status-board.md`;
    return ok({
      sessionId: session.id,
      phase: phaseDef.name,
      phaseIndex: phaseIdx,
      parallel: true,
      hierarchy: "L1 → L2 managers → L3 workers",
      wave: {
        dispatching: managerCalls.length,
        inFlight: inFlight + managerCalls.length,
        remaining: remainingPending,
        total: totalGroups,
        concurrency:
          session.concurrency > 0 ? session.concurrency : "unlimited",
      },
      totalWorkers: session.workstreams.length,
      statusBoard,
      managerCalls,
      reassignments: reassignments.length > 0 ? reassignments : undefined,
      reassignmentManagerCalls:
        reassignmentManagerCalls.length > 0
          ? reassignmentManagerCalls
          : undefined,
      nextAction: [
        `Dispatch ${managerCalls.length} L2 manager(s)${remainingPending > 0 ? ` (wave — ${remainingPending} more queued, concurrency=${session.concurrency})` : ""}.`,
        `⚠️ RATE PACING: Stagger dispatches — dispatch 2 managers at a time, then bash("sleep 8") before next batch.`,
        `For EACH managerCall:`,
        `  1. Call swarm_dispatch(sessionId="${session.id}", promptRef=managerCall.promptRef, subagent_type=managerCall.subagent_type, description=managerCall.description, model=managerCall.model)`,
        `  2. Call task(subagent_type=result.subagent_type, description=result.description, prompt=result.prompt, model=result.model)`,
        `  3. After every 2 dispatches: bash("sleep 8") — rate limit pacing`,
        ``,
        `WHILE MANAGERS ARE WORKING — MONITOR THE BOARD:`,
        `  swarm_board(sessionId="${session.id}")  // Full board — see all L2 plans, L3 findings, blockers`,
        `  Look for:`,
        `    - L2 blocker → YOU make the decision, post swarm_relay(type="decision")`,
        `    - L2↔L2 disagreement → spin up swarm_debate between the managers`,
        `    - L3 blockers that managers haven't resolved → escalate to the relevant manager`,
        ``,
        `When each manager task() completes:`,
        `  4. Read the manager's report (task output + board posts)`,
        `  5. Check the board for unresolved blockers: swarm_board(sessionId="${session.id}", types=["blocker"])`,
        `  6. If ESCALATIONS: YOU (the boss) make the decision — post swarm_relay(type="decision")`,
        `  7. Call swarm_submit(sessionId="${session.id}", output=<manager report>)`,
        `  8. Cross-team findings are already on the board — next wave of managers will see them`,
        remainingPending > 0
          ? `  9. Call swarm_next again — the server will release the next wave of managers.`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  // ── Validation phase routing ──
  if (phaseDef.name === "validate-static") {
    // Single agent runs build + test suite
    const projectFiles = session.workstreams.flatMap((ws) => ws.files);
    const staticPrompt = [
      history,
      "",
      "--- VALIDATION: STATIC + UNIT TESTS ---",
      "Run the project build and test suite to verify code compiles and existing tests pass.",
      "",
      "1. Detect the project type:",
      "   - package.json → npm run build && npm test",
      "   - setup.py / pyproject.toml → pip install -e . && pytest",
      "   - go.mod → go build ./... && go test ./...",
      "   - Cargo.toml → cargo build && cargo test",
      "   - Makefile → make build && make test",
      "",
      "2. Run the build command. Report the result.",
      "3. Run the test suite. Report the result.",
      "",
      "4. Output structured results:",
      "",
      "STATIC_RESULT: pass|fail",
      "UNIT_RESULT: pass|fail (N tests passed, M failed)",
      "",
      `Files involved: ${projectFiles.slice(0, 20).join(", ") || "See project root"}`,
    ].join("\n");

    const taskCall = buildTaskCall(
      session,
      phaseDef,
      "validate-static phase",
      staticPrompt,
    );
    phase.status = "in_progress";
    return ok({
      sessionId: session.id,
      phase: phaseDef.name,
      phaseIndex: phaseIdx,
      parallel: false,
      taskCall,
      nextAction: `Call swarm_dispatch with sessionId="${session.id}" and promptRef=taskCall.promptRef, subagent_type=taskCall.subagent_type, description=taskCall.description. Then call swarm_submit with the output.`,
    });
  }

  if (phaseDef.name === "validate-integration") {
    // Parallel verifier dispatch — one per workstream with acceptance tests
    const workstreamsWithTests = session.workstreams.filter(
      (ws) => ws.acceptanceTests && ws.acceptanceTests.length > 0,
    );

    if (workstreamsWithTests.length === 0) {
      // Auto-skip if no acceptance tests defined
      phase.status = "done";
      return ok({
        sessionId: session.id,
        phase: phaseDef.name,
        phaseIndex: phaseIdx,
        skipped: true,
        reason:
          "No workstreams have acceptance tests defined. Skipping integration validation.",
        nextAction: `Call swarm_next with sessionId "${session.id}" to advance to the validation gate.`,
      });
    }

    const verifierCalls = workstreamsWithTests.map((ws, i) => {
      const builderModel = ws.modelAssigned;
      const verifierModel = getVerifierModel(builderModel, i);
      const prompt = buildVerifierPrompt(session, ws, ws.acceptanceTests!);
      const promptRef = storePrompt(session, prompt);
      return {
        subagent_type: getWorkerAgentName(verifierModel),
        description: `verify ${ws.id} (${ws.acceptanceTests!.length} tests)`,
        promptRef,
        model: verifierModel,
        workstream: ws.id,
        testCount: ws.acceptanceTests!.length,
      };
    });

    phase.status = "in_progress";
    return ok({
      sessionId: session.id,
      phase: phaseDef.name,
      phaseIndex: phaseIdx,
      parallel: true,
      verifierCalls,
      nextAction: [
        `Dispatch ${verifierCalls.length} verifier agent(s) — one per workstream with acceptance tests.`,
        `For EACH verifierCall:`,
        `  1. Call swarm_dispatch(sessionId="${session.id}", promptRef=verifierCall.promptRef, subagent_type=verifierCall.subagent_type, description=verifierCall.description, model=verifierCall.model)`,
        `  2. Call task(subagent_type=result.subagent_type, description=result.description, prompt=result.prompt, model=result.model)`,
        `When each verifier completes:`,
        `  3. Parse VALIDATION_RESULT from output and call swarm_validate(sessionId="${session.id}", workstream=ws.id, results=parsed_results)`,
        `  4. Call swarm_submit with the verifier output`,
        `After all verifiers submit: call swarm_next to advance to validate-gate.`,
      ].join("\n"),
    });
  }

  if (phaseDef.name === "validate-gate") {
    // Direct to validation gate handler
    phase.status = "in_progress";
    return handleValidationGate(session, phase);
  }

  // Single (non-parallel) task — dispatched directly as L3 worker
  const prompt = `${history}\n\nExecute the "${phaseDef.name}" phase for this task.`;
  const desc = `${phaseDef.name} phase`;
  const taskCall = buildTaskCall(session, phaseDef, desc, prompt);
  phase.status = "in_progress";

  return ok({
    sessionId: session.id,
    phase: phaseDef.name,
    phaseIndex: phaseIdx,
    parallel: false,
    taskCall,
    nextAction: `Call swarm_dispatch with sessionId="${session.id}" and promptRef=taskCall.promptRef, subagent_type=taskCall.subagent_type, description=taskCall.description. Then call swarm_submit with the output.`,
  });
}

function handleSwarmNextSubprocess(
  session: SwarmSession,
  phaseDef: PhaseDefinition,
  phase: PhaseState,
  phaseIdx: number,
  history: string,
): ToolResult {
  const outputDir = session.outputDir;

  if (phaseDef.parallel) {
    const wsCount = workstreamCount(session);
    const spawnCommands = [];

    for (let i = 0; i < wsCount; i++) {
      const ws = session.workstreams[i];
      const model = getCoderModel(i);
      const agentName = getWorkerAgentName(model);
      const wsContext = ws
        ? `\nWorkstream: ${ws.id} — ${ws.description}\nFiles: ${ws.files.join(", ") || "TBD"}`
        : `\nWorkstream: ws-${i}`;
      const boardCtx = ws ? buildBoardContext(session, ws.id) : "";
      const prompt = `${history}${boardCtx}\n\n--- WORKSTREAM CONTEXT ---${wsContext}\n\nExecute the "${phaseDef.name}" phase for this workstream. You are running as an independent subprocess — complete your work fully, do not wait for other agents.`;

      const promptFile = `${outputDir}/ws-${i}-prompt.md`;
      const outputFile = `${outputDir}/ws-${i}-output.md`;
      const logFile = `${outputDir}/ws-${i}-log.txt`;

      // Track on workstream
      if (ws) {
        ws.outputFile = outputFile;
        ws.modelAssigned = model;
      }

      spawnCommands.push({
        workstream: `ws-${i}`,
        model,
        agent: agentName,
        promptFile,
        outputFile,
        logFile,
        prompt,
        command: `mkdir -p ${outputDir} && cat > ${promptFile} << 'SWARM_PROMPT_EOF'\n${prompt}\nSWARM_PROMPT_EOF\nopencode run "$(cat ${promptFile})" --agent ${agentName} --dangerously-skip-permissions > ${outputFile} 2>&1`,
      });
    }

    phase.status = "in_progress";
    return ok({
      sessionId: session.id,
      phase: phaseDef.name,
      phaseIndex: phaseIdx,
      parallel: true,
      executionMode: "subprocess",
      workstreamCount: wsCount,
      spawnCommands,
      nextAction: `Create output directory: mkdir -p ${outputDir}\nThen for EACH spawn command:\n1. Write the prompt file\n2. Execute the command via bash(mode="async", detach=true)\nWhen ALL processes complete (check log files/output files), call swarm_collect with the outputs.`,
    });
  }

  // Single subprocess
  const model = phaseDef.model;
  const agentName = getWorkerAgentName(model);
  const prompt = `${history}\n\nExecute the "${phaseDef.name}" phase for this task. You are running as an independent subprocess — complete your work fully.`;
  const promptFile = `${outputDir}/phase-${phaseIdx}-prompt.md`;
  const outputFile = `${outputDir}/phase-${phaseIdx}-output.md`;
  const logFile = `${outputDir}/phase-${phaseIdx}-log.txt`;

  phase.status = "in_progress";
  return ok({
    sessionId: session.id,
    phase: phaseDef.name,
    phaseIndex: phaseIdx,
    parallel: false,
    executionMode: "subprocess",
    spawnCommand: {
      model,
      agent: agentName,
      promptFile,
      outputFile,
      logFile,
      prompt,
      command: `mkdir -p ${outputDir} && cat > ${promptFile} << 'SWARM_PROMPT_EOF'\n${prompt}\nSWARM_PROMPT_EOF\nopencode run "$(cat ${promptFile})" --agent ${agentName} --dangerously-skip-permissions > ${outputFile} 2>&1`,
    },
    nextAction: `Execute the command via bash, wait for completion, then call swarm_collect with the output.`,
  });
}

// ── swarm_submit ──────────────────────────────────────────────────────

export function handleSwarmSubmit(args: {
  sessionId: string;
  phaseIndex?: number;
  output: string;
  agentId?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const phaseIdx = args.phaseIndex ?? session.currentPhaseIndex;
  const phase = session.phases[phaseIdx];
  const phaseDef = getPhaseDefinition(session, phaseIdx);

  if (phase.status !== "in_progress") {
    return err(
      `Phase "${phase.name}" is "${phase.status}", expected "in_progress".`,
    );
  }

  // Store output
  phase.outputs.push(args.output);
  if (args.agentId) phase.agentIds.push(args.agentId);

  // ── Anti-drift enforcement ──────────────────────────────────────────
  // Check if output aligns with the original task goal.
  const taskGoal = session.task;
  const drift = checkDrift(taskGoal, args.output);

  if (drift.alignmentScore < DRIFT_THRESHOLD) {
    // Remove the output we just pushed — it drifted too far
    phase.outputs.pop();
    if (args.agentId) phase.agentIds.pop();

    return err(
      `⚠️ Submission rejected — output drifted from task goal.\n` +
        `Alignment: ${(drift.alignmentScore * 100).toFixed(0)}% (threshold: ${(DRIFT_THRESHOLD * 100).toFixed(0)}%)\n` +
        `Drift signals:\n${drift.driftSignals.map((s) => `  • ${s}`).join("\n")}\n` +
        `\nOriginal task: "${taskGoal.substring(0, 200)}..."\n` +
        `\nPlease revise the output to address the original task goal and resubmit.`,
    );
  }

  // Track L2 manager group completion
  const groupIndex = phase.outputs.length - 1;
  const group = session.agentGroups[groupIndex];
  if (group) {
    group.status = "done";
    group.report = args.output;
    // Post L2 report to board at group level
    postToBoard(session, group.id, "report", args.output, "L2", group.id);
    // Mark all workstreams in this group as done
    for (const slot of group.workerSlots) {
      const ws = session.workstreams.find((w) => w.id === slot.workstreamId);
      if (ws) ws.status = "done";
    }

    // WS2b: Detect degraded groups from failure indicators in output.
    // Require 2+ weak indicators OR 1 strong indicator to avoid false positives.
    const strongDegradedPattern =
      /\b(PARTIAL|DEGRADED)\b|BUILD\s+(PARTIAL|FAILED|DEGRADED)\b/i;
    const weakIndicators = ["limited tool access", "failed to"];
    const lowerOutput = args.output.toLowerCase();
    const weakMatches = weakIndicators.filter((ind) =>
      lowerOutput.includes(ind.toLowerCase()),
    );
    const isDegraded =
      strongDegradedPattern.test(args.output) || weakMatches.length >= 2;
    const degradedIndicator = isDegraded
      ? strongDegradedPattern.test(args.output)
        ? (args.output.match(strongDegradedPattern)?.[0] ?? "PARTIAL")
        : weakMatches.join(", ")
      : null;
    if (degradedIndicator) {
      group.healthStatus = "degraded";
      group.failureReason = degradedIndicator;
      group.submittedAt = Date.now();
      postToBoard(
        session,
        group.id,
        "report",
        `⚠️ Group ${group.id} marked degraded: detected "${degradedIndicator}" in output. Workstreams may need reassignment.`,
        "L2",
        group.id,
      );
    }
  } else {
    // Non-grouped submit (single-task phases)
    const wsIndex = phase.outputs.length - 1;
    const ws = session.workstreams[wsIndex];
    const wsId = ws?.id ?? `ws-${wsIndex}`;
    postToBoard(session, wsId, "finding", args.output);
    if (ws) ws.status = "done";
  }

  // Add anonymized history entry
  const currentRound =
    session.rounds.length > 0
      ? Math.max(...session.rounds.map((r) => r.round))
      : 1;
  session.history.push({
    round: currentRound,
    phase: phase.name,
    content: stripIdentity(args.output),
  });

  // Check if all outputs collected
  // For parallel phases with hierarchy: expect one output per L2 manager group
  const expectedOutputs = phaseDef.parallel
    ? session.agentGroups.length > 0
      ? session.agentGroups.length
      : workstreamCount(session)
    : 1;
  const allCollected = phase.outputs.length >= expectedOutputs;

  if (allCollected) {
    phase.status = "done";
  }

  // Determine next action
  let nextAction: string;
  if (!allCollected) {
    const remaining = expectedOutputs - phase.outputs.length;
    nextAction = `${remaining} more output(s) expected. Call swarm_submit for each remaining workstream.`;
  } else {
    // Check if next phase is a merge
    const nextIdx = phaseIdx + 1;
    if (nextIdx < session.phases.length) {
      const nextDef = TIER_PHASES[session.tier][nextIdx];
      if (nextDef.name.startsWith("merge_")) {
        nextAction = `Phase complete. Call swarm_merge with sessionId "${session.id}" and the collected outputs.`;
      } else {
        nextAction = `Phase complete. Call swarm_next with sessionId "${session.id}" to advance.`;
      }
    } else {
      nextAction = "All phases complete. Swarm finished.";
    }
  }

  return ok({
    sessionId: session.id,
    phase: phase.name,
    phaseStatus: phase.status,
    outputsCollected: phase.outputs.length,
    outputsExpected: expectedOutputs,
    drift: {
      alignmentScore: drift.alignmentScore,
      signals: drift.driftSignals,
    },
    nextAction,
  });
}

// ── swarm_merge ───────────────────────────────────────────────────────

export function handleSwarmMerge(args: {
  sessionId: string;
  outputs: string[];
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  // Find the next merge phase
  const phaseIdx = session.currentPhaseIndex + 1;
  if (phaseIdx >= session.phases.length) return err("No more phases to merge.");

  const mergeDef = getPhaseDefinition(session, phaseIdx);
  const mergePhase = session.phases[phaseIdx];

  if (!mergeDef.name.startsWith("merge_")) {
    return err(`Next phase "${mergeDef.name}" is not a merge phase.`);
  }

  // Build anonymous merge prompt
  const contributorOutputs = (args.outputs ?? [])
    .map((o, i) => `=== Contributor ${i + 1} ===\n${stripIdentity(o)}`)
    .join("\n\n");

  // Compute convergence to guide synthesis
  const currentRound =
    session.rounds.length > 0
      ? Math.max(...session.rounds.map((r) => r.round))
      : 0;
  const currentScores = session.rounds.filter((r) => r.round === currentRound);
  const convergence = computeConvergence(session, currentRound, currentScores);

  let guidance = "";
  if (convergence.stalling) {
    guidance =
      "CRITICAL: The swarm is stalling (low convergence). Do NOT just average the contributions. Look for novel, outlier ideas in the contributions that might break the deadlock. Be bold in your synthesis.";
  } else if (convergence.delta > 0.5) {
    guidance =
      "The swarm is converging well. Synthesize the contributions to refine the details and polish the solution. Focus on consistency.";
  } else {
    guidance =
      "Synthesize the contributions. Look for the strongest elements of each approach.";
  }

  const mergePrompt = [
    buildAnonymousHistory(session),
    "",
    "--- MERGE TASK ---",
    "Multiple contributors have completed parallel work. Synthesize their outputs.",
    `Convergence Status: ${convergence.delta > 0 ? "Improving" : "Stable"} (Delta: ${convergence.delta})`,
    guidance,
    "",
    contributorOutputs,
    "",
    "Produce:",
    "1. A unified summary combining all contributions",
    "2. Any conflicts identified between contributions",
    "3. A recommended approach that resolves conflicts and maximizes quality",
    "",
    "Do not reference specific contributors by number in your final output.",
  ].join("\n");

  mergePhase.status = "in_progress";
  session.currentPhaseIndex = phaseIdx;

  const taskCall = buildTaskCall(
    session,
    mergeDef,
    `${mergeDef.name} phase`,
    mergePrompt,
  );

  return ok({
    sessionId: session.id,
    phase: mergeDef.name,
    phaseIndex: phaseIdx,
    taskCall,
    nextAction: `Call swarm_dispatch with sessionId="${session.id}" and promptRef=taskCall.promptRef, subagent_type=taskCall.subagent_type, description=taskCall.description. Then call swarm_submit with the merged result.`,
  });
}

// ── swarm_status ──────────────────────────────────────────────────────

export function handleSwarmStatus(args: { sessionId: string }): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const currentPhase = session.phases[session.currentPhaseIndex];
  const phaseDef = getPhaseDefinition(session);

  // History summary: count entries per phase
  const historySummary: Record<string, number> = {};
  for (const entry of session.history) {
    historySummary[entry.phase] = (historySummary[entry.phase] ?? 0) + 1;
  }

  // Determine next action
  let nextAction: string;
  if (currentPhase.status === "pending") {
    nextAction = `Call swarm_next with sessionId "${session.id}".`;
  } else if (currentPhase.status === "in_progress") {
    if (phaseDef.isGate) {
      nextAction = `Call swarm_gate with sessionId "${session.id}" and scores.`;
    } else {
      nextAction = `Submit remaining outputs via swarm_submit.`;
    }
  } else if (currentPhase.status === "done") {
    const nextIdx = session.currentPhaseIndex + 1;
    if (nextIdx >= session.phases.length) {
      nextAction = "All phases complete. Swarm finished.";
    } else {
      const nextDef = TIER_PHASES[session.tier][nextIdx];
      if (nextDef.name.startsWith("merge_")) {
        nextAction = `Call swarm_merge with sessionId "${session.id}".`;
      } else {
        nextAction = `Call swarm_next with sessionId "${session.id}".`;
      }
    }
  } else {
    nextAction = "Phase skipped or blocked.";
  }

  return ok({
    sessionId: session.id,
    tier: session.tier,
    currentPhase: { name: currentPhase.name, index: session.currentPhaseIndex },
    totalPhases: session.phases.length,
    phases: session.phases.map((p) => ({ name: p.name, status: p.status })),
    workstreams: session.workstreams.map((ws) => ({
      id: ws.id,
      description: ws.description,
      score: ws.score,
      model: ws.modelAssigned,
      provider: getModelProvider(ws.modelAssigned),
    })),
    hierarchy:
      session.agentGroups.length > 0
        ? {
            model: "L1 orchestrator → L2 managers → L3 workers",
            groups: session.agentGroups.map((g) => ({
              id: g.id,
              manager: g.managerAgent,
              managerModel: g.managerModel,
              status: g.status,
              workers: g.workerSlots.map((ws) => ({
                workstream: ws.workstreamId,
                agent: ws.agentType,
                model: ws.model,
              })),
              hasReport: !!g.report,
            })),
          }
        : undefined,
    historySummary,
    convergence:
      session.rounds.length > 0
        ? (() => {
            const latestRound = Math.max(...session.rounds.map((r) => r.round));
            const latestScores = session.rounds
              .filter((r) => r.round === latestRound)
              .map((r) => ({ workstream: r.workstream, score: r.score }));
            return computeConvergence(session, latestRound, latestScores);
          })()
        : null,
    nextAction,
    apiRateLimits: getRateLimitStatus(session.id),
  });
}

export async function handleSwarmGate(args: {
  sessionId: string;
  scores: Array<{ workstream: string; score: number; criticalIssues: number }>;
  includeBoard?: boolean;
}): Promise<ToolResult> {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const phaseDef = getPhaseDefinition(session);
  if (!phaseDef.isGate) {
    return err(`Current phase "${phaseDef.name}" is not a gate phase.`);
  }

  // Validation gate: uses validation results, not subjective scores
  if (phaseDef.isValidationGate) {
    const phase = session.phases[session.currentPhaseIndex];
    phase.status = "in_progress";
    return handleValidationGate(session, phase);
  }

  // WS3a: Pre-check phase — validate workstream coverage and degraded groups before scoring
  const expectedWsIds = session.workstreams.map((w) => w.id);
  const submittedWsIds = new Set(args.scores.map((s) => s.workstream));
  const missingWorkstreams = expectedWsIds.filter(
    (id) => !submittedWsIds.has(id),
  );

  const degradedGroups = session.agentGroups.filter(
    (g) => g.healthStatus === "degraded",
  );
  const unresolvedDegraded = degradedGroups.filter((g) => {
    // A degraded group is unresolved if any of its workstreams have no score or score < 7
    return g.workerSlots.some((slot) => {
      const wsScore = args.scores.find(
        (s) => s.workstream === slot.workstreamId,
      );
      return !wsScore || wsScore.score < 7;
    });
  });

  const preChecks = {
    workstream_coverage: {
      passed: missingWorkstreams.length === 0,
      missing: missingWorkstreams,
      message:
        missingWorkstreams.length === 0
          ? "All expected workstreams have submissions."
          : `Missing submissions for: ${missingWorkstreams.join(", ")}`,
    },
    degraded_groups: {
      passed: unresolvedDegraded.length === 0,
      groups: unresolvedDegraded.map((g) => ({
        id: g.id,
        failureReason: g.failureReason ?? "unknown",
      })),
      message:
        unresolvedDegraded.length === 0
          ? "No degraded groups with unresolved workstreams."
          : `${unresolvedDegraded.length} degraded group(s) with unresolved workstreams: ${unresolvedDegraded.map((g) => g.id).join(", ")}`,
    },
  };

  const anyPreCheckFailed =
    !preChecks.workstream_coverage.passed || !preChecks.degraded_groups.passed;

  if (anyPreCheckFailed) {
    return ok({
      proceed: false,
      preChecksFailed: true,
      preChecks,
      nextAction:
        "Pre-checks failed. Resolve issues before calling swarm_gate.",
    });
  }

  const phase = session.phases[session.currentPhaseIndex];
  phase.status = "in_progress";

  const currentRound =
    session.rounds.length > 0
      ? Math.max(...session.rounds.map((r) => r.round)) + 1
      : 1;

  // Store scores
  for (const s of args.scores) {
    const ws = session.workstreams.find((w) => w.id === s.workstream);
    if (ws) {
      ws.score = s.score;
      ws.criticalIssues = s.criticalIssues;
    }
    session.rounds.push({
      round: currentRound,
      workstream: s.workstream,
      model: ws?.modelAssigned ?? "unknown",
      score: s.score,
      criticalIssues: s.criticalIssues,
    });
  }

  // Compute convergence metrics
  const convergence = computeConvergence(session, currentRound, args.scores);

  // ── Learning Loop: JUDGE ──
  let learningOutcome: { avgScore: number; shouldDistill: boolean } | undefined;
  let distillResult: { action: string; patternId: string } | undefined;
  let backgroundWorkers:
    | Array<{ agent: string; prompt: string; model: string; workerId: string }>
    | undefined;
  try {
    const judgeResult = await judge(session, args.scores);
    learningOutcome = {
      avgScore: judgeResult.avgScore,
      shouldDistill: judgeResult.shouldDistill,
    };

    // Auto-distill on high scores
    if (judgeResult.shouldDistill) {
      distillResult = await distill(session);
    }
  } catch {
    // Learning is best-effort
  }

  // ── Worker Triggers ──
  const failing = args.scores.filter((s) => s.score < 7);
  const allPass = failing.length === 0;
  const triggerEvent = allPass ? "gate_pass" : "gate_fail";
  try {
    const triggeredWorkers = workerRegistry.checkTriggers(
      session.id,
      triggerEvent,
    );
    if (triggeredWorkers.length > 0) {
      const allFiles = session.workstreams.flatMap((ws) => ws.files);
      backgroundWorkers = triggeredWorkers.map((w) =>
        workerRegistry.buildDispatch(w, {
          files: allFiles,
          sessionTask: session.task,
        }),
      );
    }
  } catch {
    // Worker triggers are best-effort
  }

  if (allPass) {
    phase.status = "done";
    advancePhase(session.id);
    return ok({
      proceed: true,
      sessionId: session.id,
      round: currentRound,
      scores: args.scores,
      convergence,
      learning: learningOutcome,
      distilled: distillResult,
      backgroundWorkers,
      nextAction: `All scores ≥ 7. Call swarm_next with sessionId "${session.id}" to continue.`,
    });
  }

  // Retry path
  const loopsForWorkstream = (wsId: string) =>
    session.rounds.filter((r) => r.workstream === wsId).length;

  const maxExceeded = failing.some(
    (s) => loopsForWorkstream(s.workstream) >= session.maxLoops,
  );

  if (maxExceeded) {
    // Force proceed with warning
    phase.status = "done";
    // Clear failing scores to allow advancePhase gate validation
    for (const s of failing) {
      const ws = session.workstreams.find((w) => w.id === s.workstream);
      if (ws) ws.score = 7;
    }
    advancePhase(session.id);
    return ok({
      proceed: true,
      forced: true,
      warning: `Max retry loops (${session.maxLoops}) exceeded. Proceeding despite failing scores.`,
      sessionId: session.id,
      round: currentRound,
      failingWorkstreams: failing.map((s) => s.workstream),
      nextAction: `Call swarm_next with sessionId "${session.id}" to continue (forced).`,
    });
  }

  // Build retry instructions with cross-awareness
  // WS1c: Only embed full board context when includeBoard===true (default: false to save tokens)
  const includeBoard = args.includeBoard === true;
  const retryDetails = failing.map((s) => {
    if (includeBoard) {
      const wsHistory = buildAnonymousHistory(session, s.workstream);
      return `Workstream "${s.workstream}" scored ${s.score}/10 with ${s.criticalIssues} critical issue(s). Retry needed.\n\nContext:\n${wsHistory}`;
    }
    return `Workstream "${s.workstream}" scored ${s.score}/10 with ${s.criticalIssues} critical issue(s). Retry needed.`;
  });

  // Find the review phase to retry from
  const phases = TIER_PHASES[session.tier];
  const reviewIdx = phases.findIndex((p) => p.name === "review");
  const retryPhase =
    reviewIdx >= 0
      ? "review"
      : phases[Math.max(0, session.currentPhaseIndex - 1)].name;

  return ok({
    proceed: false,
    sessionId: session.id,
    round: currentRound,
    failingWorkstreams: failing.map((s) => ({
      workstream: s.workstream,
      score: s.score,
      criticalIssues: s.criticalIssues,
    })),
    retryPhase,
    retryInstructions: retryDetails.join("\n\n---\n\n"),
    ...(includeBoard
      ? {}
      : {
          boardRef:
            "Use swarm_board with mode=summary to review context before retry",
        }),
    nextAction: `Scores below threshold. Re-run the "${retryPhase}" phase for failing workstreams, then call swarm_gate again.`,
  });
}

// ── swarm_collect ─────────────────────────────────────────────────────

export function handleSwarmCollect(args: {
  sessionId: string;
  outputs: Array<{ workstream: string; output: string }>;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  if (session.executionMode !== "subprocess") {
    return err(
      "swarm_collect is only for subprocess execution mode. Use swarm_submit for task mode.",
    );
  }

  if (!args.outputs || args.outputs.length === 0) {
    return err(
      "No outputs provided. Pass an array of {workstream, output} objects.",
    );
  }

  const results = [];
  for (const item of args.outputs) {
    // Feed each output through the existing submit logic
    const submitResult = handleSwarmSubmit({
      sessionId: args.sessionId,
      output: item.output,
      agentId: `subprocess-${item.workstream}`,
    });
    results.push({
      workstream: item.workstream,
      submitResult: JSON.parse(submitResult.content[0].text),
    });
  }

  // Check if all outputs triggered phase completion
  const phase = session.phases[session.currentPhaseIndex];
  const phaseDef = getPhaseDefinition(session);

  let nextAction: string;
  if (phase.status === "done") {
    const nextIdx = session.currentPhaseIndex + 1;
    if (nextIdx < session.phases.length) {
      const nextDef = TIER_PHASES[session.tier][nextIdx];
      if (nextDef.name.startsWith("merge_")) {
        nextAction = `All subprocess outputs collected. Phase complete. Call swarm_merge with sessionId "${session.id}" and the outputs.`;
      } else {
        nextAction = `All subprocess outputs collected. Phase complete. Call swarm_next with sessionId "${session.id}" to advance.`;
      }
    } else {
      nextAction = "All phases complete. Swarm finished.";
    }
  } else {
    const phaseDefCheck = getPhaseDefinition(session);
    const expected = phaseDefCheck.parallel ? workstreamCount(session) : 1;
    const remaining = expected - phase.outputs.length;
    nextAction = `${remaining} more output(s) still expected. Collect remaining subprocess outputs and call swarm_collect again.`;
  }

  return ok({
    sessionId: session.id,
    phase: phase.name,
    phaseStatus: phase.status,
    collected: args.outputs.length,
    results,
    nextAction,
  });
}

// ── swarm_models ──────────────────────────────────────────────────────

export function handleSwarmModels(args: {
  action?: "list" | "set";
  models?: string[];
}): ToolResult {
  const action = args.action ?? "list";

  if (action === "set" && args.models && args.models.length > 0) {
    setAvailableModels(args.models);
    const fallbacks = getFallbackLog();
    return ok({
      action: "set",
      accepted: getAvailableModels().map((m) => m.id),
      ignored: args.models.filter(
        (id) => !getAvailableModels().some((m) => m.id === id),
      ),
      pools: {
        premium: [...premiumPool],
        coder: [...coderPool],
        critic: [...criticPool],
        fast: [...fastPool],
      },
      fallbackSystem:
        "active — models not in accepted list will auto-resolve to nearest available alternative",
      message: `Model pools updated. ${getAvailableModels().length} models active.`,
    });
  }

  return ok({
    action: "list",
    available: getAvailableModels().map((m) => ({
      id: m.id,
      tier: m.tier,
      provider: m.provider,
    })),
    pools: {
      premium: [...premiumPool],
      coder: [...coderPool],
      critic: [...criticPool],
      fast: [...fastPool],
    },
    recentFallbacks: getFallbackLog()
      .slice(-10)
      .map((f) => `${f.from} → ${f.to}`),
    total: getAvailableModels().length,
  });
}

// ── swarm_dispatch ─────────────────────────────────────────────────────
// Resolves a promptRef into the actual task() call parameters.
// The orchestrator calls this per workstream instead of re-serializing huge prompts.

export function handleSwarmDispatch(args: {
  sessionId: string;
  promptRef: string;
  subagent_type: string;
  description: string;
  model?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const prompt = getPrompt(session, args.promptRef);
  if (!prompt)
    return err(
      `Prompt ref not found: ${args.promptRef}. Call swarm_next first.`,
    );

  // Resolve model through fallback if provided
  let modelInfo: { model?: string; fallback?: boolean; original?: string } = {};
  let resolvedModelId = args.model ?? "";
  if (args.model) {
    const { model: resolved, wasFallback } = resolveModelTracked(args.model);
    resolvedModelId = resolved;
    modelInfo = { model: resolved, fallback: wasFallback };
    if (wasFallback) modelInfo.original = args.model;
  }

  // Token-bucket rate limiting per model tier
  if (resolvedModelId) {
    const rl = checkRateLimit(session.id, resolvedModelId);
    if (!rl.ok) {
      const waitSec = Math.ceil(rl.retryAfterMs / 1000);
      return ok({
        rateLimited: true,
        tier: rl.tier,
        model: resolvedModelId,
        retryAfterSeconds: waitSec,
        retryAfterMs: rl.retryAfterMs,
        nextAction: [
          `⏳ Rate limited: ${rl.tier}-tier models are at capacity (GitHub Copilot RPM limit).`,
          `Wait ${waitSec}s then retry this exact swarm_dispatch call.`,
          `bash("sleep ${waitSec}")`,
        ].join("\n"),
      });
    }
  }

  return ok({
    subagent_type: args.subagent_type,
    description: args.description,
    prompt,
    ...modelInfo,
  });
}

// ── swarm_throttle ────────────────────────────────────────────────────
// Live rate limit adjustment. View or change concurrency mid-session.

export function handleSwarmThrottle(args: {
  sessionId: string;
  concurrency?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const previousConcurrency = session.concurrency;

  // If concurrency provided, update it
  if (args.concurrency !== undefined && args.concurrency !== null) {
    if (
      typeof args.concurrency === "string" &&
      args.concurrency in RATE_PRESETS
    ) {
      session.concurrency = resolveRateLimit(args.concurrency as RatePreset);
    } else {
      const num = Number(args.concurrency);
      if (!isNaN(num) && num >= 0) {
        session.concurrency = num;
      } else {
        return err(
          `Invalid concurrency: "${args.concurrency}". Use a preset name (${Object.keys(RATE_PRESETS).join(", ")}) or a number >= 0.`,
        );
      }
    }
  }

  // Find matching preset
  const matchedPreset = Object.entries(RATE_PRESETS).find(
    ([_, v]) => v.concurrency === session.concurrency,
  );

  // Count in-flight groups
  const inFlight = session.agentGroups.filter(
    (g) => g.status === "dispatched",
  ).length;
  const completed = session.agentGroups.filter(
    (g) => g.status === "done",
  ).length;
  const pending = session.agentGroups.filter(
    (g) => g.status === "pending",
  ).length;

  return ok({
    previous: previousConcurrency! > 0 ? previousConcurrency : "unlimited",
    current: session.concurrency! > 0 ? session.concurrency : "unlimited",
    changed: args.concurrency !== undefined,
    preset: matchedPreset ? matchedPreset[0] : "custom",
    description: matchedPreset
      ? matchedPreset[1].description
      : `Custom: ${session.concurrency} concurrent L2 managers`,
    groupStatus: {
      total: session.agentGroups.length,
      inFlight,
      completed,
      pending,
    },
    availablePresets: Object.fromEntries(
      Object.entries(RATE_PRESETS).map(([k, v]) => [
        k,
        {
          concurrency: v.concurrency || "unlimited",
          estimatedAgents: v.maxAgents === Infinity ? "unlimited" : v.maxAgents,
          plan: v.plan,
          description: v.description,
        },
      ]),
    ),
    apiRateLimits: getRateLimitStatus(session.id),
  });
}

// ── swarm_relay ───────────────────────────────────────────────────────
// Orchestrator posts findings from a completed workstream to the board.
// The board is the programmatic communication layer between managers.

export function handleSwarmRelay(args: {
  sessionId: string;
  workstream: string;
  type?: "finding" | "blocker" | "decision" | "status" | "plan" | "report";
  level?: "L1" | "L2" | "L3";
  group?: string;
  content: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const type = args.type ?? "finding";
  const level = args.level ?? "L1";
  const msg = postToBoard(
    session,
    args.workstream,
    type,
    args.content,
    level,
    args.group,
  );

  // Mark workstream status if blocker
  if (type === "blocker") {
    const ws = session.workstreams.find((w) => w.id === args.workstream);
    if (ws) ws.status = "blocked";
  }

  const boardSize = session.board.length;
  const findings = session.board.filter((m) => m.type === "finding").length;
  const blockers = session.board.filter((m) => m.type === "blocker").length;
  const decisions = session.board.filter((m) => m.type === "decision").length;

  return ok({
    sessionId: session.id,
    posted: { workstream: msg.workstream, type: msg.type },
    boardStats: { total: boardSize, findings, blockers, decisions },
    nextAction:
      blockers > 0
        ? `⚠️ ${blockers} blocker(s) on the board. Orchestrator: review blockers and make a decision before dispatching more work. Call swarm_relay with type="decision" to resolve.`
        : `Board updated. ${findings} finding(s) available. These will be automatically injected into the next workstream's context when you call swarm_next.`,
  });
}

// ── swarm_board ───────────────────────────────────────────────────────
// Orchestrator reads the full board state to make decisions.
// This is the "facts presented to the orchestrator" — the premium model decides.

export function handleSwarmBoard(args: {
  sessionId: string;
  workstream?: string;
  types?: ("finding" | "blocker" | "decision" | "status" | "plan" | "report")[];
  level?: "L1" | "L2" | "L3";
  page?: number;
  pageSize?: number;
  mode?: "full" | "summary";
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  let messages = readBoard(session, args.workstream, args.types);
  // Filter by level if specified
  if (args.level) {
    messages = messages.filter((m) => m.level === args.level);
  }

  // WS1b: Summary mode — group by workstream, return only latest message per type
  if (args.mode === "summary") {
    const wsMap = new Map<
      string,
      {
        id: string;
        latestFinding?: BoardMessage;
        latestReport?: BoardMessage;
        latestReview?: BoardMessage;
        messageCount: number;
      }
    >();

    for (const msg of messages) {
      const entry = wsMap.get(msg.workstream) ?? {
        id: msg.workstream,
        messageCount: 0,
      };
      entry.messageCount++;
      if (msg.type === "finding") {
        if (
          !entry.latestFinding ||
          msg.timestamp > entry.latestFinding.timestamp
        ) {
          entry.latestFinding = msg;
        }
      } else if (msg.type === "report") {
        if (
          !entry.latestReport ||
          msg.timestamp > entry.latestReport.timestamp
        ) {
          entry.latestReport = msg;
        }
      } else if ((msg.type as string) === "review") {
        if (
          !entry.latestReview ||
          msg.timestamp > entry.latestReview.timestamp
        ) {
          entry.latestReview = msg;
        }
      }
      wsMap.set(msg.workstream, entry);
    }

    return ok({
      sessionId: session.id,
      mode: "summary",
      workstreams: Array.from(wsMap.values()).map((e) => ({
        id: e.id,
        messageCount: e.messageCount,
        latestFinding: e.latestFinding
          ? {
              content: e.latestFinding.content.substring(0, 300),
              timestamp: e.latestFinding.timestamp,
            }
          : undefined,
        latestReport: e.latestReport
          ? {
              content: e.latestReport.content.substring(0, 300),
              timestamp: e.latestReport.timestamp,
            }
          : undefined,
        latestReview: e.latestReview
          ? {
              content: e.latestReview.content.substring(0, 300),
              timestamp: e.latestReview.timestamp,
            }
          : undefined,
      })),
    });
  }

  // WS1a: Pagination — apply AFTER filters
  const totalMessages = messages.length;
  let paginationMeta:
    | {
        page: number;
        pageSize: number;
        totalMessages: number;
        totalPages: number;
        hasMore: boolean;
      }
    | undefined;

  if (args.page !== undefined) {
    const pageSize = Math.min(args.pageSize ?? 20, 50);
    const page = Math.max(args.page, 1);
    const totalPages = Math.ceil(totalMessages / pageSize);
    messages = messages.slice((page - 1) * pageSize, page * pageSize);
    paginationMeta = {
      page,
      pageSize,
      totalMessages,
      totalPages,
      hasMore: page < totalPages,
    };
  }

  const ready = getReadyWorkstreams(session);
  const blocked = getBlockedWorkstreams(session);
  const blockers = session.board.filter((m) => m.type === "blocker");
  const decisions = session.board.filter((m) => m.type === "decision");
  const reports = session.board.filter((m) => m.type === "report");
  const unresolvedBlockers = blockers.filter((b) => {
    return !decisions.some(
      (d) =>
        d.timestamp >= b.timestamp &&
        (d.content.toLowerCase().includes(b.workstream.toLowerCase()) ||
          d.content.toLowerCase().includes("resolved") ||
          d.workstream === "orchestrator"),
    );
  });

  let nextAction: string;
  if (unresolvedBlockers.length > 0) {
    nextAction = `🛑 ${unresolvedBlockers.length} unresolved blocker(s). As orchestrator, make decisions on these before proceeding. Call swarm_relay(type="decision", content="...") to resolve each.`;
  } else if (ready.length > 0) {
    nextAction = `${ready.length} workstream(s) ready to dispatch: ${ready.map((w) => w.id).join(", ")}. Call swarm_next to get task calls.`;
  } else if (blocked.length > 0) {
    nextAction = `All remaining workstreams are blocked on dependencies. Resolve dependencies first.`;
  } else {
    nextAction = "All workstreams dispatched or complete.";
  }

  return ok({
    sessionId: session.id,
    messages,
    summary: {
      total: messages.length,
      byType: {
        finding: messages.filter((m) => m.type === "finding").length,
        blocker: messages.filter((m) => m.type === "blocker").length,
        decision: messages.filter((m) => m.type === "decision").length,
        status: messages.filter((m) => m.type === "status").length,
        plan: messages.filter((m) => m.type === "plan").length,
        report: messages.filter((m) => m.type === "report").length,
      },
      byLevel: {
        L1: messages.filter((m) => m.level === "L1").length,
        L2: messages.filter((m) => m.level === "L2").length,
        L3: messages.filter((m) => m.level === "L3").length,
      },
      unresolvedBlockers: unresolvedBlockers.length,
    },
    hierarchy:
      session.agentGroups.length > 0
        ? {
            groups: session.agentGroups.map((g) => ({
              id: g.id,
              status: g.status,
              manager: g.managerAgent,
              hasReport: !!g.report,
              workers: g.workerSlots.map((ws) => ws.workstreamId),
            })),
          }
        : undefined,
    workstreams: {
      ready: ready.map((w) => w.id),
      blocked: blocked.map((w) => ({ id: w.id, waitingOn: w.dependencies })),
      done: session.workstreams
        .filter((w) => w.status === "done")
        .map((w) => w.id),
    },
    debates:
      session.debates.length > 0
        ? {
            active: session.debates
              .filter((d) => d.status !== "resolved")
              .map((d) => ({
                id: d.id,
                topic: d.topic,
                status: d.status,
                round: `${d.currentRound}/${d.maxRounds}`,
                groupId: d.groupId,
                participants: d.participants.length,
                lastEvaluation: d.rounds[d.rounds.length - 1]?.evaluation
                  ? {
                      convergence:
                        d.rounds[d.rounds.length - 1].evaluation!
                          .convergenceScore,
                      sycophancy:
                        d.rounds[d.rounds.length - 1].evaluation!
                          .sycophancyScore,
                      recommendation:
                        d.rounds[d.rounds.length - 1].evaluation!
                          .recommendation,
                    }
                  : undefined,
              })),
            debateMessages: session.board.filter((m) =>
              m.type.startsWith("debate-"),
            ).length,
            resolved: session.debates.filter((d) => d.status === "resolved")
              .length,
          }
        : undefined,
    pagination: paginationMeta,
    nextAction,
  });
}

// ── swarm_debate ──────────────────────────────────────────────────────
// Structured debate protocol for L2 managers and L1 orchestrators.
// Based on Agent-Skills multi-agent-patterns: debate protocols, adversarial
// critique, weighted voting, and sycophancy detection.
// Ref: arXiv:2602.16301 §3.2 (mutual shaping through anonymous interaction)

export function handleSwarmDebate(args: {
  sessionId: string;
  action:
    | "start"
    | "next"
    | "submit"
    | "evaluate"
    | "synthesize"
    | "status"
    | "escalate"
    | "validate";
  topic?: string;
  trigger?: DebateTrigger;
  groupId?: string;
  participantCount?: number;
  maxRounds?: number;
  debateId?: string;
  slotId?: string;
  content?: string;
  synthesis?: string;
  validationOutcome?: "confirmed" | "failed" | "partial";
  validationFindings?: string[];
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "start":
      return handleDebateStart(session, args);
    case "next":
      return handleDebateNext(session, args);
    case "submit":
      return handleDebateSubmit(session, args);
    case "evaluate":
      return handleDebateEvaluate(session, args);
    case "synthesize":
      return handleDebateSynthesize(session, args);
    case "status":
      return handleDebateStatusAction(session, args);
    case "escalate":
      return handleDebateEscalate(session, args);
    case "validate":
      return handleDebateValidate(session, args);
    default:
      return err(`Unknown debate action: ${args.action}`);
  }
}

// ── Debate: start ─────────────────────────────────────────────────────
function handleDebateStart(
  session: SwarmSession,
  args: {
    topic?: string;
    trigger?: DebateTrigger;
    groupId?: string;
    participantCount?: number;
    maxRounds?: number;
  },
): ToolResult {
  if (!args.topic)
    return err('Missing required field: topic (for action="start")');

  const trigger = args.trigger ?? "explicit";
  const participantCount = Math.min(Math.max(args.participantCount ?? 2, 2), 5);
  const maxRounds = args.maxRounds ?? 3;

  const debate = createDebate(
    session,
    args.topic,
    trigger,
    args.groupId,
    participantCount,
    maxRounds,
  );

  // Post debate start to the board
  const level = debate.initiatorLevel;
  postToBoard(
    session,
    args.groupId ?? "orchestrator",
    "debate-position",
    `Debate started: "${args.topic}" | Trigger: ${trigger} | ${participantCount} participants | Max ${maxRounds} rounds`,
    level,
    args.groupId,
    debate.id,
  );

  return ok({
    debateId: debate.id,
    sessionId: session.id,
    topic: debate.topic,
    trigger: debate.trigger,
    initiatorLevel: debate.initiatorLevel,
    groupId: debate.groupId,
    participants: debate.participants.map((p) => ({
      slotId: p.slotId,
      agentType: p.agentType,
      model: p.model,
    })),
    maxRounds: debate.maxRounds,
    thresholds: {
      convergence: debate.convergenceThreshold,
      sycophancy: debate.sycophancyThreshold,
      minPositionScore: debate.minPositionScore,
    },
    nextAction: `Debate "${debate.id}" created with ${participantCount} participants. Call swarm_debate(action="next", sessionId="${session.id}", debateId="${debate.id}") to get the first phase prompts.`,
  });
}

// ── Debate: next ──────────────────────────────────────────────────────
function handleDebateNext(
  session: SwarmSession,
  args: { debateId?: string },
): ToolResult {
  if (!args.debateId) return err("Missing required field: debateId");

  const debate = getDebate(session, args.debateId);
  if (!debate) return err(`Debate not found: ${args.debateId}`);

  if (debate.status === "resolved" || debate.status === "escalated") {
    return ok({
      debateId: debate.id,
      status: debate.status,
      complete: true,
      synthesis: debate.synthesis,
      nextAction:
        "Debate is already resolved/escalated. Use the synthesis in your report.",
    });
  }

  const { phase, round, isNewRound } = advanceDebatePhase(debate);

  // Build prompts for each participant based on the current phase
  const taskCalls: Array<{
    slotId: string;
    subagent_type: string;
    description: string;
    promptRef: string;
    model: string;
  }> = [];

  for (const participant of debate.participants) {
    let prompt: string;

    switch (phase) {
      case "position":
        // Use contrarian prompt if this participant is the assigned devil's advocate
        prompt =
          debate.contrarian === participant.slotId && debate.currentRound > 1
            ? buildContrarianPrompt(debate, participant, session)
            : buildDebatePositionPrompt(debate, participant, session);
        break;
      case "critique":
        prompt = buildDebateCritiquePrompt(debate, participant, session);
        break;
      case "rebuttal":
        prompt = buildDebateRebuttalPrompt(debate, participant, session);
        break;
      case "evaluation":
        // Evaluation is done by the manager, not workers
        return ok({
          debateId: debate.id,
          phase: "evaluation",
          round,
          readyForEvaluation: true,
          nextAction: `All contributions collected for round ${round}. Call swarm_debate(action="evaluate", sessionId="${session.id}", debateId="${debate.id}") to score positions and check convergence.`,
        });
      default:
        return err(`Unexpected debate phase: ${phase}`);
    }

    const { model: resolvedModel } = resolveModelTracked(participant.model);
    const promptRef = storePrompt(session, prompt);

    taskCalls.push({
      slotId: participant.slotId,
      subagent_type: participant.agentType,
      description: `Debate ${debate.id} — ${phase} (${participant.slotId}, round ${round})`,
      promptRef,
      model: resolvedModel,
    });
  }

  return ok({
    debateId: debate.id,
    phase,
    round,
    isNewRound,
    participants: taskCalls.length,
    taskCalls,
    nextAction: [
      `Dispatch ${taskCalls.length} ${phase} task(s) for debate round ${round}.`,
      `For EACH taskCall:`,
      `  1. Call swarm_dispatch(sessionId="${session.id}", promptRef=taskCall.promptRef, subagent_type=taskCall.subagent_type, description=taskCall.description, model=taskCall.model)`,
      `  2. Call task(subagent_type=result.subagent_type, description=result.description, prompt=result.prompt, model=result.model)`,
      `  3. Call swarm_debate(action="submit", sessionId="${session.id}", debateId="${debate.id}", slotId=taskCall.slotId, content=<task output>)`,
      ``,
      `After ALL ${phase} submissions, call swarm_debate(action="next") again to advance.`,
    ].join("\n"),
  });
}

// ── Debate: submit ────────────────────────────────────────────────────
function handleDebateSubmit(
  session: SwarmSession,
  args: { debateId?: string; slotId?: string; content?: string },
): ToolResult {
  if (!args.debateId) return err("Missing required field: debateId");
  if (!args.slotId) return err("Missing required field: slotId");
  if (!args.content) return err("Missing required field: content");

  const debate = getDebate(session, args.debateId);
  if (!debate) return err(`Debate not found: ${args.debateId}`);

  if (debate.status !== "active") {
    return err(
      `Debate "${args.debateId}" is "${debate.status}", expected "active".`,
    );
  }

  const participant = debate.participants.find((p) => p.slotId === args.slotId);
  if (!participant) return err(`Unknown participant slot: ${args.slotId}`);

  const currentRound = debate.rounds[debate.rounds.length - 1];
  if (!currentRound)
    return err('No active round. Call swarm_debate(action="next") first.');

  const phase = currentRound.phase;

  // Check for duplicate submission
  const existing = currentRound.contributions.find(
    (c) => c.slotId === args.slotId && c.phase === phase,
  );
  if (existing) {
    return err(
      `${args.slotId} already submitted for ${phase} in round ${currentRound.roundNumber}.`,
    );
  }

  // Store the contribution (anonymized)
  const contribution: DebateContribution = {
    slotId: args.slotId!,
    agentType: participant.agentType,
    model: participant.model,
    phase,
    content: stripIdentity(args.content!),
    timestamp: Date.now(),
  };
  currentRound.contributions.push(contribution);

  // Post to board for cross-team visibility
  const boardType =
    phase === "position"
      ? "debate-position"
      : phase === "critique"
        ? "debate-critique"
        : "debate-rebuttal";
  postToBoard(
    session,
    debate.groupId ?? "orchestrator",
    boardType as any,
    `[${debate.id}/${args.slotId}] ${phase}: ${args.content!.substring(0, 200)}...`,
    debate.initiatorLevel,
    debate.groupId,
    debate.id,
  );

  // Count expected contributions for current phase
  const participantCount = debate.participants.length;
  const expectedForPhase =
    phase === "critique"
      ? participantCount * (participantCount - 1)
      : participantCount;
  const currentPhaseContributions = currentRound.contributions.filter(
    (c) => c.phase === phase,
  ).length;
  const phaseComplete = currentPhaseContributions >= expectedForPhase;

  return ok({
    debateId: debate.id,
    round: currentRound.roundNumber,
    phase,
    slotId: args.slotId,
    submitted: true,
    phaseProgress: `${currentPhaseContributions}/${expectedForPhase}`,
    phaseComplete,
    nextAction: phaseComplete
      ? `All ${phase} contributions collected. Call swarm_debate(action="next", sessionId="${session.id}", debateId="${debate.id}") to advance to the next phase.`
      : `${expectedForPhase - currentPhaseContributions} more ${phase} submission(s) needed.`,
  });
}

// ── Debate: evaluate ──────────────────────────────────────────────────
function handleDebateEvaluate(
  session: SwarmSession,
  args: { debateId?: string },
): ToolResult {
  if (!args.debateId) return err("Missing required field: debateId");

  const debate = getDebate(session, args.debateId);
  if (!debate) return err(`Debate not found: ${args.debateId}`);

  const currentRound = debate.rounds[debate.rounds.length - 1];
  if (!currentRound) return err("No active round to evaluate.");

  // Score positions using structural heuristics
  const scores = scoreDebatePositions(currentRound, debate);

  // Compute convergence
  const convergence = computeDebateConvergence(debate);

  // Detect sycophancy
  const sycophancy = detectDebateSycophancy(debate);

  // Extract and track per-claim consensus
  const newClaims = extractClaimsFromPositions(debate, currentRound);
  debate.claims.push(...newClaims);
  updateClaimConsensus(debate, currentRound);
  const partialConsensus = getPartialConsensus(debate);

  // Check fast-track eligibility (Round 1 only)
  const fastTrackResult = checkFastTrack(
    debate,
    convergence,
    sycophancy,
    scores,
  );

  // Assign devil's advocate if early consensus detected
  const contrarianResult = !fastTrackResult.eligible
    ? assignContrarian(debate, convergence, scores)
    : { assigned: false, reason: "Fast-track eligible — no contrarian needed" };

  // Build evaluation
  const evaluation = buildDebateEvaluation(
    scores,
    convergence,
    sycophancy,
    debate,
  );

  // Override recommendation if fast-track is eligible
  if (fastTrackResult.eligible) {
    evaluation.recommendation = "converged";
    evaluation.synthesisReady = true;
    evaluation.reasoning = `⚡ FAST-TRACK: ${fastTrackResult.reason}`;
  }

  currentRound.evaluation = evaluation;
  currentRound.completedAt = Date.now();

  // Update debate status based on recommendation
  if (evaluation.recommendation === "converged") {
    debate.status = "converged";
  } else if (evaluation.recommendation === "stalled") {
    debate.status = "stalled";
  } else if (evaluation.recommendation === "escalate") {
    debate.status = "stalled";
  }

  // Determine next action
  let nextAction: string;
  switch (evaluation.recommendation) {
    case "converged":
      nextAction = `🤝 Debate converged! Convergence: ${(evaluation.convergenceScore * 100).toFixed(0)}%.${evaluation.dominantPosition ? ` Strongest position: ${evaluation.dominantPosition}.` : ""}${fastTrackResult.eligible ? " ⚡ Fast-tracked — no further rounds needed." : ""} Call swarm_debate(action="synthesize", sessionId="${session.id}", debateId="${debate.id}") to produce the final synthesis.`;
      break;
    case "continue":
      nextAction = `Debate continues (round ${debate.currentRound}/${debate.maxRounds}). Convergence: ${(evaluation.convergenceScore * 100).toFixed(0)}%, trending ${convergence.trending}.${contrarianResult.assigned ? ` 😈 ${contrarianResult.slotId} assigned as devil's advocate for next round.` : ""} Call swarm_debate(action="next", sessionId="${session.id}", debateId="${debate.id}") for the next round.`;
      break;
    case "stalled":
      nextAction = `⚠️ Debate stalled after ${debate.currentRound} rounds. Convergence stuck at ${(evaluation.convergenceScore * 100).toFixed(0)}%. ${partialConsensus.agreed.length} claims agreed, ${partialConsensus.contested.length} contested. Options: (1) Call swarm_debate(action="synthesize") to force a decision from best positions, or (2) Call swarm_debate(action="escalate") to send to L1 for resolution.`;
      break;
    case "escalate":
      nextAction = `🛑 Escalation recommended: ${evaluation.reasoning}. Call swarm_debate(action="escalate", sessionId="${session.id}", debateId="${debate.id}") to package for L1 resolution.`;
      break;
  }

  return ok({
    debateId: debate.id,
    round: currentRound.roundNumber,
    evaluation: {
      convergence: {
        score: evaluation.convergenceScore,
        delta: evaluation.convergenceDelta,
        trending: convergence.trending,
      },
      sycophancy: {
        score: evaluation.sycophancyScore,
        detected: sycophancy.detected,
        indicators: sycophancy.indicators,
      },
      positionScores: evaluation.positionScores.map((s, i) => ({
        participant: debate.participants[i].slotId,
        ...s,
      })),
      dominantPosition: evaluation.dominantPosition,
      recommendation: evaluation.recommendation,
      reasoning: evaluation.reasoning,
      synthesisReady: evaluation.synthesisReady,
    },
    partialConsensus: {
      agreed: partialConsensus.agreed.map((c) => ({
        id: c.id,
        text: c.text,
        agreeCount: c.agreeSlots.length,
      })),
      contested: partialConsensus.contested.map((c) => ({
        id: c.id,
        text: c.text,
        disagreeSlots: c.disagreeSlots,
      })),
      undecided: partialConsensus.undecided.length,
      consensusRatio: partialConsensus.consensusRatio,
    },
    fastTrack: fastTrackResult,
    contrarian: contrarianResult,
    debateStatus: debate.status,
    nextAction,
  });
}

// ── Debate: synthesize ────────────────────────────────────────────────
function handleDebateSynthesize(
  session: SwarmSession,
  args: { debateId?: string; synthesis?: string },
): ToolResult {
  if (!args.debateId) return err("Missing required field: debateId");

  const debate = getDebate(session, args.debateId);
  if (!debate) return err(`Debate not found: ${args.debateId}`);

  // If synthesis text is provided directly, store it and resolve
  if (args.synthesis) {
    debate.synthesis = args.synthesis;
    debate.status = "resolved";
    debate.resolvedAt = Date.now();

    postToBoard(
      session,
      debate.groupId ?? "orchestrator",
      "debate-synthesis",
      `[${debate.id}] RESOLVED: ${args.synthesis.substring(0, 500)}`,
      debate.initiatorLevel,
      debate.groupId,
      debate.id,
    );

    return ok({
      debateId: debate.id,
      status: "resolved",
      synthesis: debate.synthesis,
      rounds: debate.currentRound,
      nextAction: "Debate resolved. Include the synthesis in your report.",
    });
  }

  // Generate a synthesis prompt
  const synthesisPrompt = buildDebateSynthesisPrompt(debate, session);
  const promptRef = storePrompt(session, synthesisPrompt);

  const synthModel = resolveModel(coderPool[0] ?? "claude-sonnet-4.6");
  const subagentType = getWorkerAgentName(synthModel);

  return ok({
    debateId: debate.id,
    status: debate.status,
    synthesisRequired: true,
    taskCall: {
      subagent_type: subagentType,
      description: `Debate synthesis — ${debate.topic}`,
      promptRef,
      model: synthModel,
    },
    nextAction: [
      `Execute the synthesis task, then call swarm_debate(action="synthesize", sessionId="${session.id}", debateId="${debate.id}", synthesis=<task output>) to resolve the debate.`,
      `Alternatively, you can write your own synthesis and submit it directly.`,
    ].join("\n"),
  });
}

// ── Debate: status ────────────────────────────────────────────────────
function handleDebateStatusAction(
  session: SwarmSession,
  args: { debateId?: string },
): ToolResult {
  if (!args.debateId) {
    return ok({
      sessionId: session.id,
      totalDebates: session.debates.length,
      debates: session.debates.map((d) => ({
        id: d.id,
        topic: d.topic,
        status: d.status,
        trigger: d.trigger,
        groupId: d.groupId,
        round: `${d.currentRound}/${d.maxRounds}`,
        participants: d.participants.length,
        fastTrack: d.fastTrack,
        contrarian: d.contrarian,
        claimsTracked: d.claims.length,
        hasSynthesis: !!d.synthesis,
        hasValidation: !!d.validation,
        validationOutcome: d.validation?.outcome,
        lastEvaluation: d.rounds[d.rounds.length - 1]?.evaluation
          ? {
              convergence:
                d.rounds[d.rounds.length - 1].evaluation!.convergenceScore,
              recommendation:
                d.rounds[d.rounds.length - 1].evaluation!.recommendation,
            }
          : undefined,
      })),
    });
  }

  const debate = getDebate(session, args.debateId);
  if (!debate) return err(`Debate not found: ${args.debateId}`);

  const roundDetails = debate.rounds.map((r) => ({
    round: r.roundNumber,
    phase: r.phase,
    contributions: r.contributions.length,
    evaluation: r.evaluation
      ? {
          convergence: r.evaluation.convergenceScore,
          sycophancy: r.evaluation.sycophancyScore,
          recommendation: r.evaluation.recommendation,
          dominantPosition: r.evaluation.dominantPosition,
          scores: r.evaluation.positionScores.map((s, i) => ({
            participant: debate.participants[i]?.slotId,
            total: s.total,
            summary: s.summary,
          })),
        }
      : undefined,
    completed: !!r.completedAt,
  }));

  return ok({
    debateId: debate.id,
    topic: debate.topic,
    status: debate.status,
    trigger: debate.trigger,
    initiatorLevel: debate.initiatorLevel,
    groupId: debate.groupId,
    participants: debate.participants.map((p) => ({
      slotId: p.slotId,
      agentType: p.agentType,
      isContrarian: debate.contrarian === p.slotId,
    })),
    rounds: roundDetails,
    currentRound: debate.currentRound,
    maxRounds: debate.maxRounds,
    fastTrack: debate.fastTrack,
    contrarian: debate.contrarian,
    claims: {
      total: debate.claims.length,
      agreed: debate.claims.filter((c) => c.status === "agreed").length,
      contested: debate.claims.filter((c) => c.status === "contested").length,
      undecided: debate.claims.filter((c) => c.status === "undecided").length,
      details: debate.claims.slice(0, 10).map((c) => ({
        id: c.id,
        text: c.text.substring(0, 150),
        status: c.status,
        agree: c.agreeSlots.length,
        disagree: c.disagreeSlots.length,
      })),
    },
    synthesis: debate.synthesis,
    validation: debate.validation
      ? {
          outcome: debate.validation.outcome,
          findings: debate.validation.findings,
          reopenedDebateId: debate.validation.reopenedDebateId,
        }
      : undefined,
    escalationContext: debate.escalationContext,
    thresholds: {
      convergence: debate.convergenceThreshold,
      sycophancy: debate.sycophancyThreshold,
      minPositionScore: debate.minPositionScore,
    },
  });
}

// ── Debate: escalate ──────────────────────────────────────────────────
function handleDebateEscalate(
  session: SwarmSession,
  args: { debateId?: string },
): ToolResult {
  if (!args.debateId) return err("Missing required field: debateId");

  const debate = getDebate(session, args.debateId);
  if (!debate) return err(`Debate not found: ${args.debateId}`);

  const escalationCtx = buildEscalationContext(debate, session);
  debate.escalationContext = escalationCtx;
  debate.status = "escalated";

  postToBoard(
    session,
    debate.groupId ?? "orchestrator",
    "debate-escalation",
    `[${debate.id}] ESCALATED: ${debate.topic}\n${escalationCtx.substring(0, 500)}`,
    debate.initiatorLevel,
    debate.groupId,
    debate.id,
  );

  const promptRef = storePrompt(session, escalationCtx);

  return ok({
    debateId: debate.id,
    status: "escalated",
    topic: debate.topic,
    groupId: debate.groupId,
    roundsCompleted: debate.currentRound,
    escalationPromptRef: promptRef,
    escalationContext: escalationCtx,
    nextAction: [
      `Debate "${debate.id}" escalated.`,
      debate.groupId
        ? `Include the escalation in your manager report under "## Escalations". The L1 orchestrator will resolve it.`
        : `Review the escalation context and make a decision. Then call swarm_debate(action="synthesize", sessionId="${session.id}", debateId="${debate.id}", synthesis=<your decision>) to resolve.`,
    ].join("\n"),
  });
}

// ── Debate: validate ──────────────────────────────────────────────────
function handleDebateValidate(
  session: SwarmSession,
  args: {
    debateId?: string;
    validationOutcome?: "confirmed" | "failed" | "partial";
    validationFindings?: string[];
  },
): ToolResult {
  if (!args.debateId) return err("Missing required field: debateId");

  const debate = getDebate(session, args.debateId);
  if (!debate) return err(`Debate not found: ${args.debateId}`);

  if (debate.status !== "resolved") {
    return err(
      `Debate "${args.debateId}" is "${debate.status}" — validation only applies to resolved debates.`,
    );
  }

  // If no outcome provided, create/return the checkpoint for inspection
  if (!args.validationOutcome) {
    const checkpoint = debate.validation ?? createValidationCheckpoint(debate);
    const consensus = getPartialConsensus(debate);

    return ok({
      debateId: debate.id,
      topic: debate.topic,
      synthesis: debate.synthesis,
      validation: {
        status: checkpoint.outcome,
        submittedAt: new Date(checkpoint.submittedAt).toISOString(),
        findings: checkpoint.findings,
      },
      claimsSummary: {
        agreed: consensus.agreed.length,
        contested: consensus.contested.length,
        undecided: consensus.undecided.length,
        consensusRatio: consensus.consensusRatio,
      },
      nextAction: [
        `Validation checkpoint created for debate "${debate.id}".`,
        `After workers implement the synthesis, call swarm_debate(action="validate", sessionId="${session.id}", debateId="${debate.id}", validationOutcome="confirmed|failed|partial", validationFindings=["finding1", "finding2"]) to record the outcome.`,
        `If "failed" or "partial", a new debate will automatically open with the findings as context.`,
      ].join("\n"),
    });
  }

  // Submit validation result
  const findings = args.validationFindings ?? [];
  const { checkpoint, reopened, newDebateId } = submitValidation(
    session,
    debate,
    args.validationOutcome,
    findings,
  );

  // Post to board
  const emoji =
    args.validationOutcome === "confirmed"
      ? "✅"
      : args.validationOutcome === "failed"
        ? "❌"
        : "⚠️";
  postToBoard(
    session,
    debate.groupId ?? "orchestrator",
    "debate-synthesis",
    `${emoji} [${debate.id}] VALIDATION ${args.validationOutcome.toUpperCase()}: ${findings.slice(0, 2).join("; ")}${reopened ? ` → Reopened as ${newDebateId}` : ""}`,
    debate.initiatorLevel,
    debate.groupId,
    debate.id,
  );

  let nextAction: string;
  if (args.validationOutcome === "confirmed") {
    nextAction = `✅ Debate "${debate.id}" synthesis validated. Decision confirmed as correct.`;
  } else if (reopened && newDebateId) {
    nextAction = [
      `${emoji} Validation ${args.validationOutcome}: ${findings.join("; ")}`,
      `New debate "${newDebateId}" opened with prior claims and new evidence.`,
      `Call swarm_debate(action="next", sessionId="${session.id}", debateId="${newDebateId}") to begin the reopened debate.`,
    ].join("\n");
  } else {
    nextAction = `${emoji} Validation recorded but no new debate opened.`;
  }

  return ok({
    debateId: debate.id,
    validationOutcome: args.validationOutcome,
    findings,
    reopened,
    newDebateId,
    checkpoint: {
      outcome: checkpoint.outcome,
      submittedAt: new Date(checkpoint.submittedAt).toISOString(),
      validatedAt: checkpoint.validatedAt
        ? new Date(checkpoint.validatedAt).toISOString()
        : undefined,
    },
    nextAction,
  });
}

// ── swarm_claim ───────────────────────────────────────────────────────
// File ownership claims to prevent conflicts between workers.

export function handleSwarmClaim(args: {
  sessionId: string;
  action: "claim" | "release" | "check" | "list";
  paths?: string[];
  workstreamId?: string;
  groupId?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "claim": {
      if (!args.paths || args.paths.length === 0)
        return err("paths required for claim action");
      if (!args.workstreamId)
        return err("workstreamId required for claim action");
      if (!args.groupId) return err("groupId required for claim action");

      const result = claimFiles(
        session,
        args.paths,
        args.workstreamId,
        args.groupId,
      );

      if (result.conflicts.length > 0) {
        postToBoard(
          session,
          args.workstreamId,
          "finding",
          `⚠️ File claim conflicts: ${result.conflicts.map((c) => `${c.path} (owned by ${c.owner})`).join(", ")}`,
          "L3",
          args.groupId,
        );
      }

      return ok({
        claimed: result.claimed,
        conflicts: result.conflicts,
        totalActiveClaims: getAllActiveClaims(session).length,
        nextAction:
          result.conflicts.length > 0
            ? `⚠️ ${result.conflicts.length} file(s) already claimed by other workstreams. Coordinate with the owners or ask your L2 manager to resolve.`
            : `✅ ${result.claimed.length} file(s) claimed for ${args.workstreamId}.`,
      });
    }

    case "release": {
      if (!args.paths || args.paths.length === 0)
        return err("paths required for release action");
      if (!args.workstreamId)
        return err("workstreamId required for release action");

      const released = releaseFiles(session, args.paths, args.workstreamId);
      return ok({
        released,
        nextAction: `✅ ${released.length} file(s) released by ${args.workstreamId}.`,
      });
    }

    case "check": {
      if (!args.paths || args.paths.length === 0)
        return err("paths required for check action");

      const claims = checkFileClaims(session, args.paths);
      return ok({
        claims,
        unclaimed: args.paths.filter((p) => !claims.find((c) => c.path === p)),
        nextAction:
          claims.length > 0
            ? `${claims.length} file(s) are claimed: ${claims.map((c) => `${c.path} → ${c.claimedBy}`).join(", ")}`
            : `All ${args.paths.length} file(s) are unclaimed and available.`,
      });
    }

    case "list": {
      const claims = getAllActiveClaims(session);
      const byGroup = new Map<string, typeof claims>();
      for (const c of claims) {
        const arr = byGroup.get(c.groupId) ?? [];
        arr.push(c);
        byGroup.set(c.groupId, arr);
      }

      return ok({
        totalClaims: claims.length,
        byGroup: Object.fromEntries(byGroup),
        nextAction: `${claims.length} active file claim(s) across ${byGroup.size} group(s).`,
      });
    }

    default:
      return err(`Unknown claim action: ${args.action}`);
  }
}

// ── swarm_memory ──────────────────────────────────────────────────────
// Pattern memory for workers to store and retrieve successful approaches.

export async function handleSwarmMemory(args: {
  sessionId: string;
  action: "search" | "store" | "list";
  query?: string;
  taskType?: string;
  approach?: string;
  filesInvolved?: string[];
  qualityScore?: number;
  keyDecisions?: string[];
  tags?: string[];
  limit?: number;
}): Promise<ToolResult> {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "search": {
      if (!args.query) return err("query required for search action");

      const results = await memoryStore.searchSemantic(
        args.query,
        args.limit ?? 5,
      );

      return ok({
        matchCount: results.length,
        patterns: results.map((p) => ({
          id: p.id,
          taskType: p.taskType,
          approach: p.approach,
          qualityScore: p.qualityScore,
          confidence: p.confidence,
          useCount: p.useCount,
          tags: p.tags,
          keyDecisions: p.keyDecisions,
          filesInvolved: p.filesInvolved,
          relevance: p.relevance,
        })),
        nextAction:
          results.length > 0
            ? `Found ${results.length} relevant pattern(s) via semantic search. Inject context into worker prompts.`
            : `No matching patterns found. Worker will start fresh.`,
      });
    }

    case "store": {
      if (!args.taskType) return err("taskType required for store action");
      if (!args.approach) return err("approach required for store action");
      if (!args.qualityScore)
        return err("qualityScore required for store action");
      if (args.qualityScore < 8) {
        return err(
          `Quality score must be ≥8 to store pattern (got ${args.qualityScore}). Only high-quality patterns are stored.`,
        );
      }

      const entry = await memoryStore.storePattern({
        taskType: args.taskType,
        approach: args.approach,
        filesInvolved: args.filesInvolved ?? [],
        qualityScore: args.qualityScore,
        keyDecisions: args.keyDecisions ?? [],
        tags: args.tags ?? [],
        confidence: 1.0,
        useCount: 0,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: Date.now(),
        sessionId: session.id,
      });

      return ok({
        patternId: entry.id,
        taskType: entry.taskType,
        qualityScore: entry.qualityScore,
        nextAction: `Pattern "${entry.id}" stored with semantic embedding (score: ${entry.qualityScore}/10). Available for future workers.`,
      });
    }

    case "list": {
      const allPatterns = memoryStore.getAllPatterns();
      return ok({
        totalPatterns: allPatterns.length,
        patterns: allPatterns.map((p) => ({
          id: p.id,
          taskType: p.taskType,
          qualityScore: p.qualityScore,
          confidence: p.confidence,
          useCount: p.useCount,
          tags: p.tags,
        })),
        nextAction: `${allPatterns.length} pattern(s) in persistent memory.`,
      });
    }

    default:
      return err(`Unknown memory action: ${args.action}`);
  }
}

// ── swarm_consensus ───────────────────────────────────────────────────
// Lightweight worker consensus for complex tasks.

export function handleSwarmConsensus(args: {
  sessionId: string;
  action: "start" | "propose" | "evaluate" | "status";
  groupId?: string;
  topic?: string;
  consensusId?: string;
  workstreamId?: string;
  slotId?: string;
  model?: string;
  content?: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "start": {
      if (!args.groupId) return err("groupId required for start action");
      if (!args.topic) return err("topic required for start action");

      const consensus = createConsensus(session, args.groupId, args.topic);

      postToBoard(
        session,
        args.groupId,
        "status",
        `🗳️ Consensus session started: "${args.topic}" (${consensus.id})`,
        "L2",
        args.groupId,
      );

      return ok({
        consensusId: consensus.id,
        groupId: args.groupId,
        topic: args.topic,
        status: "collecting",
        nextAction: [
          `Consensus session "${consensus.id}" created.`,
          `Spawn 2-3 workers in proposal mode (mode="propose") with the topic.`,
          `Each worker submits via swarm_consensus(action="propose", consensusId="${consensus.id}", slotId="proposer-N", content=<proposal>)`,
          `After all proposals are in, call swarm_consensus(action="evaluate", consensusId="${consensus.id}")`,
        ].join("\n"),
      });
    }

    case "propose": {
      if (!args.consensusId)
        return err("consensusId required for propose action");
      if (!args.content) return err("content required for propose action");
      if (!args.slotId) return err("slotId required for propose action");

      const consensus = getConsensus(session, args.consensusId);
      if (!consensus) return err(`Consensus not found: ${args.consensusId}`);
      if (consensus.status !== "collecting")
        return err(`Consensus is ${consensus.status}, not accepting proposals`);

      submitProposal(
        consensus,
        args.workstreamId ?? "unknown",
        args.slotId,
        args.model ?? "unknown",
        args.content,
      );

      return ok({
        consensusId: consensus.id,
        proposalCount: consensus.proposals.length,
        slotId: args.slotId,
        nextAction: `Proposal from ${args.slotId} recorded (${consensus.proposals.length} total). Submit more or call evaluate.`,
      });
    }

    case "evaluate": {
      if (!args.consensusId)
        return err("consensusId required for evaluate action");

      const consensus = getConsensus(session, args.consensusId);
      if (!consensus) return err(`Consensus not found: ${args.consensusId}`);

      const result = evaluateConsensus(consensus);

      postToBoard(
        session,
        consensus.groupId,
        "decision",
        `🗳️ Consensus "${consensus.id}": convergence=${(result.convergenceScore * 100).toFixed(0)}% → ${result.recommendation}`,
        "L2",
        consensus.groupId,
      );

      let nextAction: string;
      if (result.recommendation === "implement-best") {
        const best = consensus.proposals.reduce((a, b) =>
          a.content.length > b.content.length ? a : b,
        );
        consensus.selectedProposal = best.slotId;
        nextAction = [
          `✅ Proposals converged (${(result.convergenceScore * 100).toFixed(0)}%).`,
          `Best proposal: ${best.slotId}. Dispatch that worker in implement mode.`,
        ].join("\n");
      } else if (result.recommendation === "debate") {
        consensus.status = "escalated";
        nextAction = [
          `⚠️ Proposals diverged (${(result.convergenceScore * 100).toFixed(0)}%).`,
          `Escalate to L2 debate protocol: swarm_debate(action="start", topic="${consensus.topic}", trigger="disagreement", groupId="${consensus.groupId}")`,
        ].join("\n");
      } else {
        nextAction = `Need more proposals before evaluation (currently ${consensus.proposals.length}).`;
      }

      return ok({
        consensusId: consensus.id,
        convergenceScore: result.convergenceScore,
        recommendation: result.recommendation,
        proposalCount: consensus.proposals.length,
        selectedProposal: consensus.selectedProposal,
        nextAction,
      });
    }

    case "status": {
      if (!args.consensusId)
        return err("consensusId required for status action");

      const consensus = getConsensus(session, args.consensusId);
      if (!consensus) return err(`Consensus not found: ${args.consensusId}`);

      return ok({
        consensusId: consensus.id,
        groupId: consensus.groupId,
        topic: consensus.topic,
        status: consensus.status,
        proposalCount: consensus.proposals.length,
        convergenceScore: consensus.convergenceScore,
        selectedProposal: consensus.selectedProposal,
        proposals: consensus.proposals.map((p) => ({
          slotId: p.slotId,
          contentPreview:
            p.content.substring(0, 200) + (p.content.length > 200 ? "..." : ""),
        })),
      });
    }

    default:
      return err(`Unknown consensus action: ${args.action}`);
  }
}

// ── swarm_learn ───────────────────────────────────────────────────────
// Self-learning loop: retrieve, judge, distill, consolidate, route, stats.

export async function handleSwarmLearn(args: {
  sessionId: string;
  action: "retrieve" | "judge" | "distill" | "consolidate" | "route" | "stats";
  taskDescription?: string;
  scores?: Array<{ workstream: string; score: number; criticalIssues: number }>;
  metadata?: {
    modelUsed?: string;
    durationMs?: number;
    whatWorked?: string[];
    whatFailed?: string[];
  };
}): Promise<ToolResult> {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "retrieve": {
      const desc = args.taskDescription ?? session.task;
      const result = await retrieve(session.id, desc);
      session.patternIdsUsed = result.patternIds;
      return ok({
        matchCount: result.patterns.length,
        patternIds: result.patternIds,
        injectionContext: result.injectionContext,
        nextAction:
          result.patterns.length > 0
            ? `Found ${result.patterns.length} relevant pattern(s). Inject into worker prompts.`
            : "No prior patterns found.",
      });
    }

    case "judge": {
      if (!args.scores) return err("scores required for judge action");
      const result = await judge(session, args.scores, args.metadata);
      return ok({
        outcomeId: result.outcome.id,
        avgScore: result.avgScore,
        shouldDistill: result.shouldDistill,
        nextAction: result.shouldDistill
          ? `Score ${result.avgScore} >= 8. Call swarm_learn with action="distill" to extract pattern.`
          : `Score ${result.avgScore} recorded. No pattern extraction needed.`,
      });
    }

    case "distill": {
      const result = await distill(session);
      return ok({
        action: result.action,
        patternId: result.patternId,
        nextAction:
          result.action === "stored"
            ? `New pattern "${result.patternId}" extracted and stored.`
            : `Near-duplicate found. Boosted confidence on "${result.patternId}".`,
      });
    }

    case "consolidate": {
      const result = await consolidate();
      return ok({
        ...result,
        nextAction: `Consolidated: ${result.merged} merged, ${result.pruned} pruned, ${result.decayed} decayed, ${result.expired} expired. ${result.remaining} patterns remaining.`,
      });
    }

    case "route": {
      const desc = args.taskDescription ?? session.task;
      const result = await route(desc);
      return ok({
        recommendedModel: result.model,
        hints: result.hints,
        confidence: result.confidence,
        nextAction: result.model
          ? `Recommend model "${result.model}" (confidence: ${result.confidence}).`
          : "No strong model recommendation. Use default.",
      });
    }

    case "stats": {
      return ok(getStats());
    }

    default:
      return err(`Unknown learn action: ${args.action}`);
  }
}

// ── swarm_watch ───────────────────────────────────────────────────────
// Background worker subscription management.

export function handleSwarmWatch(args: {
  sessionId: string;
  action: "subscribe" | "list" | "check";
  workerType?: string;
  triggerEvent?: string;
  config?: Record<string, unknown>;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "subscribe": {
      if (!args.workerType) return err("workerType required for subscribe");
      if (!args.triggerEvent) return err("triggerEvent required for subscribe");

      const validTypes = ["audit", "optimize", "testgaps", "document"];
      if (!validTypes.includes(args.workerType)) {
        return err(
          `Invalid workerType: "${args.workerType}". Valid: ${validTypes.join(", ")}`,
        );
      }
      const validTriggers = ["gate_pass", "gate_fail", "session_end", "manual"];
      if (!validTriggers.includes(args.triggerEvent)) {
        return err(
          `Invalid triggerEvent: "${args.triggerEvent}". Valid: ${validTriggers.join(", ")}`,
        );
      }

      const record = workerRegistry.subscribe(
        session.id,
        args.workerType as any,
        args.triggerEvent as any,
        args.config,
      );
      return ok({
        workerId: record.id,
        workerType: record.workerType,
        triggerEvent: record.triggerEvent,
        description: WORKER_TYPE_DESCRIPTIONS[record.workerType],
        triggerDescription: TRIGGER_DESCRIPTIONS[record.triggerEvent],
        nextAction: `Worker "${record.id}" subscribed to "${record.triggerEvent}" events.`,
      });
    }

    case "list": {
      const subs = workerRegistry.getSubscriptions(session.id);
      return ok({
        totalSubscriptions: subs.length,
        subscriptions: subs.map((w) => ({
          id: w.id,
          workerType: w.workerType,
          triggerEvent: w.triggerEvent,
          status: w.status,
          description: WORKER_TYPE_DESCRIPTIONS[w.workerType],
        })),
        availableTypes: Object.entries(WORKER_TYPE_DESCRIPTIONS).map(
          ([k, v]) => ({ type: k, description: v }),
        ),
        availableTriggers: Object.entries(TRIGGER_DESCRIPTIONS).map(
          ([k, v]) => ({ event: k, description: v }),
        ),
      });
    }

    case "check": {
      if (!args.triggerEvent) return err("triggerEvent required for check");
      const ready = workerRegistry.checkTriggers(
        session.id,
        args.triggerEvent as any,
      );
      return ok({
        readyWorkers: ready.length,
        workers: ready.map((w) => ({
          id: w.id,
          workerType: w.workerType,
          description: WORKER_TYPE_DESCRIPTIONS[w.workerType],
        })),
      });
    }

    default:
      return err(`Unknown watch action: ${args.action}`);
  }
}

// ── swarm_worker ──────────────────────────────────────────────────────
// Manual worker dispatch and results retrieval.

export function handleSwarmWorker(args: {
  sessionId: string;
  action: "dispatch" | "status" | "results" | "complete";
  workerType?: string;
  workerId?: string;
  files?: string[];
  context?: string;
  findings?: string[];
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "dispatch": {
      if (!args.workerType) return err("workerType required for dispatch");

      const record = workerRegistry.subscribe(
        session.id,
        args.workerType as any,
        "manual",
      );
      const dispatch = workerRegistry.buildDispatch(record, {
        files: args.files,
        sessionTask: args.context ?? session.task,
      });

      return ok({
        workerId: dispatch.workerId,
        taskCall: {
          subagent_type: dispatch.agent,
          description: `${WORKER_TYPE_DESCRIPTIONS[args.workerType as keyof typeof WORKER_TYPE_DESCRIPTIONS] ?? args.workerType} worker`,
          prompt: dispatch.prompt,
          model: dispatch.model,
        },
        nextAction: `Dispatch worker with task() using the taskCall params above. After completion, call swarm_worker with action="complete" and the findings.`,
      });
    }

    case "status": {
      const subs = workerRegistry.getSubscriptions(session.id);
      return ok({
        workers: subs.map((w) => ({
          id: w.id,
          workerType: w.workerType,
          status: w.status,
          completedAt: w.completedAt,
          findingsCount: w.findings.length,
        })),
      });
    }

    case "results": {
      if (!args.workerId) return err("workerId required for results");
      const findings = workerRegistry.getFindings(args.workerId);
      return ok({
        workerId: args.workerId,
        findings,
        nextAction:
          findings.length > 0
            ? `Worker produced ${findings.length} finding(s). Review and act on them.`
            : "No findings recorded for this worker.",
      });
    }

    case "complete": {
      if (!args.workerId) return err("workerId required for complete");
      if (!args.findings) return err("findings required for complete");

      workerRegistry.complete(args.workerId, args.findings);

      // Post findings to board
      for (const finding of args.findings) {
        postToBoard(session, "background-worker", "background", finding, "L1");
      }

      return ok({
        workerId: args.workerId,
        status: "completed",
        findingsPosted: args.findings.length,
        nextAction: `Worker completed. ${args.findings.length} finding(s) posted to board.`,
      });
    }

    default:
      return err(`Unknown worker action: ${args.action}`);
  }
}

// ── swarm_validate ────────────────────────────────────────────────────

export function handleSwarmValidate(args: {
  sessionId: string;
  workstream: string;
  results: Array<{
    name: string;
    category: "static" | "unit" | "integration";
    status: "pass" | "fail" | "skip" | "error";
    actual?: string;
    expected?: string;
    error?: string;
  }>;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);
  if (!args.workstream) return err("Missing required field: workstream");
  if (!args.results || !Array.isArray(args.results))
    return err("Missing required field: results (array)");

  const summary = {
    total: args.results.length,
    passed: args.results.filter((r) => r.status === "pass").length,
    failed: args.results.filter((r) => r.status === "fail").length,
    skipped: args.results.filter(
      (r) => r.status === "skip" || r.status === "error",
    ).length,
  };

  const validationResult: ValidationResult = {
    workstream: args.workstream,
    tests: args.results,
    summary,
  };

  session.validationResults.push(validationResult);

  // Post summary to board
  const passRate =
    summary.total > 0
      ? ((summary.passed / summary.total) * 100).toFixed(0)
      : "0";
  postToBoard(
    session,
    args.workstream,
    "validation",
    `Validation: ${summary.passed}/${summary.total} passed (${passRate}%) — ${summary.failed} failed, ${summary.skipped} skipped`,
    "L1",
  );

  return ok({
    workstream: args.workstream,
    summary,
    nextAction:
      summary.failed > 0
        ? `${summary.failed} test(s) failed. Results stored. Continue submitting remaining verifier outputs.`
        : `All ${summary.total} test(s) passed. Results stored.`,
  });
}

// ── Validation Gate ───────────────────────────────────────────────────

function handleValidationGate(
  session: SwarmSession,
  phase: PhaseState,
): ToolResult {
  const results = session.validationResults;

  if (results.length === 0) {
    // No validation results — auto-pass (no tests were defined)
    phase.status = "done";
    advancePhase(session.id);
    return ok({
      proceed: true,
      sessionId: session.id,
      reason: "No validation results submitted. Validation gate auto-passed.",
      nextAction: `Call swarm_next with sessionId "${session.id}" to continue.`,
    });
  }

  // Aggregate
  const totalTests = results.reduce((s, r) => s + r.summary.total, 0);
  const totalPassed = results.reduce((s, r) => s + r.summary.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.summary.failed, 0);
  const passRate = totalTests > 0 ? totalPassed / totalTests : 0;

  // Static failures are hard blockers (code doesn't compile)
  const staticFailures = results.flatMap((r) =>
    r.tests.filter((t) => t.category === "static" && t.status === "fail"),
  );

  // Check per-workstream: no workstream with 0% pass rate
  const zeroPassWorkstreams = results.filter(
    (r) => r.summary.total > 0 && r.summary.passed === 0,
  );

  // Pass criteria:
  // 1. Zero static failures (build must compile)
  // 2. Pass rate >= 80% overall
  // 3. No workstream with 0% pass rate
  const allPass = totalFailed === 0;
  const passWithWarnings =
    passRate >= 0.8 &&
    staticFailures.length === 0 &&
    zeroPassWorkstreams.length === 0;

  const validationSummary = {
    totalTests,
    totalPassed,
    totalFailed,
    passRate: Math.round(passRate * 100),
    staticFailures: staticFailures.length,
    workstreamsValidated: results.length,
    zeroPassWorkstreams: zeroPassWorkstreams.map((r) => r.workstream),
  };

  if (allPass) {
    phase.status = "done";
    advancePhase(session.id);
    return ok({
      proceed: true,
      sessionId: session.id,
      validation: validationSummary,
      nextAction: `All ${totalTests} tests passed. Call swarm_next with sessionId "${session.id}" to continue.`,
    });
  }

  if (passWithWarnings) {
    const failingTests = results.flatMap((r) =>
      r.tests
        .filter((t) => t.status === "fail")
        .map((t) => ({
          workstream: r.workstream,
          name: t.name,
          category: t.category,
          expected: t.expected,
          actual: t.actual,
        })),
    );

    phase.status = "done";
    advancePhase(session.id);
    return ok({
      proceed: true,
      warnings: true,
      sessionId: session.id,
      validation: validationSummary,
      failingTests,
      nextAction: `Validation gate passed with warnings (${Math.round(passRate * 100)}% pass rate). ${totalFailed} test(s) failing but within threshold. Call swarm_next with sessionId "${session.id}" to continue.`,
    });
  }

  // Gate fails — build retry instructions
  const failingDetails = results
    .filter((r) => r.summary.failed > 0)
    .map((r) => ({
      workstream: r.workstream,
      failedTests: r.tests
        .filter((t) => t.status === "fail")
        .map((t) => ({
          name: t.name,
          category: t.category,
          expected: t.expected,
          actual: t.actual,
          error: t.error,
        })),
    }));

  const blockReason =
    staticFailures.length > 0
      ? `Build failures detected (${staticFailures.length} static test(s) failed). Code does not compile.`
      : zeroPassWorkstreams.length > 0
        ? `Workstream(s) with zero pass rate: ${zeroPassWorkstreams.map((r) => r.workstream).join(", ")}`
        : `Overall pass rate ${Math.round(passRate * 100)}% is below 80% threshold.`;

  return ok({
    proceed: false,
    sessionId: session.id,
    validation: validationSummary,
    blockReason,
    failingDetails,
    nextAction: [
      `Validation gate FAILED: ${blockReason}`,
      `To resolve:`,
      `  1. Fix the failing tests in the affected workstreams`,
      `  2. Re-run the build phase for affected workstreams`,
      `  3. Re-run validate-integration (call swarm_next after fixing)`,
      `  4. Call swarm_gate on validate-gate again`,
    ].join("\n"),
  });
}

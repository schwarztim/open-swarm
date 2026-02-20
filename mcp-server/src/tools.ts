import {
  type Tier,
  type ExecutionMode,
  type RatePreset,
  type PhaseDefinition,
  type SwarmSession,
  type PhaseState,
  type BoardMessage,
  type AgentGroup,
  TIER_PHASES,
  RATE_PRESETS,
  resolveRateLimit,
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
  premiumPool,
  coderPool,
  criticPool,
  fastPool,
  stripIdentity,
} from './state.js';

// ── Helpers ───────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: string; text: string }> };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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
  const avgCurrent = currentScores.reduce((s, c) => s + c.score, 0) / currentScores.length;

  // Find previous round scores
  const prevRound = currentRound - 1;
  const prevScores = session.rounds.filter((r) => r.round === prevRound);
  const avgPrev = prevScores.length > 0
    ? prevScores.reduce((s, r) => s + r.score, 0) / prevScores.length
    : 0;

  const delta = prevScores.length > 0 ? avgCurrent - avgPrev : avgCurrent;
  const stalling = prevScores.length > 0 && Math.abs(delta) < 0.5;

  // Collect all round averages for trend
  const roundAvgs: Array<{ round: number; avg: number }> = [];
  const allRounds = new Set(session.rounds.map((r) => r.round));
  for (const r of allRounds) {
    const scores = session.rounds.filter((s) => s.round === r);
    roundAvgs.push({ round: r, avg: scores.reduce((s, c) => s + c.score, 0) / scores.length });
  }
  roundAvgs.push({ round: currentRound, avg: avgCurrent });
  roundAvgs.sort((a, b) => a.round - b.round);

  return {
    currentAvg: Math.round(avgCurrent * 100) / 100,
    previousAvg: prevScores.length > 0 ? Math.round(avgPrev * 100) / 100 : null,
    delta: Math.round(delta * 100) / 100,
    stalling,
    stallingWarning: stalling ? 'Quality improvement < 0.5 across rounds. Consider changing approach or models.' : undefined,
    trend: roundAvgs,
    totalRounds: currentRound,
  };
}

// ── swarm_init ────────────────────────────────────────────────────────

export function handleSwarmInit(args: {
  task: string;
  tier?: Tier;
  fileCount?: number;
  executionMode?: ExecutionMode;
  concurrency?: number | string;  // number or preset name
}): ToolResult {
  const { task, fileCount } = args;
  if (!task) return err('Missing required field: task');

  const tier = args.tier ?? selectTier(task, fileCount);

  // Resolve concurrency: accept a preset name ("conservative", "standard", etc.) or a number
  let resolvedConcurrency: number;
  if (args.concurrency === undefined || args.concurrency === null) {
    resolvedConcurrency = resolveRateLimit(undefined);
  } else if (typeof args.concurrency === 'string' && args.concurrency in RATE_PRESETS) {
    resolvedConcurrency = resolveRateLimit(args.concurrency as RatePreset);
  } else {
    resolvedConcurrency = resolveRateLimit(Number(args.concurrency));
  }

  const session = createSession(tier, task, args.executionMode, resolvedConcurrency);
  const phaseDefs = TIER_PHASES[tier];

  // Seed default workstreams for parallel tiers
  const hasParallel = phaseDefs.some((p) => p.parallel);
  if (hasParallel && session.workstreams.length === 0) {
    let count = 2;
    if (tier === 'unleashed') count = 32;
    else if (tier === 'blitz' || (fileCount && fileCount > 20)) count = 4;
    
    for (let i = 0; i < count; i++) {
      session.workstreams.push({
        id: `ws-${i}`,
        description: `Workstream ${i}`,
        files: [],
        modelAssigned: getCoderModel(i),
        dependencies: [],
        status: 'ready',
      });
    }
  }

  // Build rate limit info for response
  const matchedPreset = Object.entries(RATE_PRESETS).find(([_, v]) => v.concurrency === resolvedConcurrency);
  const rateLimitInfo = {
    concurrency: resolvedConcurrency > 0 ? resolvedConcurrency : 'unlimited',
    preset: matchedPreset ? matchedPreset[0] : 'custom',
    maxEstimatedAgents: resolvedConcurrency > 0 ? resolvedConcurrency * 5 : 'unlimited',
    description: matchedPreset ? matchedPreset[1].description : `Custom: ${resolvedConcurrency} concurrent L2 managers`,
    recommendedPlan: matchedPreset ? matchedPreset[1].plan : 'depends on usage',
  };

  return ok({
    sessionId: session.id,
    tier,
    totalPhases: phaseDefs.length,
    firstPhase: phaseDefs[0].name,
    executionMode: session.executionMode,
    rateLimit: rateLimitInfo,
    availablePresets: Object.fromEntries(
      Object.entries(RATE_PRESETS).map(([k, v]) => [k, { concurrency: v.concurrency, agents: v.maxAgents, plan: v.plan }])
    ),
    outputDir: session.executionMode === 'subprocess' ? session.outputDir : undefined,
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
    session.phases[session.currentPhaseIndex].status === 'done'
  ) {
    const nextIdx = session.currentPhaseIndex + 1;
    if (nextIdx >= session.phases.length) {
      return ok({
        sessionId: session.id,
        complete: true,
        nextAction: 'All phases complete. Swarm finished.',
      });
    }
    session.currentPhaseIndex = nextIdx;
  }

  const phaseIdx = session.currentPhaseIndex;
  const phaseDef = getPhaseDefinition(session);
  const phase = session.phases[phaseIdx];
  const history = buildAnonymousHistory(session);

  // ── Subprocess mode ──
  if (session.executionMode === 'subprocess') {
    return handleSwarmNextSubprocess(session, phaseDef, phase, phaseIdx, history);
  }

  // ── Task mode with 3-tier hierarchy ──
  // Parallel phases: dispatch L2 managers (not L3 workers directly)
  // Each L2 manager spawns its own L3 workers via task()
  if (phaseDef.parallel) {
    // Create agent groups if not yet done for this phase
    if (session.agentGroups.length === 0 || session.agentGroups.every(g => g.status === 'done')) {
      groupWorkstreams(session);
    }

    // Count in-flight managers (dispatched but not done)
    const inFlight = session.agentGroups.filter(g => g.status === 'dispatched').length;
    const limit = session.concurrency > 0 ? session.concurrency : Infinity;
    const availableSlots = Math.max(0, limit - inFlight);

    // If concurrency is saturated, tell the orchestrator to wait
    if (availableSlots === 0) {
      const dispatched = session.agentGroups.filter(g => g.status === 'dispatched');
      const statusBoard = `${session.outputDir}/status-board.md`;
      return ok({
        sessionId: session.id,
        phase: phaseDef.name,
        phaseIndex: phaseIdx,
        parallel: true,
        rateLimited: true,
        concurrency: session.concurrency,
        inFlight,
        waitingFor: dispatched.map(g => g.id),
        statusBoard,
        nextAction: [
          `⏳ Rate limit: ${session.concurrency} concurrent managers max, ${inFlight} in-flight.`,
          `Wait for current managers to complete, then call swarm_submit for each.`,
          `After submitting, call swarm_next again to dispatch the next wave.`,
          ``,
          `Monitor progress: bash("cat ${statusBoard} 2>/dev/null || echo 'Waiting...'")`,
        ].join('\n'),
      });
    }

    // Release only up to the concurrency limit
    const pending = session.agentGroups.filter(g => g.status === 'pending');
    const toDispatch = pending.slice(0, availableSlots);
    const managerCalls = [];

    for (const group of toDispatch) {
      const managerPrompt = buildManagerPrompt(session, group, phaseDef.name, history);
      const promptRef = storePrompt(session, managerPrompt);
      group.status = 'dispatched';

      managerCalls.push({
        subagent_type: group.managerAgent,
        description: `${phaseDef.name} ${group.id} (${group.workerSlots.length} workers)`,
        promptRef,
        groupId: group.id,
        workerCount: group.workerSlots.length,
        workstreams: group.workerSlots.map(ws => ws.workstreamId),
      });
    }

    const remainingPending = session.agentGroups.filter(g => g.status === 'pending').length;
    const totalGroups = session.agentGroups.length;

    phase.status = 'in_progress';
    const statusBoard = `${session.outputDir}/status-board.md`;
    return ok({
      sessionId: session.id,
      phase: phaseDef.name,
      phaseIndex: phaseIdx,
      parallel: true,
      hierarchy: 'L1 → L2 managers → L3 workers',
      wave: {
        dispatching: managerCalls.length,
        inFlight: inFlight + managerCalls.length,
        remaining: remainingPending,
        total: totalGroups,
        concurrency: session.concurrency > 0 ? session.concurrency : 'unlimited',
      },
      totalWorkers: session.workstreams.length,
      statusBoard,
      managerCalls,
      nextAction: [
        `Dispatch ${managerCalls.length} L2 manager(s)${remainingPending > 0 ? ` (wave — ${remainingPending} more queued, concurrency=${session.concurrency})` : ''}. For EACH managerCall:`,
        `  1. Call swarm_dispatch(sessionId="${session.id}", promptRef=managerCall.promptRef, subagent_type=managerCall.subagent_type, description=managerCall.description)`,
        `  2. Call task(subagent_type=result.subagent_type, description=result.description, prompt=result.prompt)`,
        ``,
        `After dispatching, MONITOR the status board:`,
        `  bash("cat ${statusBoard} 2>/dev/null || echo 'No updates yet'")`,
        ``,
        `When each manager task() completes:`,
        `  3. Read the manager's report (the task output)`,
        `  4. Check for ESCALATIONS — if any, YOU (the boss) make the decision`,
        `  5. Call swarm_submit(sessionId="${session.id}", output=<manager report>)`,
        `  6. Call swarm_relay to post cross-team findings for the next group`,
        remainingPending > 0
          ? `  7. Call swarm_next again — the server will release the next wave of managers.`
          : '',
      ].filter(Boolean).join('\n'),
    });
  }

  // Single (non-parallel) task — dispatched directly as L3 worker
  const prompt = `${history}\n\nExecute the "${phaseDef.name}" phase for this task.`;
  const desc = `${phaseDef.name} phase`;
  const taskCall = buildTaskCall(session, phaseDef, desc, prompt);
  phase.status = 'in_progress';

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
        ? `\nWorkstream: ${ws.id} — ${ws.description}\nFiles: ${ws.files.join(', ') || 'TBD'}`
        : `\nWorkstream: ws-${i}`;
      const boardCtx = ws ? buildBoardContext(session, ws.id) : '';
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

    phase.status = 'in_progress';
    return ok({
      sessionId: session.id,
      phase: phaseDef.name,
      phaseIndex: phaseIdx,
      parallel: true,
      executionMode: 'subprocess',
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

  phase.status = 'in_progress';
  return ok({
    sessionId: session.id,
    phase: phaseDef.name,
    phaseIndex: phaseIdx,
    parallel: false,
    executionMode: 'subprocess',
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

  if (phase.status !== 'in_progress') {
    return err(`Phase "${phase.name}" is "${phase.status}", expected "in_progress".`);
  }

  // Store output
  phase.outputs.push(args.output);
  if (args.agentId) phase.agentIds.push(args.agentId);

  // Track L2 manager group completion
  const groupIndex = phase.outputs.length - 1;
  const group = session.agentGroups[groupIndex];
  if (group) {
    group.status = 'done';
    group.report = args.output;
    // Post L2 report to board at group level
    postToBoard(session, group.id, 'report', args.output, 'L2', group.id);
    // Mark all workstreams in this group as done
    for (const slot of group.workerSlots) {
      const ws = session.workstreams.find(w => w.id === slot.workstreamId);
      if (ws) ws.status = 'done';
    }
  } else {
    // Non-grouped submit (single-task phases)
    const wsIndex = phase.outputs.length - 1;
    const ws = session.workstreams[wsIndex];
    const wsId = ws?.id ?? `ws-${wsIndex}`;
    postToBoard(session, wsId, 'finding', args.output);
    if (ws) ws.status = 'done';
  }

  // Add anonymized history entry
  const currentRound = session.rounds.length > 0
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
    ? (session.agentGroups.length > 0 ? session.agentGroups.length : workstreamCount(session))
    : 1;
  const allCollected = phase.outputs.length >= expectedOutputs;

  if (allCollected) {
    phase.status = 'done';
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
      if (nextDef.name.startsWith('merge_')) {
        nextAction = `Phase complete. Call swarm_merge with sessionId "${session.id}" and the collected outputs.`;
      } else {
        nextAction = `Phase complete. Call swarm_next with sessionId "${session.id}" to advance.`;
      }
    } else {
      nextAction = 'All phases complete. Swarm finished.';
    }
  }

  return ok({
    sessionId: session.id,
    phase: phase.name,
    phaseStatus: phase.status,
    outputsCollected: phase.outputs.length,
    outputsExpected: expectedOutputs,
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
  if (phaseIdx >= session.phases.length) return err('No more phases to merge.');

  const mergeDef = getPhaseDefinition(session, phaseIdx);
  const mergePhase = session.phases[phaseIdx];

  if (!mergeDef.name.startsWith('merge_')) {
    return err(`Next phase "${mergeDef.name}" is not a merge phase.`);
  }

  // Build anonymous merge prompt
  const contributorOutputs = (args.outputs ?? [])
    .map((o, i) => `=== Contributor ${i + 1} ===\n${stripIdentity(o)}`)
    .join('\n\n');

  // Compute convergence to guide synthesis
  const currentRound = session.rounds.length > 0
    ? Math.max(...session.rounds.map((r) => r.round))
    : 0;
  const currentScores = session.rounds.filter(r => r.round === currentRound);
  const convergence = computeConvergence(session, currentRound, currentScores);

  let guidance = '';
  if (convergence.stalling) {
    guidance = 'CRITICAL: The swarm is stalling (low convergence). Do NOT just average the contributions. Look for novel, outlier ideas in the contributions that might break the deadlock. Be bold in your synthesis.';
  } else if (convergence.delta > 0.5) {
    guidance = 'The swarm is converging well. Synthesize the contributions to refine the details and polish the solution. Focus on consistency.';
  } else {
    guidance = 'Synthesize the contributions. Look for the strongest elements of each approach.';
  }

  const mergePrompt = [
    buildAnonymousHistory(session),
    '',
    '--- MERGE TASK ---',
    'Multiple contributors have completed parallel work. Synthesize their outputs.',
    `Convergence Status: ${convergence.delta > 0 ? 'Improving' : 'Stable'} (Delta: ${convergence.delta})`,
    guidance,
    '',
    contributorOutputs,
    '',
    'Produce:',
    '1. A unified summary combining all contributions',
    '2. Any conflicts identified between contributions',
    '3. A recommended approach that resolves conflicts and maximizes quality',
    '',
    'Do not reference specific contributors by number in your final output.',
  ].join('\n');

  mergePhase.status = 'in_progress';
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
  if (currentPhase.status === 'pending') {
    nextAction = `Call swarm_next with sessionId "${session.id}".`;
  } else if (currentPhase.status === 'in_progress') {
    if (phaseDef.isGate) {
      nextAction = `Call swarm_gate with sessionId "${session.id}" and scores.`;
    } else {
      nextAction = `Submit remaining outputs via swarm_submit.`;
    }
  } else if (currentPhase.status === 'done') {
    const nextIdx = session.currentPhaseIndex + 1;
    if (nextIdx >= session.phases.length) {
      nextAction = 'All phases complete. Swarm finished.';
    } else {
      const nextDef = TIER_PHASES[session.tier][nextIdx];
      if (nextDef.name.startsWith('merge_')) {
        nextAction = `Call swarm_merge with sessionId "${session.id}".`;
      } else {
        nextAction = `Call swarm_next with sessionId "${session.id}".`;
      }
    }
  } else {
    nextAction = 'Phase skipped or blocked.';
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
    hierarchy: session.agentGroups.length > 0 ? {
      model: 'L1 orchestrator → L2 managers → L3 workers',
      groups: session.agentGroups.map(g => ({
        id: g.id,
        manager: g.managerAgent,
        managerModel: g.managerModel,
        status: g.status,
        workers: g.workerSlots.map(ws => ({
          workstream: ws.workstreamId,
          agent: ws.agentType,
          model: ws.model,
        })),
        hasReport: !!g.report,
      })),
    } : undefined,
    historySummary,
    convergence: session.rounds.length > 0 ? (() => {
      const latestRound = Math.max(...session.rounds.map((r) => r.round));
      const latestScores = session.rounds
        .filter((r) => r.round === latestRound)
        .map((r) => ({ workstream: r.workstream, score: r.score }));
      return computeConvergence(session, latestRound, latestScores);
    })() : null,
    nextAction,
  });
}

// ── swarm_gate ────────────────────────────────────────────────────────

export function handleSwarmGate(args: {
  sessionId: string;
  scores: Array<{ workstream: string; score: number; criticalIssues: number }>;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const phaseDef = getPhaseDefinition(session);
  if (!phaseDef.isGate) {
    return err(`Current phase "${phaseDef.name}" is not a gate phase.`);
  }

  const phase = session.phases[session.currentPhaseIndex];
  phase.status = 'in_progress';

  const currentRound = session.rounds.length > 0
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
      model: ws?.modelAssigned ?? 'unknown',
      score: s.score,
      criticalIssues: s.criticalIssues,
    });
  }

  // Compute convergence metrics
  const convergence = computeConvergence(session, currentRound, args.scores);

  // Evaluate gate
  const failing = args.scores.filter((s) => s.score < 7);
  const allPass = failing.length === 0;

  if (allPass) {
    phase.status = 'done';
    advancePhase(session.id);
    return ok({
      proceed: true,
      sessionId: session.id,
      round: currentRound,
      scores: args.scores,
      convergence,
      nextAction: `All scores ≥ 7. Call swarm_next with sessionId "${session.id}" to continue.`,
    });
  }

  // Retry path
  const loopsForWorkstream = (wsId: string) =>
    session.rounds.filter((r) => r.workstream === wsId).length;

  const maxExceeded = failing.some((s) => loopsForWorkstream(s.workstream) >= session.maxLoops);

  if (maxExceeded) {
    // Force proceed with warning
    phase.status = 'done';
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
  const retryDetails = failing.map((s) => {
    const wsHistory = buildAnonymousHistory(session, s.workstream);
    return `Workstream "${s.workstream}" scored ${s.score}/10 with ${s.criticalIssues} critical issue(s). Retry needed.\n\nContext:\n${wsHistory}`;
  });

  // Find the review phase to retry from
  const phases = TIER_PHASES[session.tier];
  const reviewIdx = phases.findIndex((p) => p.name === 'review');
  const retryPhase = reviewIdx >= 0 ? 'review' : phases[Math.max(0, session.currentPhaseIndex - 1)].name;

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
    retryInstructions: retryDetails.join('\n\n---\n\n'),
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

  if (session.executionMode !== 'subprocess') {
    return err('swarm_collect is only for subprocess execution mode. Use swarm_submit for task mode.');
  }

  if (!args.outputs || args.outputs.length === 0) {
    return err('No outputs provided. Pass an array of {workstream, output} objects.');
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
  if (phase.status === 'done') {
    const nextIdx = session.currentPhaseIndex + 1;
    if (nextIdx < session.phases.length) {
      const nextDef = TIER_PHASES[session.tier][nextIdx];
      if (nextDef.name.startsWith('merge_')) {
        nextAction = `All subprocess outputs collected. Phase complete. Call swarm_merge with sessionId "${session.id}" and the outputs.`;
      } else {
        nextAction = `All subprocess outputs collected. Phase complete. Call swarm_next with sessionId "${session.id}" to advance.`;
      }
    } else {
      nextAction = 'All phases complete. Swarm finished.';
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
  action?: 'list' | 'set';
  models?: string[];
}): ToolResult {
  const action = args.action ?? 'list';

  if (action === 'set' && args.models && args.models.length > 0) {
    setAvailableModels(args.models);
    return ok({
      action: 'set',
      accepted: getAvailableModels().map((m) => m.id),
      ignored: args.models.filter((id) => !getAvailableModels().some((m) => m.id === id)),
      pools: {
        premium: [...premiumPool],
        coder: [...coderPool],
        critic: [...criticPool],
        fast: [...fastPool],
      },
      message: `Model pools updated. ${getAvailableModels().length} models active.`,
    });
  }

  return ok({
    action: 'list',
    available: getAvailableModels().map((m) => ({ id: m.id, tier: m.tier, provider: m.provider })),
    pools: {
      premium: [...premiumPool],
      coder: [...coderPool],
      critic: [...criticPool],
      fast: [...fastPool],
    },
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
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const prompt = getPrompt(session, args.promptRef);
  if (!prompt) return err(`Prompt ref not found: ${args.promptRef}. Call swarm_next first.`);

  return ok({
    subagent_type: args.subagent_type,
    description: args.description,
    prompt,
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
    if (typeof args.concurrency === 'string' && args.concurrency in RATE_PRESETS) {
      session.concurrency = resolveRateLimit(args.concurrency as RatePreset);
    } else {
      const num = Number(args.concurrency);
      if (!isNaN(num) && num >= 0) {
        session.concurrency = num;
      } else {
        return err(`Invalid concurrency: "${args.concurrency}". Use a preset name (${Object.keys(RATE_PRESETS).join(', ')}) or a number >= 0.`);
      }
    }
  }

  // Find matching preset
  const matchedPreset = Object.entries(RATE_PRESETS).find(([_, v]) => v.concurrency === session.concurrency);

  // Count in-flight groups
  const inFlight = session.agentGroups.filter(g => g.status === 'dispatched').length;
  const completed = session.agentGroups.filter(g => g.status === 'done').length;
  const pending = session.agentGroups.filter(g => g.status === 'pending').length;

  return ok({
    previous: previousConcurrency! > 0 ? previousConcurrency : 'unlimited',
    current: session.concurrency! > 0 ? session.concurrency : 'unlimited',
    changed: args.concurrency !== undefined,
    preset: matchedPreset ? matchedPreset[0] : 'custom',
    description: matchedPreset ? matchedPreset[1].description : `Custom: ${session.concurrency} concurrent L2 managers`,
    groupStatus: {
      total: session.agentGroups.length,
      inFlight,
      completed,
      pending,
    },
    availablePresets: Object.fromEntries(
      Object.entries(RATE_PRESETS).map(([k, v]) => [k, {
        concurrency: v.concurrency || 'unlimited',
        estimatedAgents: v.maxAgents === Infinity ? 'unlimited' : v.maxAgents,
        plan: v.plan,
        description: v.description,
      }])
    ),
  });
}

// ── swarm_relay ───────────────────────────────────────────────────────
// Orchestrator posts findings from a completed workstream to the board.
// The board is the programmatic communication layer between managers.

export function handleSwarmRelay(args: {
  sessionId: string;
  workstream: string;
  type?: 'finding' | 'blocker' | 'decision' | 'status' | 'plan' | 'report';
  level?: 'L1' | 'L2' | 'L3';
  group?: string;
  content: string;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  const type = args.type ?? 'finding';
  const level = args.level ?? 'L1';
  const msg = postToBoard(session, args.workstream, type, args.content, level, args.group);

  // Mark workstream status if blocker
  if (type === 'blocker') {
    const ws = session.workstreams.find((w) => w.id === args.workstream);
    if (ws) ws.status = 'blocked';
  }

  const boardSize = session.board.length;
  const findings = session.board.filter((m) => m.type === 'finding').length;
  const blockers = session.board.filter((m) => m.type === 'blocker').length;
  const decisions = session.board.filter((m) => m.type === 'decision').length;

  return ok({
    sessionId: session.id,
    posted: { workstream: msg.workstream, type: msg.type },
    boardStats: { total: boardSize, findings, blockers, decisions },
    nextAction: blockers > 0
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
  types?: ('finding' | 'blocker' | 'decision' | 'status' | 'plan' | 'report')[];
  level?: 'L1' | 'L2' | 'L3';
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  let messages = readBoard(session, args.workstream, args.types);
  // Filter by level if specified
  if (args.level) {
    messages = messages.filter(m => m.level === args.level);
  }
  const ready = getReadyWorkstreams(session);
  const blocked = getBlockedWorkstreams(session);
  const blockers = session.board.filter((m) => m.type === 'blocker');
  const decisions = session.board.filter((m) => m.type === 'decision');
  const reports = session.board.filter((m) => m.type === 'report');
  const unresolvedBlockers = blockers.filter((b) => {
    return !decisions.some((d) =>
      d.timestamp >= b.timestamp &&
      (d.content.toLowerCase().includes(b.workstream.toLowerCase()) ||
       d.content.toLowerCase().includes('resolved') ||
       d.workstream === 'orchestrator')
    );
  });

  let nextAction: string;
  if (unresolvedBlockers.length > 0) {
    nextAction = `🛑 ${unresolvedBlockers.length} unresolved blocker(s). As orchestrator, make decisions on these before proceeding. Call swarm_relay(type="decision", content="...") to resolve each.`;
  } else if (ready.length > 0) {
    nextAction = `${ready.length} workstream(s) ready to dispatch: ${ready.map((w) => w.id).join(', ')}. Call swarm_next to get task calls.`;
  } else if (blocked.length > 0) {
    nextAction = `All remaining workstreams are blocked on dependencies. Resolve dependencies first.`;
  } else {
    nextAction = 'All workstreams dispatched or complete.';
  }

  return ok({
    sessionId: session.id,
    messages,
    summary: {
      total: messages.length,
      byType: {
        finding: messages.filter((m) => m.type === 'finding').length,
        blocker: messages.filter((m) => m.type === 'blocker').length,
        decision: messages.filter((m) => m.type === 'decision').length,
        status: messages.filter((m) => m.type === 'status').length,
        plan: messages.filter((m) => m.type === 'plan').length,
        report: messages.filter((m) => m.type === 'report').length,
      },
      byLevel: {
        L1: messages.filter((m) => m.level === 'L1').length,
        L2: messages.filter((m) => m.level === 'L2').length,
        L3: messages.filter((m) => m.level === 'L3').length,
      },
      unresolvedBlockers: unresolvedBlockers.length,
    },
    hierarchy: session.agentGroups.length > 0 ? {
      groups: session.agentGroups.map(g => ({
        id: g.id,
        status: g.status,
        manager: g.managerAgent,
        hasReport: !!g.report,
        workers: g.workerSlots.map(ws => ws.workstreamId),
      })),
    } : undefined,
    workstreams: {
      ready: ready.map((w) => w.id),
      blocked: blocked.map((w) => ({ id: w.id, waitingOn: w.dependencies })),
      done: session.workstreams.filter((w) => w.status === 'done').map((w) => w.id),
    },
    nextAction,
  });
}

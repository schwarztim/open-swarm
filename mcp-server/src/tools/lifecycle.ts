import {
  type SwarmSession,
  type PhaseDefinition,
  type PhaseState,
  type ValidationResult,
  TIER_PHASES,
  getSession,
  getPhaseDefinition,
  advancePhase,
  buildAnonymousHistory,
  buildBoardContext,
  buildManagerPrompt,
  groupWorkstreams,
  postToBoard,
  storePrompt,
  getCoderModel,
  getModelProvider,
  getWorkerAgentName,
  getManagerAgentName,
  getVerifierModel,
  buildVerifierPrompt,
  parseAcceptanceTests,
  coderPool,
  premiumPool,
  stripIdentity,
  checkDrift,
  resolveModelTracked,
  getRateLimitStatus,
} from "../state.js";
import { writeFileSync, mkdirSync } from "fs";
import {
  ok,
  err,
  validateString,
  buildTaskCall,
  workstreamCount,
  computeConvergence,
  DRIFT_THRESHOLD,
  type ToolResult,
} from "./shared.js";

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
    const projectFiles = session.workstreams.flatMap((ws) => ws.files);
    const staticPrompt = [
      history,
      "",
      "--- VALIDATION: BUILD + TEST LOOP ---",
      "You MUST get the build AND test suite to pass. Do not just report — FIX failures.",
      "",
      "1. Detect the project type:",
      "   - package.json → npm run build && npm test",
      "   - setup.py / pyproject.toml → pip install -e . && pytest --tb=short -q",
      "   - go.mod → go build ./... && go test ./...",
      "   - Cargo.toml → cargo build && cargo test",
      "   - Makefile → make build && make test",
      "",
      "2. Run the build. If it fails, FIX the build errors and re-run.",
      "3. Run the test suite. If tests fail, FIX the failing tests and re-run.",
      "4. LOOP: Keep fixing and re-running until BOTH build and tests pass.",
      "   - Maximum 3 fix attempts per failure before reporting as unresolvable.",
      "   - For each fix: identify root cause, apply minimal fix, verify.",
      "",
      "5. When everything passes (or max attempts reached), output:",
      "",
      "STATIC_RESULT: pass|fail",
      "UNIT_RESULT: pass|fail (N tests passed, M failed)",
      "FIX_ATTEMPTS: N",
      "FIXES_APPLIED: <list of what you fixed>",
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
    const workstreamsWithTests = session.workstreams.filter(
      (ws) => ws.acceptanceTests && ws.acceptanceTests.length > 0,
    );

    if (workstreamsWithTests.length === 0) {
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
        command: `opencode run ${promptFile} --agent ${agentName} --dangerously-skip-permissions > ${outputFile} 2>&1`,
      });
    }

    // Write prompt files now (avoids shell injection via heredoc)
    mkdirSync(outputDir, { recursive: true });
    for (const cmd of spawnCommands) {
      writeFileSync(cmd.promptFile, cmd.prompt, "utf8");
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

  // Write prompt file now (avoids shell injection via heredoc)
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(promptFile, prompt, "utf8");

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
      command: `opencode run ${promptFile} --agent ${agentName} --dangerously-skip-permissions > ${outputFile} 2>&1`,
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
  const sessionIdValidation = validateString(args.sessionId, "sessionId");
  if (typeof sessionIdValidation !== "string") return sessionIdValidation;
  const outputValidation = validateString(args.output, "output");
  if (typeof outputValidation !== "string") return outputValidation;

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

// ── Validation Gate ───────────────────────────────────────────────────

export function handleValidationGate(
  session: SwarmSession,
  phase: PhaseState,
): ToolResult {
  const results = session.validationResults;

  if (results.length === 0) {
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

  const staticFailures = results.flatMap((r) =>
    r.tests.filter((t) => t.category === "static" && t.status === "fail"),
  );

  const zeroPassWorkstreams = results.filter(
    (r) => r.summary.total > 0 && r.summary.passed === 0,
  );

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

  // Gate fails
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

  const retryCount = session.validationRetries ?? 0;
  const maxRetries = 3;

  if (retryCount >= maxRetries) {
    phase.status = "done";
    advancePhase(session.id);
    return ok({
      proceed: true,
      warnings: true,
      sessionId: session.id,
      validation: validationSummary,
      failingDetails,
      retries: retryCount,
      nextAction: `Validation gate failed after ${maxRetries} retries. Proceeding with ${totalFailed} failing test(s). Call swarm_next with sessionId "${session.id}" to continue.`,
    });
  }

  session.validationRetries = retryCount + 1;
  session.validationResults = [];

  const tierPhases = session.phases;
  for (const p of tierPhases) {
    if (p.name === "validate-static" || p.name === "validate-integration") {
      p.status = "pending";
    }
  }
  phase.status = "pending";

  const staticIdx = tierPhases.findIndex((p) => p.name === "validate-static");
  if (staticIdx >= 0) {
    session.currentPhaseIndex = staticIdx;
  }

  return ok({
    proceed: false,
    retry: retryCount + 1,
    maxRetries,
    sessionId: session.id,
    validation: validationSummary,
    blockReason,
    failingDetails,
    nextAction: `Validation gate FAILED (attempt ${retryCount + 1}/${maxRetries}): ${blockReason}. Phases reset — call swarm_next with sessionId "${session.id}" to re-run validation with fixes.`,
  });
}

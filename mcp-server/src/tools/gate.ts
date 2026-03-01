import {
  type SwarmSession,
  TIER_PHASES,
  getSession,
  getPhaseDefinition,
  advancePhase,
  buildAnonymousHistory,
  stripIdentity,
  getModelProvider,
  getRateLimitStatus,
  postToBoard,
} from "../state.js";
import { judge, distill } from "../learning.js";
import { workerRegistry } from "../workers.js";
import { generateCriticPrompt, generateRetryPrompt } from "../scoring.js";
import {
  ok,
  err,
  buildTaskCall,
  workstreamCount,
  computeConvergence,
  type ToolResult,
} from "./shared.js";

function computeDimensions(scores: Array<{ workstream: string; score: number; criticalIssues?: number }>): {
  dimensions: Record<string, number>;
  recommendation: "pass" | "retry" | "escalate";
} {
  const avgScore = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const hasCritical = scores.some((s) => (s.criticalIssues ?? 0) > 0);

  return {
    dimensions: {
      averageScore: Math.round(avgScore * 10) / 10,
      passingCount: scores.filter((s) => s.score >= 7).length,
      failingCount: scores.filter((s) => s.score < 7).length,
      criticalIssueCount: scores.reduce((sum, s) => sum + (s.criticalIssues ?? 0), 0),
    },
    recommendation: hasCritical ? "escalate" : avgScore >= 7 ? "pass" : "retry",
  };
}

// ── swarm_gate ────────────────────────────────────────────────────────

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
    // Import handleValidationGate dynamically to avoid circular dependency
    const { handleValidationGate } = await import("./lifecycle.js");
    return handleValidationGate(session, phase);
  }

  // Guard: scores are required for non-validation gates
  if (!args.scores || !Array.isArray(args.scores)) {
    return err(
      `swarm_gate requires a "scores" array with { workstream, score, criticalIssues } entries.`,
    );
  }

  // WS3a: Pre-check phase
  const expectedWsIds = session.workstreams.map((w) => w.id);
  const submittedWsIds = new Set(args.scores.map((s) => s.workstream));
  const missingWorkstreams = expectedWsIds.filter(
    (id) => !submittedWsIds.has(id),
  );

  const degradedGroups = session.agentGroups.filter(
    (g) => g.healthStatus === "degraded",
  );
  const unresolvedDegraded = degradedGroups.filter((g) => {
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

  // Clamp scores to valid range [0, 10]
  for (const s of args.scores) {
    s.score = Math.max(0, Math.min(10, s.score));
    s.criticalIssues = Math.max(0, s.criticalIssues);
  }

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
    const criticPrompt = generateCriticPrompt(
      JSON.stringify(args.scores.map((s) => ({ workstream: s.workstream, score: s.score }))),
      session.task,
      "",
    );
    const { dimensions, recommendation } = computeDimensions(args.scores);
    return ok({
      proceed: true,
      sessionId: session.id,
      round: currentRound,
      scores: args.scores,
      convergence,
      learning: learningOutcome,
      distilled: distillResult,
      backgroundWorkers,
      dimensions,
      recommendation,
      criticPrompt,
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
    phase.status = "done";
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
  const includeBoard = args.includeBoard === true;
  const retryDetails = failing.map((s) => {
    if (includeBoard) {
      const wsHistory = buildAnonymousHistory(session, s.workstream);
      return `Workstream "${s.workstream}" scored ${s.score}/10 with ${s.criticalIssues} critical issue(s). Retry needed.\n\nContext:\n${wsHistory}`;
    }
    return `Workstream "${s.workstream}" scored ${s.score}/10 with ${s.criticalIssues} critical issue(s). Retry needed.`;
  });

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

  const validationResult = {
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

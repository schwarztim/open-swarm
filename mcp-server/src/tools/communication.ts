import {
  type BoardMessage,
  getSession,
  postToBoard,
  readBoard,
  getReadyWorkstreams,
  getBlockedWorkstreams,
} from "../state.js";
import { ok, err, validateString, type ToolResult } from "./shared.js";

// ── swarm_relay ───────────────────────────────────────────────────────

export function handleSwarmRelay(args: {
  sessionId: string;
  workstream: string;
  type?: "finding" | "blocker" | "decision" | "status" | "plan" | "report";
  level?: "L1" | "L2" | "L3";
  group?: string;
  content: string;
}): ToolResult {
  const sessionIdValidation = validateString(args.sessionId, "sessionId");
  if (typeof sessionIdValidation !== "string") return sessionIdValidation;
  const contentValidation = validateString(args.content, "content");
  if (typeof contentValidation !== "string") return contentValidation;

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

  // WS1b: Summary mode
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

  // WS1a: Pagination
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

import {
  type SwarmSession,
  type DebateTrigger,
  type DebateContribution,
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
  storePrompt,
  resolveModelTracked,
  resolveModel,
  getWorkerAgentName,
  stripIdentity,
  coderPool,
} from "../state.js";

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

  const existing = currentRound.contributions.find(
    (c) => c.slotId === args.slotId && c.phase === phase,
  );
  if (existing) {
    return err(
      `${args.slotId} already submitted for ${phase} in round ${currentRound.roundNumber}.`,
    );
  }

  const contribution: DebateContribution = {
    slotId: args.slotId!,
    agentType: participant.agentType,
    model: participant.model,
    phase,
    content: stripIdentity(args.content!),
    timestamp: Date.now(),
  };
  currentRound.contributions.push(contribution);

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

  const scores = scoreDebatePositions(currentRound, debate);
  const convergence = computeDebateConvergence(debate);
  const sycophancy = detectDebateSycophancy(debate);

  const newClaims = extractClaimsFromPositions(debate, currentRound);
  debate.claims.push(...newClaims);
  updateClaimConsensus(debate, currentRound);
  const partialConsensus = getPartialConsensus(debate);

  const fastTrackResult = checkFastTrack(
    debate,
    convergence,
    sycophancy,
    scores,
  );

  const contrarianResult = !fastTrackResult.eligible
    ? assignContrarian(debate, convergence, scores)
    : { assigned: false, reason: "Fast-track eligible — no contrarian needed" };

  const evaluation = buildDebateEvaluation(
    scores,
    convergence,
    sycophancy,
    debate,
  );

  if (fastTrackResult.eligible) {
    evaluation.recommendation = "converged";
    evaluation.synthesisReady = true;
    evaluation.reasoning = `⚡ FAST-TRACK: ${fastTrackResult.reason}`;
  }

  currentRound.evaluation = evaluation;
  currentRound.completedAt = Date.now();

  if (evaluation.recommendation === "converged") {
    debate.status = "converged";
  } else if (evaluation.recommendation === "stalled") {
    debate.status = "stalled";
  } else if (evaluation.recommendation === "escalate") {
    debate.status = "stalled";
  }

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

  const findings = args.validationFindings ?? [];
  const { checkpoint, reopened, newDebateId } = submitValidation(
    session,
    debate,
    args.validationOutcome,
    findings,
  );

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

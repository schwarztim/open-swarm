// ── Debate Core ───────────────────────────────────────────────────────
// Debate lifecycle: creation, retrieval, and phase advancement.

import { getCoderModel } from "./model-registry.js";
import { getWorkerAgentName } from "./agent-naming.js";
import type {
  SwarmSession,
  DebateState,
  DebatePhase,
  DebateTrigger,
  DebateParticipant,
  DebateRound,
} from "./swarm-types.js";

let debateCounter = 0;

export function generateDebateId(): string {
  return `debate-${++debateCounter}`;
}

/** Get a debate-appropriate model with provider diversity. */
export function getDebaterModel(
  index: number,
  groupId: string | undefined,
  session: SwarmSession,
): string {
  if (groupId) {
    const group = session.agentGroups.find((g) => g.id === groupId);
    if (group && index < group.workerSlots.length) {
      return group.workerSlots[index].model;
    }
  }
  return getCoderModel(index);
}

/** Get the agent type for a debate participant. */
export function getDebaterAgentType(
  index: number,
  groupId: string | undefined,
  session: SwarmSession,
): string {
  if (groupId) {
    const group = session.agentGroups.find((g) => g.id === groupId);
    if (group && index < group.workerSlots.length) {
      return group.workerSlots[index].agentType;
    }
  }
  return getWorkerAgentName(getCoderModel(index));
}

/** Create a new debate and attach it to the session. */
export function createDebate(
  session: SwarmSession,
  topic: string,
  trigger: DebateTrigger,
  groupId?: string,
  participantCount: number = 2,
  maxRounds: number = 3,
): DebateState {
  const id = generateDebateId();
  const initiatorLevel = groupId ? "L2" : "L1";

  const participants: DebateParticipant[] = [];
  for (let i = 0; i < participantCount; i++) {
    const model = getDebaterModel(i, groupId, session);
    const agentType = getDebaterAgentType(i, groupId, session);
    participants.push({
      slotId: `debater-${i}`,
      agentType,
      model,
    });
  }

  const debate: DebateState = {
    id,
    sessionId: session.id,
    groupId,
    topic,
    trigger,
    initiatorLevel,
    status: "pending",
    participants,
    rounds: [],
    currentRound: 0,
    maxRounds,
    convergenceThreshold: 0.7,
    sycophancyThreshold: 0.85,
    minPositionScore: 6,
    fastTrack: false,
    claims: [],
    createdAt: Date.now(),
  };

  session.debates.push(debate);
  return debate;
}

/** Get a debate by ID from a session. */
export function getDebate(
  session: SwarmSession,
  debateId: string,
): DebateState | undefined {
  return session.debates.find((d) => d.id === debateId);
}

/** Advance a debate to the next phase within a round, or start a new round. */
export function advanceDebatePhase(debate: DebateState): {
  phase: DebatePhase;
  round: number;
  isNewRound: boolean;
} {
  const currentRound = debate.rounds[debate.rounds.length - 1];

  if (!currentRound || currentRound.completedAt) {
    const roundNumber = debate.currentRound + 1;
    debate.currentRound = roundNumber;
    const newRound: DebateRound = {
      roundNumber,
      phase: "position",
      contributions: [],
      startedAt: Date.now(),
    };
    debate.rounds.push(newRound);
    debate.status = "active";
    return { phase: "position", round: roundNumber, isNewRound: true };
  }

  const positionCount = currentRound.contributions.filter(
    (c) => c.phase === "position",
  ).length;
  const critiqueCount = currentRound.contributions.filter(
    (c) => c.phase === "critique",
  ).length;
  const rebuttalCount = currentRound.contributions.filter(
    (c) => c.phase === "rebuttal",
  ).length;
  const participantCount = debate.participants.length;

  if (positionCount < participantCount) {
    currentRound.phase = "position";
    return { phase: "position", round: debate.currentRound, isNewRound: false };
  }

  const expectedCritiques = participantCount * (participantCount - 1);
  if (critiqueCount < expectedCritiques) {
    currentRound.phase = "critique";
    return { phase: "critique", round: debate.currentRound, isNewRound: false };
  }

  if (rebuttalCount < participantCount) {
    currentRound.phase = "rebuttal";
    return { phase: "rebuttal", round: debate.currentRound, isNewRound: false };
  }

  currentRound.phase = "evaluation";
  return { phase: "evaluation", round: debate.currentRound, isNewRound: false };
}

// ── Drift Detection ───────────────────────────────────────────────────
// Anti-drift detection and worker consensus protocol.

import type { SwarmSession, DriftCheck, ConsensusState } from "./swarm-types.js";

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

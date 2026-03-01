// ── Debate Claims ─────────────────────────────────────────────────────
// Claim tracking, validation checkpoints, fast-track, and contrarian assignment.

import type {
  SwarmSession,
  DebateState,
  DebateRound,
  DebateClaim,
  DebatePositionScore,
  ValidationCheckpoint,
} from "./swarm-types.js";
import { createDebate } from "./debate-core.js";
import {
  computeDebateConvergence,
  detectDebateSycophancy,
} from "./debate-scoring.js";

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? inter.length / union.size : 0;
}

/** Extract discrete claims from position text. */
export function extractClaimsFromPositions(
  debate: DebateState,
  round: DebateRound,
): DebateClaim[] {
  const positions = round.contributions.filter((c) => c.phase === "position");
  const claims: DebateClaim[] = [];
  let claimCounter = debate.claims.length;

  for (const pos of positions) {
    const statements = pos.content
      .split(/(?<=[.!?\n])\s+/)
      .map((s) => s.trim())
      .filter(
        (s) => s.length > 30 && !s.startsWith("#") && !s.startsWith("```"),
      );

    for (const stmt of statements) {
      const stmtWords = new Set(stmt.toLowerCase().match(/\b\w{5,}\b/g) ?? []);
      const isDuplicate = claims.some((existing) => {
        const existWords = new Set(
          existing.text.toLowerCase().match(/\b\w{5,}\b/g) ?? [],
        );
        return jaccard(stmtWords, existWords) > 0.6;
      });
      if (isDuplicate) continue;

      claims.push({
        id: `claim-${claimCounter++}`,
        text: stmt.substring(0, 300),
        sourceSlot: pos.slotId,
        agreeSlots: [pos.slotId],
        disagreeSlots: [],
        status: "undecided",
        round: round.roundNumber,
      });
    }
  }

  return claims;
}

/** Update claim agreement based on rebuttals and critiques. */
export function updateClaimConsensus(
  debate: DebateState,
  round: DebateRound,
): void {
  const rebuttals = round.contributions.filter((c) => c.phase === "rebuttal");
  const critiques = round.contributions.filter((c) => c.phase === "critique");
  const allResponses = [...rebuttals, ...critiques];

  for (const claim of debate.claims) {
    const claimWords = new Set(
      claim.text.toLowerCase().match(/\b\w{5,}\b/g) ?? [],
    );

    for (const response of allResponses) {
      if (
        claim.agreeSlots.includes(response.slotId) ||
        claim.disagreeSlots.includes(response.slotId)
      ) {
        continue;
      }

      const responseWords = new Set(
        response.content.toLowerCase().match(/\b\w{5,}\b/g) ?? [],
      );
      const overlap = jaccard(claimWords, responseWords);
      if (overlap < 0.15) continue;

      const lowerContent = response.content.toLowerCase();
      const disagreeMarkers =
        /\b(disagree|wrong|incorrect|flawed|reject|oppose|counter|however|but)\b/gi;
      const agreeMarkers =
        /\b(agree|correct|valid|support|endorse|concur|accept)\b/gi;
      const disagreeCount = (lowerContent.match(disagreeMarkers) ?? []).length;
      const agreeCount = (lowerContent.match(agreeMarkers) ?? []).length;

      if (agreeCount > disagreeCount) {
        claim.agreeSlots.push(response.slotId);
      } else if (disagreeCount > 0) {
        claim.disagreeSlots.push(response.slotId);
      }
    }

    const totalParticipants = debate.participants.length;
    const agreeRatio = claim.agreeSlots.length / totalParticipants;
    if (agreeRatio >= 0.7) {
      claim.status = "agreed";
    } else if (claim.disagreeSlots.length > 0) {
      claim.status = "contested";
    } else {
      claim.status = "undecided";
    }
  }

  round.claims = [...debate.claims];
}

/** Get partial consensus summary. */
export function getPartialConsensus(debate: DebateState): {
  agreed: DebateClaim[];
  contested: DebateClaim[];
  undecided: DebateClaim[];
  consensusRatio: number;
} {
  const agreed = debate.claims.filter((c) => c.status === "agreed");
  const contested = debate.claims.filter((c) => c.status === "contested");
  const undecided = debate.claims.filter((c) => c.status === "undecided");
  const total = debate.claims.length || 1;

  return {
    agreed,
    contested,
    undecided,
    consensusRatio: agreed.length / total,
  };
}

/** Check if a debate can be fast-tracked after Round 1. */
export function checkFastTrack(
  debate: DebateState,
  convergence: ReturnType<typeof computeDebateConvergence>,
  sycophancy: ReturnType<typeof detectDebateSycophancy>,
  scores: DebatePositionScore[],
): { eligible: boolean; reason: string } {
  if (debate.currentRound !== 1) {
    return { eligible: false, reason: "Fast-track only applies after Round 1" };
  }

  if (convergence.score < debate.convergenceThreshold) {
    return {
      eligible: false,
      reason: `Convergence ${(convergence.score * 100).toFixed(0)}% below threshold ${(debate.convergenceThreshold * 100).toFixed(0)}%`,
    };
  }

  if (sycophancy.detected) {
    return {
      eligible: false,
      reason: `Sycophancy detected (${(sycophancy.score * 100).toFixed(0)}%) — cannot fast-track`,
    };
  }

  const lowScores = scores.filter((s) => s.total < debate.minPositionScore);
  if (lowScores.length > 0) {
    return {
      eligible: false,
      reason: `${lowScores.length} position(s) below minimum score (${debate.minPositionScore}/11)`,
    };
  }

  debate.fastTrack = true;
  return {
    eligible: true,
    reason: `All conditions met: convergence ${(convergence.score * 100).toFixed(0)}%, no sycophancy, all positions ≥${debate.minPositionScore}/11. Skipping to synthesis.`,
  };
}

/** Assign a contrarian to stress-test early consensus. */
export function assignContrarian(
  debate: DebateState,
  convergence: ReturnType<typeof computeDebateConvergence>,
  scores: DebatePositionScore[],
): { assigned: boolean; slotId?: string; reason: string } {
  if (debate.contrarian) {
    return {
      assigned: false,
      reason: `Contrarian already assigned: ${debate.contrarian}`,
    };
  }

  if (debate.currentRound !== 1) {
    return {
      assigned: false,
      reason: "Contrarian assignment only after Round 1",
    };
  }

  if (convergence.score < 0.5) {
    return {
      assigned: false,
      reason: "Positions are sufficiently diverse — no contrarian needed",
    };
  }

  const minScoreIdx = scores.reduce(
    (min, s, i) => (s.total < scores[min].total ? i : min),
    0,
  );
  const contrarianSlot = debate.participants[minScoreIdx].slotId;
  debate.contrarian = contrarianSlot;

  return {
    assigned: true,
    slotId: contrarianSlot,
    reason: `Early convergence at ${(convergence.score * 100).toFixed(0)}% — ${contrarianSlot} assigned as devil's advocate to stress-test consensus`,
  };
}

/** Create a validation checkpoint for a resolved debate. */
export function createValidationCheckpoint(
  debate: DebateState,
): ValidationCheckpoint {
  if (!debate.synthesis) {
    throw new Error(
      "Cannot create validation checkpoint: debate has no synthesis",
    );
  }

  const checkpoint: ValidationCheckpoint = {
    debateId: debate.id,
    synthesis: debate.synthesis,
    submittedAt: Date.now(),
    outcome: "pending",
    findings: [],
  };

  debate.validation = checkpoint;
  return checkpoint;
}

/** Submit validation results for a debate's synthesis. */
export function submitValidation(
  session: SwarmSession,
  debate: DebateState,
  outcome: "confirmed" | "failed" | "partial",
  findings: string[],
): {
  checkpoint: ValidationCheckpoint;
  reopened: boolean;
  newDebateId?: string;
} {
  if (!debate.validation) {
    debate.validation = createValidationCheckpoint(debate);
  }

  debate.validation.outcome = outcome;
  debate.validation.findings = findings;
  debate.validation.validatedAt = Date.now();

  let reopened = false;
  let newDebateId: string | undefined;

  if (outcome === "failed" || outcome === "partial") {
    const newTopic = `[REOPENED] ${debate.topic} — validation ${outcome}: ${findings.slice(0, 2).join("; ")}`;
    const newDebate = createDebate(
      session,
      newTopic,
      "disagreement",
      debate.groupId,
      debate.participants.length,
      2,
    );

    newDebate.claims = [...debate.claims];
    debate.validation.reopenedDebateId = newDebate.id;
    reopened = true;
    newDebateId = newDebate.id;
  }

  return { checkpoint: debate.validation, reopened, newDebateId };
}

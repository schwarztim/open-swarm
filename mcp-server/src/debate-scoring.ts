// ── Debate Scoring ────────────────────────────────────────────────────
// Scoring, convergence computation, sycophancy detection, and evaluation building.

import type {
  DebateState,
  DebateRound,
  DebatePositionScore,
  DebateEvaluation,
} from "./swarm-types.js";

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? inter.length / union.size : 0;
}

/** Score debate positions using structural heuristics. */
export function scoreDebatePositions(
  round: DebateRound,
  debate: DebateState,
): DebatePositionScore[] {
  return debate.participants.map((participant) => {
    const position = round.contributions.find(
      (c) => c.slotId === participant.slotId && c.phase === "position",
    );
    const rebuttal = round.contributions.find(
      (c) => c.slotId === participant.slotId && c.phase === "rebuttal",
    );
    const critiquesReceived = round.contributions.filter(
      (c) => c.phase === "critique" && c.slotId !== participant.slotId,
    );

    const evidenceMarkers =
      (position?.content ?? "").match(
        /```|`[^`]+`|\d+\.\d+|\bfile\b|\bline\b|\bfunction\b|\bclass\b|\bmodule\b/gi,
      ) ?? [];
    const evidenceQuality = Math.min(3, Math.floor(evidenceMarkers.length / 2));

    const reasoningMarkers =
      (position?.content ?? "").match(
        /\bbecause\b|\btherefore\b|\bhowever\b|\bif\b.*\bthen\b|\bconsequently\b|\bthus\b|\bin contrast\b|\bon the other hand\b/gi,
      ) ?? [];
    const reasoningClarity = Math.min(
      3,
      Math.floor(reasoningMarkers.length / 1.5),
    );

    const addressedCount = critiquesReceived.filter((critique) => {
      const keywords = critique.content
        .split(/\s+/)
        .filter((w) => w.length > 5)
        .slice(0, 5);
      return keywords.some((kw) =>
        (rebuttal?.content ?? "").toLowerCase().includes(kw.toLowerCase()),
      );
    }).length;
    const rebuttalEffectiveness =
      critiquesReceived.length > 0
        ? Math.min(
            3,
            Math.round((addressedCount / critiquesReceived.length) * 3),
          )
        : 1;

    const otherContent = round.contributions
      .filter((c) => c.phase === "position" && c.slotId !== participant.slotId)
      .map((c) => c.content.toLowerCase())
      .join(" ");
    const myTerms = new Set(
      (position?.content ?? "").toLowerCase().match(/\b\w{6,}\b/g) ?? [],
    );
    const otherTerms = new Set(otherContent.match(/\b\w{6,}\b/g) ?? []);
    const uniqueTerms = [...myTerms].filter((t) => !otherTerms.has(t));
    const novelContribution = Math.min(2, Math.floor(uniqueTerms.length / 10));

    const total =
      evidenceQuality +
      reasoningClarity +
      rebuttalEffectiveness +
      novelContribution;

    const score: DebatePositionScore = {
      evidenceQuality,
      reasoningClarity,
      rebuttalEffectiveness,
      novelContribution,
      total,
      summary: `${total}/11 — evidence:${evidenceQuality} reasoning:${reasoningClarity} rebuttal:${rebuttalEffectiveness} novelty:${novelContribution}`,
    };

    if (rebuttal) rebuttal.score = score;
    else if (position) position.score = score;

    return score;
  });
}

/** Compute convergence between debate positions. */
export function computeDebateConvergence(debate: DebateState): {
  score: number;
  delta: number;
  trending: "converging" | "diverging" | "stable";
} {
  if (debate.rounds.length === 0) {
    return { score: 0, delta: 0, trending: "stable" };
  }

  const currentRound = debate.rounds[debate.rounds.length - 1];
  const positions = currentRound.contributions.filter(
    (c) => c.phase === "position",
  );
  const rebuttals = currentRound.contributions.filter(
    (c) => c.phase === "rebuttal",
  );

  const finalTexts =
    rebuttals.length > 0
      ? rebuttals.map((c) => c.content.toLowerCase())
      : positions.map((c) => c.content.toLowerCase());

  if (finalTexts.length < 2) {
    return { score: 1, delta: 0, trending: "stable" };
  }

  const wordSets = finalTexts.map((t) => new Set(t.match(/\b\w{4,}\b/g) ?? []));
  let totalSimilarity = 0;
  let pairCount = 0;

  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const intersection = [...wordSets[i]].filter((w) => wordSets[j].has(w));
      const union = new Set([...wordSets[i], ...wordSets[j]]);
      const similarity = union.size > 0 ? intersection.length / union.size : 0;
      totalSimilarity += similarity;
      pairCount++;
    }
  }

  const currentScore = pairCount > 0 ? totalSimilarity / pairCount : 0;

  let previousScore = 0;
  if (debate.rounds.length >= 2) {
    const prevRound = debate.rounds[debate.rounds.length - 2];
    const prevTexts = prevRound.contributions
      .filter((c) => c.phase === "rebuttal" || c.phase === "position")
      .map((c) => c.content.toLowerCase());
    const prevWordSets = prevTexts.map(
      (t) => new Set(t.match(/\b\w{4,}\b/g) ?? []),
    );
    let prevTotal = 0;
    let prevPairs = 0;
    for (let i = 0; i < prevWordSets.length; i++) {
      for (let j = i + 1; j < prevWordSets.length; j++) {
        const inter = [...prevWordSets[i]].filter((w) =>
          prevWordSets[j].has(w),
        );
        const uni = new Set([...prevWordSets[i], ...prevWordSets[j]]);
        prevTotal += uni.size > 0 ? inter.length / uni.size : 0;
        prevPairs++;
      }
    }
    previousScore = prevPairs > 0 ? prevTotal / prevPairs : 0;
  }

  const delta = currentScore - previousScore;
  const trending: "converging" | "diverging" | "stable" =
    delta > 0.05 ? "converging" : delta < -0.05 ? "diverging" : "stable";

  return {
    score: Math.round(currentScore * 1000) / 1000,
    delta: Math.round(delta * 1000) / 1000,
    trending,
  };
}

/** Detect sycophancy in debate contributions. */
export function detectDebateSycophancy(debate: DebateState): {
  detected: boolean;
  score: number;
  indicators: string[];
} {
  if (debate.rounds.length === 0) {
    return { detected: false, score: 0, indicators: [] };
  }

  const currentRound = debate.rounds[debate.rounds.length - 1];
  const indicators: string[] = [];
  let sycophancySignals = 0;
  const maxSignals = 5;

  const positions = currentRound.contributions.filter(
    (c) => c.phase === "position",
  );
  const rebuttals = currentRound.contributions.filter(
    (c) => c.phase === "rebuttal",
  );
  if (rebuttals.length > 0 && positions.length > 0) {
    const avgPosLen =
      positions.reduce((s, c) => s + c.content.length, 0) / positions.length;
    const avgRebLen =
      rebuttals.reduce((s, c) => s + c.content.length, 0) / rebuttals.length;
    if (avgRebLen < avgPosLen * 0.3) {
      sycophancySignals++;
      indicators.push(
        `Rebuttal collapse: avg rebuttal ${Math.round(avgRebLen)} chars vs avg position ${Math.round(avgPosLen)} chars`,
      );
    }
  }

  const agreementPatterns =
    /\b(i agree|you're right|good point|fair enough|I concede|valid point|no objection)\b/gi;
  const substantivePatterns =
    /\b(however|but|although|despite|nevertheless|in contrast|my concern|the issue)\b/gi;
  for (const rebuttal of rebuttals) {
    const agreeCount = (rebuttal.content.match(agreementPatterns) ?? []).length;
    const substantiveCount = (rebuttal.content.match(substantivePatterns) ?? [])
      .length;
    if (agreeCount > 2 && substantiveCount === 0) {
      sycophancySignals++;
      indicators.push(
        `Hollow agreement in ${rebuttal.slotId}: ${agreeCount} agreement markers, 0 substantive markers`,
      );
    }
  }

  const critiques = currentRound.contributions.filter(
    (c) => c.phase === "critique",
  );
  const softCritiquePatterns =
    /\b(minor|small|perhaps|maybe|slightly|could consider)\b/gi;
  const hardCritiquePatterns =
    /\b(wrong|incorrect|fundamentally|critical|major|flawed|broken|impossible)\b/gi;
  let softCount = 0;
  let hardCount = 0;
  for (const critique of critiques) {
    softCount += (critique.content.match(softCritiquePatterns) ?? []).length;
    hardCount += (critique.content.match(hardCritiquePatterns) ?? []).length;
  }
  if (critiques.length > 0 && softCount > hardCount * 3 && hardCount < 2) {
    sycophancySignals++;
    indicators.push(
      `Soft critiques: ${softCount} hedging markers vs ${hardCount} substantive markers`,
    );
  }

  if (debate.rounds.length >= 2) {
    const prevPositions = debate.rounds[debate.rounds.length - 2].contributions
      .filter((c) => c.phase === "position")
      .map((c) => new Set(c.content.toLowerCase().match(/\b\w{5,}\b/g) ?? []));
    const currPositions = positions.map(
      (c) => new Set(c.content.toLowerCase().match(/\b\w{5,}\b/g) ?? []),
    );

    if (prevPositions.length >= 2 && currPositions.length >= 2) {
      const crossSim0to1 = jaccard(
        currPositions[0],
        prevPositions[1] ?? new Set(),
      );
      const crossSim1to0 = jaccard(
        currPositions[1] ?? new Set(),
        prevPositions[0],
      );
      if (crossSim0to1 > 0.6 || crossSim1to0 > 0.6) {
        sycophancySignals++;
        indicators.push(
          `Position mimicry detected: positions copying each other's prior content`,
        );
      }
    }
  }

  for (const rebuttal of rebuttals) {
    if (
      /position unchanged/i.test(rebuttal.content) &&
      rebuttal.content.length < 200
    ) {
      sycophancySignals++;
      indicators.push(
        `${rebuttal.slotId} claims position unchanged with minimal defense`,
      );
    }
  }

  const score = Math.min(1, sycophancySignals / maxSignals);
  return {
    detected: score >= debate.sycophancyThreshold,
    score: Math.round(score * 100) / 100,
    indicators,
  };
}

/** Build the full debate evaluation. */
export function buildDebateEvaluation(
  scores: DebatePositionScore[],
  convergence: ReturnType<typeof computeDebateConvergence>,
  sycophancy: ReturnType<typeof detectDebateSycophancy>,
  debate: DebateState,
): DebateEvaluation {
  const dominantIdx = scores.reduce(
    (best, s, i) => (s.total > scores[best].total ? i : best),
    0,
  );
  const dominantScore = scores[dominantIdx];
  const secondBest =
    scores.length > 1
      ? Math.max(
          ...scores.filter((_, i) => i !== dominantIdx).map((s) => s.total),
        )
      : 0;
  const hasClearWinner = dominantScore.total - secondBest >= 2;

  let recommendation: DebateEvaluation["recommendation"];
  let reasoning: string;

  if (sycophancy.detected) {
    recommendation = "escalate";
    reasoning = `Sycophancy detected (${(sycophancy.score * 100).toFixed(0)}%). Positions are converging without substantive reasoning. Indicators: ${sycophancy.indicators.join("; ")}`;
  } else if (convergence.score >= debate.convergenceThreshold) {
    recommendation = "converged";
    reasoning = `Convergence reached ${(convergence.score * 100).toFixed(0)}% (threshold: ${(debate.convergenceThreshold * 100).toFixed(0)}%). ${hasClearWinner ? `Clear strongest position: debater-${dominantIdx}` : "No dominant position — synthesis needed."}`;
  } else if (debate.currentRound >= debate.maxRounds) {
    recommendation = "stalled";
    reasoning = `Max rounds (${debate.maxRounds}) reached with convergence at ${(convergence.score * 100).toFixed(0)}%. Forcing resolution.`;
  } else if (convergence.trending === "diverging") {
    recommendation = debate.currentRound >= 2 ? "escalate" : "continue";
    reasoning = `Positions are diverging (delta: ${(convergence.delta * 100).toFixed(0)}%). ${debate.currentRound >= 2 ? "Multiple rounds of divergence — escalation recommended." : "One more round may help."}`;
  } else if (convergence.trending === "stable" && debate.currentRound >= 2) {
    recommendation = "stalled";
    reasoning = `No convergence progress after ${debate.currentRound} rounds (stable at ${(convergence.score * 100).toFixed(0)}%).`;
  } else {
    recommendation = "continue";
    reasoning = `Convergence at ${(convergence.score * 100).toFixed(0)}%, trending ${convergence.trending}. More rounds may reach threshold.`;
  }

  return {
    convergenceScore: convergence.score,
    convergenceDelta: convergence.delta,
    sycophancyScore: sycophancy.score,
    positionScores: scores,
    dominantPosition: hasClearWinner
      ? debate.participants[dominantIdx].slotId
      : undefined,
    recommendation,
    reasoning,
    synthesisReady: recommendation === "converged",
  };
}

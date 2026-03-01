// ── Debate Protocol ───────────────────────────────────────────────────
// Structured multi-round debate at any hierarchy level.

import { getCoderModel } from "./model-registry.js";
import { getWorkerAgentName } from "./hierarchy.js";
import type {
  SwarmSession,
  DebateState,
  DebatePhase,
  DebateTrigger,
  DebateParticipant,
  DebateRound,
  DebatePositionScore,
  DebateEvaluation,
  DebateClaim,
  ValidationCheckpoint,
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

/** Build the position prompt for a debate participant. */
export function buildDebatePositionPrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const priorRounds = debate.rounds.filter((r) => r.completedAt);
  let historySection = "";

  if (priorRounds.length > 0) {
    const roundSummaries = priorRounds.map((r) => {
      const positions = r.contributions
        .filter((c) => c.phase === "position")
        .map(
          (c, i) =>
            `  Position ${i + 1}: ${c.content.substring(0, 500)}${c.content.length > 500 ? "..." : ""}`,
        )
        .join("\n");
      const evalNote = r.evaluation
        ? `  Evaluation: convergence=${(r.evaluation.convergenceScore * 100).toFixed(0)}%, recommendation=${r.evaluation.recommendation}`
        : "";
      return `Round ${r.roundNumber}:\n${positions}\n${evalNote}`;
    });
    historySection = `\n## PRIOR DEBATE ROUNDS (anonymous)\n${roundSummaries.join("\n\n")}\n`;
  }

  return `You are participating in a structured debate. Your role is to present and defend your position.

## DEBATE TOPIC
${debate.topic}

## TASK CONTEXT
${session.task}
${historySection}
## YOUR ASSIGNMENT
Take a clear, well-reasoned POSITION on the topic above.

Requirements:
1. State your position clearly in the first paragraph
2. Provide EVIDENCE (code references, technical reasoning, specific examples)
3. Acknowledge potential counterarguments
4. Be concrete — avoid vague generalities
5. If this is a revision from a prior round, explain what changed and why

FORMAT:
## Position
<your clear position statement>

## Evidence
<specific supporting evidence, code references, technical reasoning>

## Counterarguments Acknowledged
<potential objections you're aware of>

## Confidence
<HIGH/MEDIUM/LOW with brief justification>
`;
}

/** Build the critique prompt for a debate participant. */
export function buildDebateCritiquePrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const currentRound = debate.rounds[debate.rounds.length - 1];
  const otherPositions = currentRound.contributions
    .filter((c) => c.phase === "position" && c.slotId !== participant.slotId)
    .map((c, i) => `### Anonymous Position ${i + 1}\n${c.content}`)
    .join("\n\n");

  const myPosition = currentRound.contributions.find(
    (c) => c.phase === "position" && c.slotId === participant.slotId,
  );

  return `You are participating in a structured debate. Your role is to CRITIQUE other positions.

## DEBATE TOPIC
${debate.topic}

## YOUR POSITION (for reference)
${myPosition?.content ?? "Not yet submitted"}

## OTHER POSITIONS TO CRITIQUE
${otherPositions}

## YOUR ASSIGNMENT
Critique each position above. Be thorough and adversarial — the goal is to find weaknesses, not to be polite.

Requirements:
1. For EACH position, identify specific weaknesses, gaps, or errors
2. Challenge unsupported claims with "what evidence supports this?"
3. Identify logical fallacies or reasoning gaps
4. Point out missing considerations or edge cases
5. Be specific — reference exact claims from the position
6. Do NOT be sycophantic — genuine disagreement produces better outcomes

FORMAT (for each position):
## Critique of Position N
### Strengths
<what this position gets right>
### Weaknesses
<specific issues, gaps, errors>
### Questions
<what the proponent should address in rebuttal>
`;
}

/** Build the rebuttal prompt for a debate participant. */
export function buildDebateRebuttalPrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const currentRound = debate.rounds[debate.rounds.length - 1];

  const myPosition = currentRound.contributions.find(
    (c) => c.phase === "position" && c.slotId === participant.slotId,
  );

  const critiquesOfMe = currentRound.contributions
    .filter((c) => c.phase === "critique" && c.slotId !== participant.slotId)
    .map((c, i) => {
      return `### Critique from Reviewer ${i + 1}\n${c.content}`;
    })
    .join("\n\n");

  return `You are participating in a structured debate. Your role is to DEFEND or REVISE your position.

## DEBATE TOPIC
${debate.topic}

## YOUR ORIGINAL POSITION
${myPosition?.content ?? "Not yet submitted"}

## CRITIQUES OF YOUR POSITION
${critiquesOfMe}

## YOUR ASSIGNMENT
Respond to each critique. You may:
- DEFEND your position with additional evidence if you believe you're correct
- REVISE your position if the critiques raise valid points
- PARTIALLY CONCEDE specific points while defending others

Requirements:
1. Address EVERY critique raised — do not ignore any
2. Provide NEW evidence or reasoning (don't just repeat your original position)
3. Be honest — if a critique is valid, acknowledge it and adjust
4. Show how your revised position is stronger than before
5. Do NOT simply agree to avoid conflict — defend genuinely held views

FORMAT:
## Response to Critiques
<address each critique point by point>

## Revised Position (if changed)
<your updated position, or state "Position unchanged" with reasoning>

## Key Insight from Debate
<what you learned from the critiques, even if you disagree>

## Final Confidence
<HIGH/MEDIUM/LOW — may differ from original>
`;
}

/** Build the synthesis prompt for the debate moderator. */
export function buildDebateSynthesisPrompt(
  debate: DebateState,
  session: SwarmSession,
): string {
  const roundSummaries = debate.rounds
    .map((r) => {
      const positions = r.contributions
        .filter((c) => c.phase === "position")
        .map(
          (c, i) =>
            `  Position ${i + 1} (${c.score ? `score: ${c.score.total}/11` : "unscored"}): ${c.content.substring(0, 800)}`,
        )
        .join("\n");
      const rebuttals = r.contributions
        .filter((c) => c.phase === "rebuttal")
        .map((c, i) => `  Rebuttal ${i + 1}: ${c.content.substring(0, 500)}`)
        .join("\n");
      const evalNote = r.evaluation
        ? `  Evaluation: convergence=${(r.evaluation.convergenceScore * 100).toFixed(0)}%, sycophancy=${(r.evaluation.sycophancyScore * 100).toFixed(0)}%, recommendation=${r.evaluation.recommendation}`
        : "";
      return `### Round ${r.roundNumber}\nPositions:\n${positions}\nRebuttals:\n${rebuttals}\n${evalNote}`;
    })
    .join("\n\n");

  const lastEval = debate.rounds[debate.rounds.length - 1]?.evaluation;

  return `You are the DEBATE SYNTHESIZER. Produce the final decision from the debate.

## DEBATE TOPIC
${debate.topic}

## TASK CONTEXT
${session.task}

## DEBATE HISTORY
${roundSummaries}

## LAST EVALUATION
${
  lastEval
    ? `Convergence: ${(lastEval.convergenceScore * 100).toFixed(0)}%
Dominant position: ${lastEval.dominantPosition ?? "none"}
Recommendation: ${lastEval.recommendation}
Reasoning: ${lastEval.reasoning}`
    : "No evaluation available"
}

## YOUR ASSIGNMENT
Synthesize the debate into a FINAL DECISION. You are not picking a winner — you are producing the best answer informed by all perspectives.

Requirements:
1. State the final position clearly
2. Explain which arguments from each side influenced the decision
3. Address the strongest counterargument that was raised
4. Include confidence level and any caveats
5. If positions were irreconcilable, explain the trade-off being made

FORMAT:
## Final Decision
<the synthesized position>

## Reasoning
<how you arrived at this, which arguments were most persuasive>

## Incorporated from Each Side
<specific insights from each debater that made it into the final decision>

## Caveats
<conditions under which a different decision might be appropriate>

## Confidence: <HIGH/MEDIUM/LOW>
`;
}

/** Build the escalation context for a stalled debate. */
export function buildEscalationContext(
  debate: DebateState,
  session: SwarmSession,
): string {
  const roundSummaries = debate.rounds
    .map((r) => {
      const positions = r.contributions
        .filter((c) => c.phase === "position")
        .map((c, i) => `  Position ${i + 1}: ${c.content.substring(0, 600)}`)
        .join("\n");
      const evalNote = r.evaluation
        ? `  Convergence: ${(r.evaluation.convergenceScore * 100).toFixed(0)}%, Sycophancy: ${(r.evaluation.sycophancyScore * 100).toFixed(0)}%, Recommendation: ${r.evaluation.recommendation}`
        : "";
      return `Round ${r.roundNumber}:\n${positions}\n${evalNote}`;
    })
    .join("\n\n");

  return `## ESCALATED DEBATE: ${debate.topic}
Debate ID: ${debate.id}
Group: ${debate.groupId ?? "L1-level"}
Trigger: ${debate.trigger}
Rounds completed: ${debate.currentRound}/${debate.maxRounds}
Status: ${debate.status}

### Debate Summary
${roundSummaries}

### Why Escalated
${debate.rounds[debate.rounds.length - 1]?.evaluation?.reasoning ?? "Max rounds exceeded without convergence"}

### What is needed
A decision from the L1 orchestrator on which approach to take, or a directive to modify the approach entirely.
`;
}

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

// ── Partial Consensus: Claim Extraction & Tracking ───────────────────

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

// ── Fast-Track ──────────────────────────────────────────────────────

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

// ── Devil's Advocate ─────────────────────────────────────────────────

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

/** Build a contrarian-modified position prompt. */
export function buildContrarianPrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const lastRound = debate.rounds[debate.rounds.length - 1];
  const dominantPosition = lastRound?.evaluation?.dominantPosition;
  const dominantContent =
    lastRound?.contributions
      .filter((c) => c.phase === "position" || c.phase === "rebuttal")
      .find((c) => c.slotId === dominantPosition)?.content ?? "";

  const consensus = getPartialConsensus(debate);
  const agreedClaims = consensus.agreed.map((c) => `  - ${c.text}`).join("\n");

  return `You are the DEVIL'S ADVOCATE in this debate. Your job is to STRESS-TEST the emerging consensus.

## DEBATE TOPIC
${debate.topic}

## TASK CONTEXT
${session.task}

## EMERGING CONSENSUS (you must challenge this)
${dominantContent.substring(0, 1000)}

## AGREED CLAIMS (challenge the weakest of these)
${agreedClaims || "No claims formally agreed yet."}

## YOUR ASSIGNMENT
Take the STRONGEST POSSIBLE opposing position. This is not about being contrarian for its own sake — it's about finding blind spots.

Requirements:
1. Identify the WEAKEST assumption in the consensus position
2. Construct a compelling alternative that the other side hasn't considered
3. Find edge cases, failure modes, or scaling issues the consensus ignores
4. Use CONCRETE evidence — code paths, performance data, real-world examples
5. Be intellectually honest — if the consensus is genuinely strong, say so but still probe its limits

FORMAT:
## Contrarian Position
<your strongest opposing argument>

## Weakest Assumption in Consensus
<the assumption most likely to be wrong>

## Evidence Against Consensus
<specific technical evidence>

## Failure Modes
<scenarios where the consensus approach breaks>

## Confidence That Consensus Is Wrong: <HIGH/MEDIUM/LOW>
`;
}

// ── Validation Checkpoint ────────────────────────────────────────────

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

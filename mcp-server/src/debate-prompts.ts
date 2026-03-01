// ── Debate Prompts ────────────────────────────────────────────────────
// Prompt builders for all debate phases.

import type {
  SwarmSession,
  DebateState,
  DebateParticipant,
} from "./swarm-types.js";
import { getPartialConsensus } from "./debate-claims.js";

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

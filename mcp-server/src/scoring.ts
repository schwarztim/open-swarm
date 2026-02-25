export interface QualityScore {
  correctness: number;      // 0-3
  responsiveness: number;   // 0-3
  constructiveness: number; // 0-2
  novelty: number;          // 0-2
  total: number;            // 0-10
  criticalIssues: number;   // count of blockers
  summary: string;          // one-line assessment
}

export interface GateResult {
  proceed: boolean;
  failedWorkstreams: string[];  // IDs of workstreams below threshold
  retryAllowed: boolean;        // currentLoop < maxLoops
  message: string;
}

/**
 * Parse a critic's output block into a QualityScore.
 * Expects a SCORES: section with lines like "- Correctness: 2/3".
 */
export function parseScore(reviewOutput: string): QualityScore {
  const extract = (pattern: RegExp): number | null => {
    const m = reviewOutput.match(pattern);
    return m ? parseInt(m[1], 10) : null;
  };

  const correctness    = extract(/Correctness\s*:\s*(\d+)\s*\/\s*3/i);
  const responsiveness = extract(/Responsiveness\s*:\s*(\d+)\s*\/\s*3/i);
  const constructiveness = extract(/Constructiveness\s*:\s*(\d+)\s*\/\s*2/i);
  const novelty        = extract(/Novelty\s*:\s*(\d+)\s*\/\s*2/i);
  const criticalIssues = extract(/Critical\s+Issues\s*:\s*(\d+)/i);

  if (
    correctness === null ||
    responsiveness === null ||
    constructiveness === null ||
    novelty === null ||
    criticalIssues === null
  ) {
    return {
      correctness: 0,
      responsiveness: 0,
      constructiveness: 0,
      novelty: 0,
      total: 0,
      criticalIssues: 0,
      summary: 'Score parsing failed',
    };
  }

  const total = correctness + responsiveness + constructiveness + novelty;

  // Extract a one-line summary from the review if present, else build one.
  const summaryMatch = reviewOutput.match(/SUMMARY\s*:\s*(.+)/i);
  const summary = summaryMatch
    ? summaryMatch[1].trim()
    : `Score ${total}/10 — correctness:${correctness} responsiveness:${responsiveness} constructiveness:${constructiveness} novelty:${novelty}`;

  return { correctness, responsiveness, constructiveness, novelty, total, criticalIssues, summary };
}

/**
 * Evaluate whether all workstream scores meet the quality gate (≥7 total).
 * Accepts parallel arrays: scores[i] corresponds to workstreamIds[i].
 */
export function checkGate(
  scores: QualityScore[],
  maxLoops: number,
  currentLoop: number,
  workstreamIds?: string[],
): GateResult {
  const retryAllowed = currentLoop < maxLoops;

  // Force-proceed when loop budget exhausted.
  if (currentLoop >= maxLoops) {
    const lowIds = scores
      .map((s, i) => (s.total < 7 ? (workstreamIds?.[i] ?? `ws-${i}`) : null))
      .filter((id): id is string => id !== null);

    return {
      proceed: true,
      failedWorkstreams: lowIds,
      retryAllowed: false,
      message:
        lowIds.length > 0
          ? `Max loops (${maxLoops}) reached — forcing proceed despite low scores on: ${lowIds.join(', ')}`
          : `Max loops (${maxLoops}) reached — proceeding.`,
    };
  }

  const failedWorkstreams = scores
    .map((s, i) => (s.total < 7 ? (workstreamIds?.[i] ?? `ws-${i}`) : null))
    .filter((id): id is string => id !== null);

  if (failedWorkstreams.length === 0) {
    return {
      proceed: true,
      failedWorkstreams: [],
      retryAllowed,
      message: 'All workstreams passed quality gate (≥7/10).',
    };
  }

  return {
    proceed: false,
    failedWorkstreams,
    retryAllowed,
    message: `Quality gate failed for: ${failedWorkstreams.join(', ')}. Scores below threshold (7/10). ${retryAllowed ? `Retry ${currentLoop + 1}/${maxLoops} allowed.` : 'No retries remaining.'}`,
  };
}

/**
 * Build the prompt sent to a critic agent for a given workstream output.
 */
export function generateCriticPrompt(
  workstreamOutput: string,
  taskDescription: string,
  anonymousHistory: string,
): string {
  return `You are a quality-review critic. Evaluate the following workstream output against the task description.

## TASK
${taskDescription}

## CROSS-WORKSTREAM HISTORY (anonymous)
${anonymousHistory}

## WORKSTREAM OUTPUT TO REVIEW
${workstreamOutput}

## SCORING RUBRIC
Score each dimension independently:

| Dimension        | Max | Criteria |
|-----------------|-----|----------|
| Correctness      |  3  | 0 = wrong/broken, 1 = partially correct, 2 = mostly correct, 3 = fully correct |
| Responsiveness   |  3  | 0 = ignores task, 1 = partially addresses, 2 = mostly addresses, 3 = fully addresses |
| Constructiveness |  2  | 0 = no value add, 1 = some improvement, 2 = clear improvement |
| Novelty          |  2  | 0 = nothing new, 1 = minor new insight, 2 = significant new contribution |

Total is the sum of all dimensions (max 10).
Also count Critical Issues: blockers that would prevent the output from being used (bugs, missing requirements, security issues).

## OUTPUT FORMAT
Provide your analysis, then You MUST output a SCORES section at the end in exactly this format:

SCORES:
- Correctness: X/3
- Responsiveness: X/3
- Constructiveness: X/2
- Novelty: X/2
- Critical Issues: N

SUMMARY: <one-line assessment>
`;
}

/**
 * Build the retry prompt sent to agents whose workstreams failed the quality gate.
 */
export function generateRetryPrompt(
  failedScores: QualityScore[],
  crossContext: string,
): string {
  const breakdown = failedScores
    .map((s, i) => {
      const issues: string[] = [];
      if (s.correctness < 2)      issues.push(`Correctness is low (${s.correctness}/3) — fix bugs and ensure outputs are accurate`);
      if (s.responsiveness < 2)   issues.push(`Responsiveness is low (${s.responsiveness}/3) — ensure all requirements are addressed`);
      if (s.constructiveness < 1) issues.push(`Constructiveness is low (${s.constructiveness}/2) — provide concrete improvements`);
      if (s.novelty < 1)          issues.push(`Novelty is low (${s.novelty}/2) — add new insights or approaches`);
      if (s.criticalIssues > 0)   issues.push(`${s.criticalIssues} critical issue(s) must be resolved before proceeding`);

      return `Workstream ${i + 1} (total ${s.total}/10):\n${issues.map((x) => `  • ${x}`).join('\n')}`;
    })
    .join('\n\n');

  return `## RETRY REQUIRED — Quality Gate Not Passed

The following workstreams did not reach the required score of 7/10:

${breakdown}

## IMPROVEMENT TARGETS
- Correctness ≥ 2/3
- Responsiveness ≥ 2/3
- Constructiveness ≥ 1/2
- Novelty ≥ 1/2
- Zero critical issues

## CROSS-WORKSTREAM CONTEXT
Use the following anonymous context from other workstreams to align your improvements:

${crossContext}

Address every issue listed above. Your revised output will be scored again.
`;
}

// ── Debate Scoring (Agent-Skills: advanced-evaluation) ─────────────────
// Implements LLM-as-judge evaluation for debate positions.
// Based on Agent-Skills advanced-evaluation: direct scoring, pairwise comparison,
// position bias mitigation, and sycophancy detection.

export interface DebateScoreInput {
  position: string;
  critiques: string[];
  rebuttal: string;
  topic: string;
}

/**
 * Generate an evaluation prompt for scoring debate positions.
 * This prompt is sent to a critic/evaluator model to score each position.
 * Follows Agent-Skills advanced-evaluation patterns for rubric design.
 */
export function generateDebateEvalPrompt(
  positions: Array<{ slotId: string; position: string; rebuttal?: string }>,
  critiques: string[],
  topic: string,
  taskContext: string,
): string {
  const positionBlocks = positions.map((p, i) =>
    `### Position ${i + 1} (${p.slotId})
INITIAL POSITION:
${p.position}

${p.rebuttal ? `REBUTTAL (after critique):
${p.rebuttal}` : 'No rebuttal submitted.'}`
  ).join('\n\n');

  const critiqueBlock = critiques.length > 0
    ? `## CRITIQUES EXCHANGED\n${critiques.map((c, i) => `Critique ${i + 1}:\n${c}`).join('\n\n')}`
    : 'No critiques available.';

  return `You are an expert debate evaluator. Score each position in this structured debate.

## DEBATE TOPIC
${topic}

## TASK CONTEXT
${taskContext}

## POSITIONS
${positionBlocks}

${critiqueBlock}

## SCORING RUBRIC
Score each position independently on these dimensions:

| Dimension               | Max | Criteria |
|------------------------|-----|----------|
| Evidence Quality        |  3  | 0 = no evidence, 1 = anecdotal, 2 = referenced, 3 = well-documented with code/data |
| Reasoning Clarity       |  3  | 0 = incoherent, 1 = partially clear, 2 = mostly clear, 3 = logically structured |
| Rebuttal Effectiveness  |  3  | 0 = ignored critiques, 1 = partially addressed, 2 = mostly addressed, 3 = fully addressed with new evidence |
| Novel Contribution      |  2  | 0 = nothing new, 1 = minor insight, 2 = significant unique contribution |

Total is the sum (max 11).

## SYCOPHANCY CHECK
Also assess whether positions are genuinely independent or just echoing each other:
- Do positions maintain distinct perspectives after critique?
- Are rebuttals substantive or just agreement?
- Is there evidence of genuine intellectual engagement?

## OUTPUT FORMAT
For EACH position, output:

DEBATE_SCORES (Position N):
- Evidence Quality: X/3
- Reasoning Clarity: X/3
- Rebuttal Effectiveness: X/3
- Novel Contribution: X/2
- Sycophancy Risk: LOW/MEDIUM/HIGH

CONVERGENCE: X% (0-100, how close are positions to agreement)
SYCOPHANCY: X% (0-100, how much are they just agreeing without substance)
DOMINANT: <position number or "none">

DEBATE_SUMMARY: <one-line assessment of debate quality and outcome>
`;
}

/**
 * Parse a debate evaluation output into structured scores.
 * Expects the DEBATE_SCORES format produced by generateDebateEvalPrompt.
 */
export function parseDebateEvalOutput(evalOutput: string): {
  positionScores: Array<{
    evidenceQuality: number;
    reasoningClarity: number;
    rebuttalEffectiveness: number;
    novelContribution: number;
    total: number;
    sycophancyRisk: string;
  }>;
  convergence: number;
  sycophancy: number;
  dominant: string;
  summary: string;
} | null {
  const scoreBlocks = evalOutput.split(/DEBATE_SCORES\s*\(Position\s*\d+\)/i);
  const positionScores: Array<{
    evidenceQuality: number;
    reasoningClarity: number;
    rebuttalEffectiveness: number;
    novelContribution: number;
    total: number;
    sycophancyRisk: string;
  }> = [];

  for (const block of scoreBlocks.slice(1)) {
    const extract = (pattern: RegExp): number | null => {
      const m = block.match(pattern);
      return m ? parseInt(m[1], 10) : null;
    };

    const evidenceQuality = extract(/Evidence\s+Quality\s*:\s*(\d+)\s*\/\s*3/i);
    const reasoningClarity = extract(/Reasoning\s+Clarity\s*:\s*(\d+)\s*\/\s*3/i);
    const rebuttalEffectiveness = extract(/Rebuttal\s+Effectiveness\s*:\s*(\d+)\s*\/\s*3/i);
    const novelContribution = extract(/Novel\s+Contribution\s*:\s*(\d+)\s*\/\s*2/i);
    const sycophancyMatch = block.match(/Sycophancy\s+Risk\s*:\s*(LOW|MEDIUM|HIGH)/i);

    if (evidenceQuality !== null && reasoningClarity !== null &&
        rebuttalEffectiveness !== null && novelContribution !== null) {
      positionScores.push({
        evidenceQuality,
        reasoningClarity,
        rebuttalEffectiveness,
        novelContribution,
        total: evidenceQuality + reasoningClarity + rebuttalEffectiveness + novelContribution,
        sycophancyRisk: sycophancyMatch ? sycophancyMatch[1].toUpperCase() : 'UNKNOWN',
      });
    }
  }

  const convergenceMatch = evalOutput.match(/CONVERGENCE\s*:\s*(\d+)\s*%/i);
  const sycophancyMatch = evalOutput.match(/SYCOPHANCY\s*:\s*(\d+)\s*%/i);
  const dominantMatch = evalOutput.match(/DOMINANT\s*:\s*(.+)/i);
  const summaryMatch = evalOutput.match(/DEBATE_SUMMARY\s*:\s*(.+)/i);

  if (positionScores.length === 0) return null;

  return {
    positionScores,
    convergence: convergenceMatch ? parseInt(convergenceMatch[1], 10) / 100 : 0,
    sycophancy: sycophancyMatch ? parseInt(sycophancyMatch[1], 10) / 100 : 0,
    dominant: dominantMatch ? dominantMatch[1].trim() : 'none',
    summary: summaryMatch ? summaryMatch[1].trim() : 'Debate evaluation complete',
  };
}

// ── Drift Scoring ─────────────────────────────────────────────────────
// Score how well a worker's output aligns with the original task goal.

export function generateDriftCheckPrompt(
  taskGoal: string,
  output: string,
): string {
  return `You are an alignment checker. Evaluate whether the worker output stays on-task.

## ORIGINAL TASK GOAL
${taskGoal}

## WORKER OUTPUT
${output.substring(0, 3000)}

## EVALUATION
Score how well the output aligns with the original task:
- 0.0-0.3: Severely off-topic. Output addresses different concerns than the task.
- 0.3-0.6: Partially aligned. Some relevant work but significant drift.
- 0.6-0.8: Mostly aligned. Addresses the task with minor tangential work.
- 0.8-1.0: Fully aligned. Output directly addresses every aspect of the task.

Identify specific drift signals:
- Scope creep (doing more than asked)
- Topic drift (addressing different concerns)
- Incomplete coverage (missing key requirements)

OUTPUT FORMAT:
ALIGNMENT: X.XX
DRIFT_SIGNALS:
- <signal 1>
- <signal 2>
DRIFT_SUMMARY: <one-line assessment>
`;
}

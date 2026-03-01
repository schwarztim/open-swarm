import {
  type SwarmSession,
  type PhaseDefinition,
  storePrompt,
  getWorkerAgentName,
} from "../state.js";

// ── Helpers ───────────────────────────────────────────────────────────

export type ToolResult = { content: Array<{ type: string; text: string }> };

export function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function err(message: string): ToolResult {
  return ok({ error: message });
}

export const MAX_INPUT_LENGTH = 100_000;

export function validateString(
  value: unknown,
  fieldName: string,
  maxLength = MAX_INPUT_LENGTH,
): string | ToolResult {
  if (typeof value !== "string" || value.trim() === "") {
    return err(`Missing or invalid field: ${fieldName}`);
  }
  if (value.length > maxLength) {
    return err(
      `Field "${fieldName}" exceeds maximum length of ${maxLength} characters`,
    );
  }
  return value;
}

export function buildTaskCall(
  session: SwarmSession,
  phaseDef: PhaseDefinition,
  description: string,
  prompt: string,
  model?: string,
) {
  const resolvedModel = model ?? phaseDef.model;
  const subagentType = getWorkerAgentName(resolvedModel);
  const promptRef = storePrompt(session, prompt);
  return {
    subagent_type: subagentType,
    description,
    promptRef,
  };
}

export function workstreamCount(session: { workstreams: { id: string }[] }): number {
  return Math.max(session.workstreams.length, 2);
}

// ── Convergence Metrics (arXiv:2602.16301) ────────────────────────────

export function computeConvergence(
  session: SwarmSession,
  currentRound: number,
  currentScores: Array<{ workstream: string; score: number }>,
) {
  const avgCurrent =
    currentScores.reduce((s, c) => s + c.score, 0) / currentScores.length;

  // Find previous round scores
  const prevRound = currentRound - 1;
  const prevScores = session.rounds.filter((r) => r.round === prevRound);
  const avgPrev =
    prevScores.length > 0
      ? prevScores.reduce((s, r) => s + r.score, 0) / prevScores.length
      : 0;

  const delta = prevScores.length > 0 ? avgCurrent - avgPrev : avgCurrent;
  const stalling = prevScores.length > 0 && Math.abs(delta) < 0.5;

  // Collect all round averages for trend
  const roundAvgs: Array<{ round: number; avg: number }> = [];
  const allRounds = new Set(session.rounds.map((r) => r.round));
  for (const r of allRounds) {
    const scores = session.rounds.filter((s) => s.round === r);
    roundAvgs.push({
      round: r,
      avg: scores.reduce((s, c) => s + c.score, 0) / scores.length,
    });
  }
  roundAvgs.push({ round: currentRound, avg: avgCurrent });
  roundAvgs.sort((a, b) => a.round - b.round);

  return {
    currentAvg: Math.round(avgCurrent * 100) / 100,
    previousAvg: prevScores.length > 0 ? Math.round(avgPrev * 100) / 100 : null,
    delta: Math.round(delta * 100) / 100,
    stalling,
    stallingWarning: stalling
      ? "Quality improvement < 0.5 across rounds. Consider changing approach or models."
      : undefined,
    trend: roundAvgs,
    totalRounds: currentRound,
  };
}

// Anti-drift configuration
export const DRIFT_THRESHOLD = 0.4;

/**
 * Self-learning loop: RETRIEVE → JUDGE → DISTILL → CONSOLIDATE → ROUTE.
 * Builds on memory.ts for persistent pattern storage.
 */

import { memoryStore } from "./memory.js";
import { patternToText } from "./embeddings.js";
import type { PatternEntryV2, Outcome } from "./types.js";
import type { SwarmSession } from "./state.js";

// ── RETRIEVE ──────────────────────────────────────────────────────────
/**
 * Find relevant patterns for a task description.
 * Records usage on each returned pattern to boost confidence.
 * Returns patterns + formatted injection context.
 */
export async function retrieve(
  sessionId: string,
  taskDescription: string,
): Promise<{
  patterns: PatternEntryV2[];
  injectionContext: string;
  patternIds: string[];
}> {
  const results = await memoryStore.searchSemantic(taskDescription, 5);
  const patterns = results.map(({ relevance, ...p }) => p);
  const patternIds = patterns.map((p) => p.id);

  // Record usage to boost confidence
  for (const id of patternIds) {
    memoryStore.recordUsage(id);
  }

  const injectionContext = buildPatternContext(patterns);

  return { patterns, injectionContext, patternIds };
}

// ── JUDGE ─────────────────────────────────────────────────────────────
/**
 * Record outcome after quality gate evaluation.
 * Triggers DISTILL if avg score >= 8.
 */
export async function judge(
  session: SwarmSession,
  scores: Array<{ workstream: string; score: number; criticalIssues: number }>,
  metadata?: {
    modelUsed?: string;
    durationMs?: number;
    whatWorked?: string[];
    whatFailed?: string[];
  },
): Promise<{
  outcome: Outcome;
  avgScore: number;
  shouldDistill: boolean;
}> {
  const avgScore =
    scores.length > 0
      ? scores.reduce((sum, s) => sum + s.score, 0) / scores.length
      : 0;
  const totalCritical = scores.reduce((sum, s) => sum + s.criticalIssues, 0);

  const outcome = memoryStore.storeOutcome({
    sessionId: session.id,
    taskDescription: session.task,
    tier: session.tier,
    modelUsed: metadata?.modelUsed ?? null,
    qualityScore: avgScore,
    criticalIssues: totalCritical,
    durationMs: metadata?.durationMs ?? null,
    patternIdsUsed: session.patternIdsUsed ?? [],
    whatWorked: metadata?.whatWorked ?? [],
    whatFailed:
      avgScore < 5
        ? [
            ...(metadata?.whatFailed ?? []),
            `Low score (${avgScore.toFixed(1)}) — approach may be suboptimal`,
          ]
        : (metadata?.whatFailed ?? []),
    createdAt: Date.now(),
  });

  return {
    outcome,
    avgScore: Math.round(avgScore * 100) / 100,
    shouldDistill: avgScore >= 8,
  };
}

// ── DISTILL ───────────────────────────────────────────────────────────
/**
 * Extract a reusable pattern from a successful session.
 * Checks for near-duplicates (cosine > 0.9) before storing.
 */
export async function distill(session: SwarmSession): Promise<{
  action: "stored" | "boosted";
  patternId: string;
}> {
  // Build pattern from session data
  const boardDecisions = session.board
    .filter((m) => m.type === "decision")
    .map((m) => m.content)
    .slice(0, 5);
  const allFiles = session.workstreams.flatMap((ws) => ws.files);
  const uniqueFiles = [...new Set(allFiles)];

  // Build approach from board findings
  const findings = session.board
    .filter((m) => m.type === "finding" || m.type === "report")
    .map((m) => m.content)
    .slice(0, 3);
  const approach =
    findings.length > 0
      ? findings.join("; ")
      : `${session.tier} tier on ${session.task.substring(0, 200)}`;

  // Infer task type from task description
  const taskType = inferTaskType(session.task);

  // Build tags from workstream descriptions
  const tags = [
    session.tier,
    taskType,
    ...session.workstreams.map((ws) => ws.description).slice(0, 3),
  ].filter(Boolean);

  // Check for near-duplicates
  const text = patternToText({
    taskType,
    approach,
    tags,
    keyDecisions: boardDecisions,
  });

  const similar = await memoryStore.searchSemantic(text, 3);
  const nearDuplicate = similar.find((s) => s.relevance >= 0.9);

  if (nearDuplicate) {
    // Boost confidence on existing pattern instead of creating duplicate
    memoryStore.recordUsage(nearDuplicate.id);
    return { action: "boosted", patternId: nearDuplicate.id };
  }

  // Store new pattern with 90-day TTL
  const ninety = 90 * 24 * 60 * 60 * 1000;
  const avgScore =
    session.workstreams.reduce((sum, ws) => sum + (ws.score ?? 0), 0) /
    Math.max(session.workstreams.length, 1);

  const pattern = await memoryStore.storePattern({
    taskType,
    approach,
    filesInvolved: uniqueFiles.slice(0, 20),
    qualityScore: avgScore,
    keyDecisions: boardDecisions,
    tags,
    confidence: 1.0,
    useCount: 0,
    lastUsedAt: null,
    expiresAt: Date.now() + ninety,
    createdAt: Date.now(),
    sessionId: session.id,
  });

  return { action: "stored", patternId: pattern.id };
}

// ── CONSOLIDATE ───────────────────────────────────────────────────────
/**
 * Merge similar patterns, decay unused, prune dead, clean expired.
 */
export async function consolidate(mergeThreshold: number = 0.9): Promise<{
  merged: number;
  pruned: number;
  decayed: number;
  expired: number;
  remaining: number;
}> {
  // 1. Find and merge near-duplicates
  let merged = 0;
  const allPatterns = memoryStore.getAllPatterns();
  const processedIds = new Set<string>();

  for (const p of allPatterns) {
    if (processedIds.has(p.id)) continue;

    const similar = await memoryStore.findSimilar(p.id, mergeThreshold);
    if (similar.length > 0) {
      const idsToMerge = [p.id, ...similar.map((s) => s.id)];
      await memoryStore.mergePatterns(idsToMerge);
      for (const id of idsToMerge) processedIds.add(id);
      merged += similar.length;
    }
  }

  // 2. Decay confidence for patterns unused > 30 days
  const decayed = memoryStore.decayConfidence(30);

  // 3. Prune patterns with very low confidence
  const pruned = memoryStore.prunePatterns(0.1);

  // 4. Clean expired patterns
  const expired = memoryStore.cleanExpired();

  return {
    merged,
    pruned,
    decayed,
    expired,
    remaining: memoryStore.getPatternCount(),
  };
}

// ── ROUTE ─────────────────────────────────────────────────────────────
/**
 * Recommend model and approach hints based on similar past tasks.
 */
export async function route(taskDescription: string): Promise<{
  model: string | null;
  hints: string[];
  confidence: number;
}> {
  // Get top-3 similar patterns
  const similar = await memoryStore.searchSemantic(taskDescription, 3);

  if (similar.length === 0) {
    return { model: null, hints: [], confidence: 0 };
  }

  // Cross-reference with outcomes — which models scored highest for similar tasks
  const hints: string[] = [];
  let bestModel: string | null = null;
  let bestScore = 0;

  const recentOutcomes = memoryStore.getRecentOutcomes(50);

  for (const pattern of similar) {
    // Find outcomes that used this pattern
    const relatedOutcomes = recentOutcomes.filter(
      (o) =>
        o.patternIdsUsed.includes(pattern.id) &&
        o.qualityScore !== null &&
        o.qualityScore >= 7,
    );

    for (const o of relatedOutcomes) {
      if (
        o.modelUsed &&
        o.qualityScore !== null &&
        o.qualityScore > bestScore
      ) {
        bestModel = o.modelUsed;
        bestScore = o.qualityScore;
      }
    }

    hints.push(`[${pattern.taskType}] ${pattern.approach.substring(0, 100)}`);
  }

  const avgRelevance =
    similar.reduce((sum, s) => sum + s.relevance, 0) / similar.length;

  return {
    model: avgRelevance >= 0.7 ? bestModel : null,
    hints: hints.slice(0, 3),
    confidence: Math.round(avgRelevance * 100) / 100,
  };
}

// ── Stats ─────────────────────────────────────────────────────────────

export function getStats(): {
  totalPatterns: number;
  avgConfidence: number;
  recentOutcomes: number;
} {
  return {
    totalPatterns: memoryStore.getPatternCount(),
    avgConfidence: memoryStore.getAverageConfidence(),
    recentOutcomes: memoryStore.getRecentOutcomes(100).length,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildPatternContext(patterns: PatternEntryV2[]): string {
  if (patterns.length === 0) return "";
  const lines = ["", "--- RELEVANT PATTERNS FROM PRIOR TASKS ---"];
  for (const p of patterns) {
    lines.push(
      `[${p.taskType}] Score: ${p.qualityScore}/10 (confidence: ${p.confidence.toFixed(2)}, used: ${p.useCount}x)`,
    );
    lines.push(`  Approach: ${p.approach}`);
    if (p.keyDecisions.length > 0) {
      lines.push(`  Key decisions: ${p.keyDecisions.join("; ")}`);
    }
    lines.push(`  Files: ${p.filesInvolved.join(", ")}`);
    lines.push("");
  }
  lines.push("--- END PATTERNS ---");
  return lines.join("\n");
}

function inferTaskType(task: string): string {
  const lower = task.toLowerCase();
  if (lower.includes("auth") || lower.includes("login"))
    return "auth-implementation";
  if (lower.includes("api") || lower.includes("endpoint"))
    return "api-development";
  if (lower.includes("test")) return "testing";
  if (lower.includes("refactor")) return "refactoring";
  if (lower.includes("bug") || lower.includes("fix")) return "bug-fix";
  if (lower.includes("perf") || lower.includes("optim")) return "performance";
  if (lower.includes("security") || lower.includes("vuln")) return "security";
  if (lower.includes("deploy") || lower.includes("ci")) return "devops";
  if (lower.includes("doc") || lower.includes("readme")) return "documentation";
  if (lower.includes("ui") || lower.includes("component")) return "frontend";
  if (lower.includes("database") || lower.includes("schema")) return "database";
  return "general";
}

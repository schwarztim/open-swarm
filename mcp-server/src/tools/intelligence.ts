import { getSession } from "../state.js";
import { memoryStore } from "../memory.js";
import {
  retrieve,
  judge,
  distill,
  consolidate,
  route,
  getStats,
} from "../learning.js";
import { workerRegistry, TRIGGER_DESCRIPTIONS, WORKER_TYPE_DESCRIPTIONS } from "../workers.js";
import { ok, err, type ToolResult } from "./shared.js";

// ── swarm_memory ──────────────────────────────────────────────────────

export async function handleSwarmMemory(args: {
  sessionId: string;
  action: "search" | "store" | "list";
  query?: string;
  taskType?: string;
  approach?: string;
  filesInvolved?: string[];
  qualityScore?: number;
  keyDecisions?: string[];
  tags?: string[];
  limit?: number;
}): Promise<ToolResult> {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "search": {
      if (!args.query) return err("query required for search action");

      const results = await memoryStore.searchSemantic(
        args.query,
        args.limit ?? 5,
      );

      return ok({
        matchCount: results.length,
        patterns: results.map((p) => ({
          id: p.id,
          taskType: p.taskType,
          approach: p.approach,
          qualityScore: p.qualityScore,
          confidence: p.confidence,
          useCount: p.useCount,
          tags: p.tags,
          keyDecisions: p.keyDecisions,
          filesInvolved: p.filesInvolved,
          relevance: p.relevance,
        })),
        nextAction:
          results.length > 0
            ? `Found ${results.length} relevant pattern(s) via semantic search. Inject context into worker prompts.`
            : `No matching patterns found. Worker will start fresh.`,
      });
    }

    case "store": {
      if (!args.taskType) return err("taskType required for store action");
      if (!args.approach) return err("approach required for store action");
      if (!args.qualityScore)
        return err("qualityScore required for store action");
      if (args.qualityScore < 8) {
        return err(
          `Quality score must be ≥8 to store pattern (got ${args.qualityScore}). Only high-quality patterns are stored.`,
        );
      }

      const entry = await memoryStore.storePattern({
        taskType: args.taskType,
        approach: args.approach,
        filesInvolved: args.filesInvolved ?? [],
        qualityScore: args.qualityScore,
        keyDecisions: args.keyDecisions ?? [],
        tags: args.tags ?? [],
        confidence: 1.0,
        useCount: 0,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: Date.now(),
        sessionId: session.id,
      });

      return ok({
        patternId: entry.id,
        taskType: entry.taskType,
        qualityScore: entry.qualityScore,
        nextAction: `Pattern "${entry.id}" stored with semantic embedding (score: ${entry.qualityScore}/10). Available for future workers.`,
      });
    }

    case "list": {
      const allPatterns = memoryStore.getAllPatterns();
      return ok({
        totalPatterns: allPatterns.length,
        patterns: allPatterns.map((p) => ({
          id: p.id,
          taskType: p.taskType,
          qualityScore: p.qualityScore,
          confidence: p.confidence,
          useCount: p.useCount,
          tags: p.tags,
        })),
        nextAction: `${allPatterns.length} pattern(s) in persistent memory.`,
      });
    }

    default:
      return err(`Unknown memory action: ${args.action}`);
  }
}

// ── swarm_learn ───────────────────────────────────────────────────────

export async function handleSwarmLearn(args: {
  sessionId: string;
  action: "retrieve" | "judge" | "distill" | "consolidate" | "route" | "stats";
  taskDescription?: string;
  scores?: Array<{ workstream: string; score: number; criticalIssues: number }>;
  metadata?: {
    modelUsed?: string;
    durationMs?: number;
    whatWorked?: string[];
    whatFailed?: string[];
  };
}): Promise<ToolResult> {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "retrieve": {
      const desc = args.taskDescription ?? session.task;
      const result = await retrieve(session.id, desc);
      session.patternIdsUsed = result.patternIds;
      return ok({
        matchCount: result.patterns.length,
        patternIds: result.patternIds,
        injectionContext: result.injectionContext,
        nextAction:
          result.patterns.length > 0
            ? `Found ${result.patterns.length} relevant pattern(s). Inject into worker prompts.`
            : "No prior patterns found.",
      });
    }

    case "judge": {
      if (!args.scores) return err("scores required for judge action");
      const result = await judge(session, args.scores, args.metadata);
      return ok({
        outcomeId: result.outcome.id,
        avgScore: result.avgScore,
        shouldDistill: result.shouldDistill,
        nextAction: result.shouldDistill
          ? `Score ${result.avgScore} >= 8. Call swarm_learn with action="distill" to extract pattern.`
          : `Score ${result.avgScore} recorded. No pattern extraction needed.`,
      });
    }

    case "distill": {
      const result = await distill(session);
      return ok({
        action: result.action,
        patternId: result.patternId,
        nextAction:
          result.action === "stored"
            ? `New pattern "${result.patternId}" extracted and stored.`
            : `Near-duplicate found. Boosted confidence on "${result.patternId}".`,
      });
    }

    case "consolidate": {
      const result = await consolidate();
      return ok({
        ...result,
        nextAction: `Consolidated: ${result.merged} merged, ${result.pruned} pruned, ${result.decayed} decayed, ${result.expired} expired. ${result.remaining} patterns remaining.`,
      });
    }

    case "route": {
      const desc = args.taskDescription ?? session.task;
      const result = await route(desc);
      return ok({
        recommendedModel: result.model,
        hints: result.hints,
        confidence: result.confidence,
        nextAction: result.model
          ? `Recommend model "${result.model}" (confidence: ${result.confidence}).`
          : "No strong model recommendation. Use default.",
      });
    }

    case "stats": {
      return ok(getStats());
    }

    default:
      return err(`Unknown learn action: ${args.action}`);
  }
}

// ── swarm_watch ───────────────────────────────────────────────────────

export function handleSwarmWatch(args: {
  sessionId: string;
  action: "subscribe" | "list" | "check";
  workerType?: string;
  triggerEvent?: string;
  config?: Record<string, unknown>;
}): ToolResult {
  const session = getSession(args.sessionId);
  if (!session) return err(`Session not found: ${args.sessionId}`);

  switch (args.action) {
    case "subscribe": {
      if (!args.workerType) return err("workerType required for subscribe");
      if (!args.triggerEvent) return err("triggerEvent required for subscribe");

      const validTypes = ["audit", "optimize", "testgaps", "document"];
      if (!validTypes.includes(args.workerType)) {
        return err(
          `Invalid workerType: "${args.workerType}". Valid: ${validTypes.join(", ")}`,
        );
      }
      const validTriggers = ["gate_pass", "gate_fail", "session_end", "manual"];
      if (!validTriggers.includes(args.triggerEvent)) {
        return err(
          `Invalid triggerEvent: "${args.triggerEvent}". Valid: ${validTriggers.join(", ")}`,
        );
      }

      const record = workerRegistry.subscribe(
        session.id,
        args.workerType as any,
        args.triggerEvent as any,
        args.config,
      );
      return ok({
        workerId: record.id,
        workerType: record.workerType,
        triggerEvent: record.triggerEvent,
        description: WORKER_TYPE_DESCRIPTIONS[record.workerType],
        triggerDescription: TRIGGER_DESCRIPTIONS[record.triggerEvent],
        nextAction: `Worker "${record.id}" subscribed to "${record.triggerEvent}" events.`,
      });
    }

    case "list": {
      const subs = workerRegistry.getSubscriptions(session.id);
      return ok({
        totalSubscriptions: subs.length,
        subscriptions: subs.map((w) => ({
          id: w.id,
          workerType: w.workerType,
          triggerEvent: w.triggerEvent,
          status: w.status,
          description: WORKER_TYPE_DESCRIPTIONS[w.workerType],
        })),
        availableTypes: Object.entries(WORKER_TYPE_DESCRIPTIONS).map(
          ([k, v]) => ({ type: k, description: v }),
        ),
        availableTriggers: Object.entries(TRIGGER_DESCRIPTIONS).map(
          ([k, v]) => ({ event: k, description: v }),
        ),
      });
    }

    case "check": {
      if (!args.triggerEvent) return err("triggerEvent required for check");
      const ready = workerRegistry.checkTriggers(
        session.id,
        args.triggerEvent as any,
      );
      return ok({
        readyWorkers: ready.length,
        workers: ready.map((w) => ({
          id: w.id,
          workerType: w.workerType,
          description: WORKER_TYPE_DESCRIPTIONS[w.workerType],
        })),
      });
    }

    default:
      return err(`Unknown watch action: ${args.action}`);
  }
}

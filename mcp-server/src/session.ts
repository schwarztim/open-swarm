// ── Session Store ──────────────────────────────────────────────────────
// Session lifecycle management for swarm sessions.

import { randomUUID } from "crypto";
import type { Tier, ExecutionMode, SwarmSession, PhaseState } from "./swarm-types.js";
import type { RatePreset } from "./model-registry.js";
import { TIER_PHASES } from "./phase-engine.js";
import { resolveRateLimit } from "./rate-limiter.js";
import { appendEvent, SwarmEventType } from "./event-store.js";

export const sessions = new Map<string, SwarmSession>();

function generateId(): string {
  return `swarm-${randomUUID()}`;
}

export function createSession(
  tier: Tier,
  task: string,
  executionMode: ExecutionMode = "task",
  concurrency?: number | RatePreset,
): SwarmSession {
  const id = generateId();
  const phaseDefs = TIER_PHASES[tier];
  const phases: PhaseState[] = phaseDefs.map((p) => ({
    name: p.name,
    status: "pending",
    agentIds: [],
    outputs: [],
  }));

  const session: SwarmSession = {
    id,
    tier,
    task,
    phases,
    currentPhaseIndex: 0,
    workstreams: [],
    agentGroups: [],
    history: [],
    rounds: [],
    board: [],
    debates: [],
    claims: [],
    patterns: [],
    consensuses: [],
    patternIdsUsed: [],
    promptStore: new Map(),
    validationResults: [],
    maxLoops: 3,
    concurrency: resolveRateLimit(concurrency),
    createdAt: new Date(),
    executionMode,
    outputDir: `/tmp/swarm-${id}`,
  };

  sessions.set(session.id, session);
  try {
    appendEvent(session.id, SwarmEventType.SESSION_CREATED, { tier, task, executionMode });
  } catch { /* event store is best-effort */ }
  return session;
}

export function getSession(id: string): SwarmSession | undefined {
  return sessions.get(id);
}

export function getAllSessions(): SwarmSession[] {
  return Array.from(sessions.values());
}

export function destroySession(id: string): boolean {
  try {
    appendEvent(id, SwarmEventType.SESSION_DESTROYED, { sessionId: id });
  } catch { /* event store is best-effort */ }
  return sessions.delete(id);
}

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function cleanupStaleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt.getTime() > SESSION_MAX_AGE_MS) {
      sessions.delete(id);
    }
  }
}

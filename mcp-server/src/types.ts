/**
 * New types for persistent memory, learning loop, and background workers.
 * Base types (PatternEntry, SwarmSession, etc.) remain in state.ts.
 */

import type { PatternEntry } from "./state.js";

// ── Extended Pattern (V2) ─────────────────────────────────────────────

/** Extended pattern with learning metadata. */
export interface PatternEntryV2 extends PatternEntry {
  confidence: number; // 0-1, decays with age, boosted by reuse
  useCount: number;
  lastUsedAt: number | null;
  expiresAt: number | null; // TTL: null = permanent
  embedding: Buffer | null; // Float32Array as Buffer (384 * 4 bytes)
}

// ── Outcome Tracking ──────────────────────────────────────────────────

export interface Outcome {
  id: string;
  sessionId: string;
  taskDescription: string;
  tier: string;
  modelUsed: string | null;
  qualityScore: number | null;
  criticalIssues: number;
  durationMs: number | null;
  patternIdsUsed: string[];
  whatWorked: string[];
  whatFailed: string[];
  createdAt: number;
}

// ── Worker Records ────────────────────────────────────────────────────

export type BackgroundWorkerType =
  | "audit"
  | "optimize"
  | "testgaps"
  | "document";
export type WorkerTriggerEvent =
  | "gate_pass"
  | "gate_fail"
  | "session_end"
  | "manual";

export interface WorkerRecord {
  id: string;
  sessionId: string;
  workerType: BackgroundWorkerType;
  triggerEvent: WorkerTriggerEvent;
  status: "pending" | "dispatched" | "completed" | "failed";
  config: Record<string, unknown> | null;
  findings: string[];
  createdAt: number;
  completedAt: number | null;
}

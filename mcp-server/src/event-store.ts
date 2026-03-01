// ── Event Store ────────────────────────────────────────────────────────
// Immutable append-only event log for all swarm state mutations.
// Uses its own SQLite database (data/events.db), separate from swarm.db.

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Event Types ────────────────────────────────────────────────────────

export enum SwarmEventType {
  SESSION_CREATED = "session.created",
  SESSION_DESTROYED = "session.destroyed",
  PHASE_ADVANCED = "phase.advanced",
  WORKSTREAM_STATUS_CHANGED = "workstream.status_changed",
  WORKSTREAM_OUTPUT_SUBMITTED = "workstream.output_submitted",
  SCORE_SUBMITTED = "gate.score_submitted",
  GATE_PASSED = "gate.passed",
  GATE_FAILED = "gate.failed",
  MERGE_COMPLETED = "merge.completed",
  DEBATE_STARTED = "debate.started",
  DEBATE_CONTRIBUTION = "debate.contribution",
  DEBATE_RESOLVED = "debate.resolved",
  RELAY_MESSAGE = "relay.message",
  THROTTLE_CHANGED = "throttle.changed",
  CLAIM_ACQUIRED = "claim.acquired",
  CLAIM_RELEASED = "claim.released",
  ERROR_OCCURRED = "error.occurred",
}

// ── Types ──────────────────────────────────────────────────────────────

export interface SwarmEvent {
  id: number;
  timestamp: string;
  sessionId: string;
  eventType: SwarmEventType;
  payload: Record<string, unknown>;
  sequence: number;
}

export interface SessionReplayState {
  sessionId: string;
  phases: Array<{ name: string; enteredAt: string }>;
  workstreams: Map<string, { status?: string; score?: number; outputCount: number }>;
  scores: Array<{ workstream: string; score: number; timestamp: string }>;
  gatePassed: boolean | null;
  gateFailedCount: number;
  debates: Array<{ debateId: string; startedAt: string; resolvedAt?: string }>;
  mergeCount: number;
  eventCount: number;
}

// ── Internal state ─────────────────────────────────────────────────────

let db: Database.Database | null = null;

// ── Schema ─────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS swarm_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT    NOT NULL DEFAULT (datetime('now')),
    session_id TEXT   NOT NULL,
    event_type TEXT   NOT NULL,
    payload   TEXT    NOT NULL,
    sequence  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON swarm_events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_type    ON swarm_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_events_seq     ON swarm_events(session_id, sequence);
`;

// ── Init ───────────────────────────────────────────────────────────────

export function initEventStore(dbPath?: string): void {
  if (db) return; // already initialized

  const resolvedPath = dbPath ?? join(__dirname, "..", "data", "events.db");
  mkdirSync(dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA);
}

function getDb(): Database.Database {
  if (!db) initEventStore();
  return db!;
}

// ── Sequence helper ────────────────────────────────────────────────────

function nextSequence(sessionId: string): number {
  const row = getDb()
    .prepare("SELECT MAX(sequence) AS maxSeq FROM swarm_events WHERE session_id = ?")
    .get(sessionId) as { maxSeq: number | null };
  return (row.maxSeq ?? 0) + 1;
}

// ── Core API ───────────────────────────────────────────────────────────

export function appendEvent(
  sessionId: string,
  eventType: SwarmEventType,
  payload: Record<string, unknown>,
): number {
  const seq = nextSequence(sessionId);
  const result = getDb()
    .prepare(
      "INSERT INTO swarm_events (session_id, event_type, payload, sequence) VALUES (?, ?, ?, ?)",
    )
    .run(sessionId, eventType, JSON.stringify(payload), seq);
  return result.lastInsertRowid as number;
}

export function getEvents(
  sessionId: string,
  options?: {
    eventType?: SwarmEventType;
    after?: number;
    limit?: number;
  },
): SwarmEvent[] {
  const conditions: string[] = ["session_id = ?"];
  const params: unknown[] = [sessionId];

  if (options?.eventType) {
    conditions.push("event_type = ?");
    params.push(options.eventType);
  }
  if (options?.after !== undefined) {
    conditions.push("sequence > ?");
    params.push(options.after);
  }

  const limitClause = options?.limit ? `LIMIT ${Math.max(1, options.limit)}` : "";
  const sql = `SELECT * FROM swarm_events WHERE ${conditions.join(" AND ")} ORDER BY sequence ASC ${limitClause}`;

  const rows = getDb().prepare(sql).all(...params) as Array<{
    id: number;
    timestamp: string;
    session_id: string;
    event_type: string;
    payload: string;
    sequence: number;
  }>;

  return rows.map(rowToEvent);
}

export function getSessionTimeline(sessionId: string): SwarmEvent[] {
  return getEvents(sessionId);
}

export function replaySession(sessionId: string): SessionReplayState {
  const events = getSessionTimeline(sessionId);

  const state: SessionReplayState = {
    sessionId,
    phases: [],
    workstreams: new Map(),
    scores: [],
    gatePassed: null,
    gateFailedCount: 0,
    debates: new Map() as unknown as SessionReplayState["debates"],
    mergeCount: 0,
    eventCount: events.length,
  };

  const debateMap = new Map<string, { debateId: string; startedAt: string; resolvedAt?: string }>();

  for (const ev of events) {
    switch (ev.eventType) {
      case SwarmEventType.PHASE_ADVANCED: {
        const { newPhase } = ev.payload as { newPhase?: string };
        if (newPhase) state.phases.push({ name: newPhase, enteredAt: ev.timestamp });
        break;
      }
      case SwarmEventType.WORKSTREAM_STATUS_CHANGED: {
        const { workstreamId, status } = ev.payload as { workstreamId?: string; status?: string };
        if (workstreamId) {
          const ws = state.workstreams.get(workstreamId) ?? { outputCount: 0 };
          ws.status = status;
          state.workstreams.set(workstreamId, ws);
        }
        break;
      }
      case SwarmEventType.WORKSTREAM_OUTPUT_SUBMITTED: {
        const { workstreamId } = ev.payload as { workstreamId?: string };
        if (workstreamId) {
          const ws = state.workstreams.get(workstreamId) ?? { outputCount: 0 };
          ws.outputCount += 1;
          state.workstreams.set(workstreamId, ws);
        }
        break;
      }
      case SwarmEventType.SCORE_SUBMITTED: {
        const { workstream, score } = ev.payload as { workstream?: string; score?: number };
        if (workstream && score !== undefined) {
          state.scores.push({ workstream, score, timestamp: ev.timestamp });
          const ws = state.workstreams.get(workstream) ?? { outputCount: 0 };
          ws.score = score;
          state.workstreams.set(workstream, ws);
        }
        break;
      }
      case SwarmEventType.GATE_PASSED:
        state.gatePassed = true;
        break;
      case SwarmEventType.GATE_FAILED:
        state.gateFailedCount += 1;
        state.gatePassed = false;
        break;
      case SwarmEventType.MERGE_COMPLETED:
        state.mergeCount += 1;
        break;
      case SwarmEventType.DEBATE_STARTED: {
        const { debateId } = ev.payload as { debateId?: string };
        if (debateId) debateMap.set(debateId, { debateId, startedAt: ev.timestamp });
        break;
      }
      case SwarmEventType.DEBATE_RESOLVED: {
        const { debateId } = ev.payload as { debateId?: string };
        if (debateId) {
          const d = debateMap.get(debateId);
          if (d) d.resolvedAt = ev.timestamp;
        }
        break;
      }
    }
  }

  state.debates = Array.from(debateMap.values());
  return state;
}

export function pruneEvents(maxAgeDays: number): number {
  const result = getDb()
    .prepare(
      "DELETE FROM swarm_events WHERE timestamp < datetime('now', ? || ' days')",
    )
    .run(`-${maxAgeDays}`);
  return result.changes;
}

export function getEventCount(sessionId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS cnt FROM swarm_events WHERE session_id = ?")
    .get(sessionId) as { cnt: number };
  return row.cnt;
}

// ── Internal helper ────────────────────────────────────────────────────

function rowToEvent(row: {
  id: number;
  timestamp: string;
  session_id: string;
  event_type: string;
  payload: string;
  sequence: number;
}): SwarmEvent {
  return {
    id: row.id,
    timestamp: row.timestamp,
    sessionId: row.session_id,
    eventType: row.event_type as SwarmEventType,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    sequence: row.sequence,
  };
}

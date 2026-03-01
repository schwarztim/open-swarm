/**
 * Persistent memory layer using better-sqlite3 + vector search.
 * Replaces inline pattern code from state.ts and dead persistence.ts.
 * Single file: data/swarm.db
 */

import { mkdirSync, existsSync, readFileSync, renameSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PatternEntry } from "./state.js";
import type {
  PatternEntryV2,
  Outcome,
  WorkerRecord,
  BackgroundWorkerType,
  WorkerTriggerEvent,
} from "./types.js";
import { embed, patternToText, cosineSimilarity } from "./embeddings.js";
import { getVectorStore } from "./vector-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "swarm.db");
const OLD_PATTERNS_JSON = join(DATA_DIR, "patterns.json");

let db: any = null;
let patternCounter = 0;
let outcomeCounter = 0;
let workerCounter = 0;
let initialized = false;

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS patterns (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  approach TEXT NOT NULL,
  files_involved TEXT NOT NULL,
  quality_score REAL NOT NULL,
  key_decisions TEXT NOT NULL,
  tags TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  use_count INTEGER DEFAULT 0,
  last_used_at INTEGER,
  embedding BLOB,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  session_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outcomes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task_description TEXT NOT NULL,
  tier TEXT NOT NULL,
  model_used TEXT,
  quality_score REAL,
  critical_issues INTEGER DEFAULT 0,
  duration_ms INTEGER,
  pattern_ids_used TEXT,
  what_worked TEXT,
  what_failed TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  worker_type TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  config TEXT,
  findings TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_patterns_session ON patterns(session_id);
CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence);
CREATE INDEX IF NOT EXISTS idx_patterns_task_type ON patterns(task_type);
CREATE INDEX IF NOT EXISTS idx_outcomes_session ON outcomes(session_id);
CREATE INDEX IF NOT EXISTS idx_outcomes_task_type ON outcomes(task_type);
`;

// ── Init ──────────────────────────────────────────────────────────────

async function openDb(): Promise<any> {
  mkdirSync(DATA_DIR, { recursive: true });

  // Try better-sqlite3 first
  try {
    const Database = (await import("better-sqlite3" as any)).default;
    return new Database(DB_PATH);
  } catch {
    // Fall through
  }

  // Try node:sqlite (Node 22.5+)
  try {
    const sqliteModule = await import("node:sqlite" as any);
    if (sqliteModule?.DatabaseSync) {
      return new sqliteModule.DatabaseSync(DB_PATH);
    }
  } catch {
    // Fall through
  }

  // In-memory fallback using a simple Map-based store
  console.error("[memory] No SQLite available — using in-memory fallback");
  return null;
}

// In-memory fallback stores
const memPatterns = new Map<string, PatternEntryV2>();
const memOutcomes = new Map<string, Outcome>();
const memWorkers = new Map<string, WorkerRecord>();

function rowToPattern(row: any): PatternEntryV2 {
  return {
    id: row.id,
    taskType: row.task_type,
    approach: row.approach,
    filesInvolved: JSON.parse(row.files_involved),
    qualityScore: row.quality_score,
    keyDecisions: JSON.parse(row.key_decisions),
    tags: JSON.parse(row.tags),
    confidence: row.confidence ?? 1.0,
    useCount: row.use_count ?? 0,
    lastUsedAt: row.last_used_at ?? null,
    embedding: row.embedding ?? null,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    sessionId: row.session_id,
  };
}

function rowToOutcome(row: any): Outcome {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskDescription: row.task_description,
    tier: row.tier,
    modelUsed: row.model_used,
    qualityScore: row.quality_score,
    criticalIssues: row.critical_issues,
    durationMs: row.duration_ms,
    patternIdsUsed: JSON.parse(row.pattern_ids_used ?? "[]"),
    whatWorked: JSON.parse(row.what_worked ?? "[]"),
    whatFailed: JSON.parse(row.what_failed ?? "[]"),
    createdAt: row.created_at,
  };
}

function rowToWorker(row: any): WorkerRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workerType: row.worker_type as BackgroundWorkerType,
    triggerEvent: row.trigger_event as WorkerTriggerEvent,
    status: row.status,
    config: row.config ? JSON.parse(row.config) : null,
    findings: JSON.parse(row.findings ?? "[]"),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

// ── MemoryStore Singleton ─────────────────────────────────────────────

export const memoryStore = {
  async init(): Promise<void> {
    if (initialized) return;

    db = await openDb();
    if (db) {
      try {
        db.exec(SCHEMA);
      } catch (e: any) {
        // Some drivers use exec differently
        const stmts = SCHEMA.split(";").filter((s) => s.trim());
        for (const s of stmts) {
          try {
            db.exec(s + ";");
          } catch {
            // Ignore individual statement failures (table already exists)
          }
        }
      }

      // Restore counters
      try {
        const maxP = db
          .prepare(
            "SELECT MAX(CAST(REPLACE(id, 'pattern-', '') AS INTEGER)) as m FROM patterns",
          )
          .get();
        if (maxP?.m) patternCounter = maxP.m;
      } catch {
        /* empty table */
      }
      try {
        const maxO = db
          .prepare(
            "SELECT MAX(CAST(REPLACE(id, 'outcome-', '') AS INTEGER)) as m FROM outcomes",
          )
          .get();
        if (maxO?.m) outcomeCounter = maxO.m;
      } catch {
        /* empty table */
      }
      try {
        const maxW = db
          .prepare(
            "SELECT MAX(CAST(REPLACE(id, 'worker-', '') AS INTEGER)) as m FROM workers",
          )
          .get();
        if (maxW?.m) workerCounter = maxW.m;
      } catch {
        /* empty table */
      }

      // Rebuild vector index from DB embeddings
      await rebuildVectorIndex();
    }

    // Migrate old patterns.json if present
    await migrateFromJsonFile();

    initialized = true;
    console.error(`[memory] Initialized. DB: ${db ? DB_PATH : "in-memory"}`);
  },

  // ── Pattern Operations ────────────────────────────────────────────

  async storePattern(
    entry: Omit<PatternEntryV2, "id" | "embedding">,
  ): Promise<PatternEntryV2> {
    const id = `pattern-${++patternCounter}`;
    const text = patternToText(entry);
    const vector = await embed(text);
    const embeddingBuf = Buffer.from(vector.buffer);

    const full: PatternEntryV2 = { ...entry, id, embedding: embeddingBuf };

    if (db) {
      db.prepare(
        `
        INSERT OR REPLACE INTO patterns
        (id, task_type, approach, files_involved, quality_score, key_decisions, tags,
         confidence, use_count, last_used_at, embedding, created_at, expires_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        entry.taskType,
        entry.approach,
        JSON.stringify(entry.filesInvolved),
        entry.qualityScore,
        JSON.stringify(entry.keyDecisions),
        JSON.stringify(entry.tags),
        entry.confidence ?? 1.0,
        entry.useCount ?? 0,
        entry.lastUsedAt ?? null,
        embeddingBuf,
        entry.createdAt,
        entry.expiresAt ?? null,
        entry.sessionId,
      );
    } else {
      memPatterns.set(id, full);
    }

    // Add to vector index
    getVectorStore().add(id, vector);

    return full;
  },

  async searchSemantic(
    query: string,
    limit: number = 5,
  ): Promise<Array<PatternEntryV2 & { relevance: number }>> {
    const queryVector = await embed(query);
    const vs = getVectorStore();
    const results = vs.search(queryVector, limit);

    const patterns: Array<PatternEntryV2 & { relevance: number }> = [];
    for (const r of results) {
      const p = await this.getPattern(r.id);
      if (p) {
        patterns.push({
          ...p,
          relevance: Math.round((1 - r.distance) * 100) / 100,
        });
      }
    }

    return patterns;
  },

  searchByTags(tags: string[]): PatternEntryV2[] {
    if (db) {
      const conditions = tags.map(() => "tags LIKE ?");
      const params = tags.map((t) => `%${t}%`);
      const rows = db
        .prepare(
          `SELECT * FROM patterns WHERE ${conditions.join(" OR ")} ORDER BY quality_score DESC`,
        )
        .all(...params);
      return (rows as any[]).map(rowToPattern);
    }
    return [...memPatterns.values()].filter((p) =>
      tags.some((t) => p.tags.includes(t)),
    );
  },

  async getPattern(id: string): Promise<PatternEntryV2 | null> {
    if (db) {
      const row = db.prepare("SELECT * FROM patterns WHERE id = ?").get(id);
      return row ? rowToPattern(row) : null;
    }
    return memPatterns.get(id) ?? null;
  },

  recordUsage(patternId: string): void {
    const now = Date.now();
    if (db) {
      db.prepare(
        `
        UPDATE patterns SET use_count = use_count + 1, last_used_at = ?,
        confidence = MIN(1.0, confidence + 0.05)
        WHERE id = ?
      `,
      ).run(now, patternId);
    } else {
      const p = memPatterns.get(patternId);
      if (p) {
        p.useCount++;
        p.lastUsedAt = now;
        p.confidence = Math.min(1.0, p.confidence + 0.05);
      }
    }
  },

  decayConfidence(ageDays: number = 30): number {
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    if (db) {
      const info = db
        .prepare(
          `
        UPDATE patterns SET confidence = MAX(0, confidence - 0.1)
        WHERE (last_used_at IS NULL OR last_used_at < ?) AND confidence > 0
      `,
        )
        .run(cutoff);
      return info.changes ?? 0;
    }
    let count = 0;
    for (const p of memPatterns.values()) {
      if (
        (p.lastUsedAt === null || p.lastUsedAt < cutoff) &&
        p.confidence > 0
      ) {
        p.confidence = Math.max(0, p.confidence - 0.1);
        count++;
      }
    }
    return count;
  },

  cleanExpired(): number {
    const now = Date.now();
    if (db) {
      // Collect expired IDs before deleting so we can remove from vector store
      const expiredRows = db
        .prepare(
          "SELECT id FROM patterns WHERE expires_at IS NOT NULL AND expires_at < ?",
        )
        .all(now) as Array<{ id: string }>;

      const info = db
        .prepare(
          "DELETE FROM patterns WHERE expires_at IS NOT NULL AND expires_at < ?",
        )
        .run(now);

      // Remove orphaned vectors and compact
      const vs = getVectorStore();
      for (const row of expiredRows) {
        vs.remove(row.id);
      }
      if (expiredRows.length > 0) {
        vs.compact();
      }

      return info.changes ?? 0;
    }
    let count = 0;
    for (const [id, p] of memPatterns) {
      if (p.expiresAt !== null && p.expiresAt < now) {
        memPatterns.delete(id);
        getVectorStore().remove(id);
        count++;
      }
    }
    if (count > 0) {
      getVectorStore().compact();
    }
    return count;
  },

  async findSimilar(
    patternId: string,
    threshold: number = 0.9,
  ): Promise<Array<{ id: string; similarity: number }>> {
    const pattern = await this.getPattern(patternId);
    if (!pattern) return [];

    const text = patternToText(pattern);
    const vector = await embed(text);
    const vs = getVectorStore();
    const results = vs.search(vector, 10);

    return results
      .filter((r) => r.id !== patternId && 1 - r.distance >= threshold)
      .map((r) => ({
        id: r.id,
        similarity: Math.round((1 - r.distance) * 100) / 100,
      }));
  },

  async mergePatterns(ids: string[]): Promise<PatternEntryV2 | null> {
    if (ids.length < 2) return null;

    const patterns = (
      await Promise.all(ids.map((id) => this.getPattern(id)))
    ).filter((p): p is PatternEntryV2 => p !== null);

    if (patterns.length < 2) return null;

    // Keep highest quality, merge tags/decisions
    patterns.sort((a, b) => b.qualityScore - a.qualityScore);
    const best = patterns[0];

    const allTags = new Set(patterns.flatMap((p) => p.tags));
    const allDecisions = new Set(patterns.flatMap((p) => p.keyDecisions));

    // Update the best with merged data
    if (db) {
      db.prepare(
        `
        UPDATE patterns SET tags = ?, key_decisions = ?, use_count = ?,
        confidence = MIN(1.0, confidence + 0.1)
        WHERE id = ?
      `,
      ).run(
        JSON.stringify([...allTags]),
        JSON.stringify([...allDecisions]),
        patterns.reduce((sum, p) => sum + p.useCount, 0),
        best.id,
      );

      // Delete the others
      for (const p of patterns.slice(1)) {
        db.prepare("DELETE FROM patterns WHERE id = ?").run(p.id);
        getVectorStore().remove(p.id);
      }
    } else {
      best.tags = [...allTags];
      best.keyDecisions = [...allDecisions];
      best.useCount = patterns.reduce((sum, p) => sum + p.useCount, 0);
      best.confidence = Math.min(1.0, best.confidence + 0.1);
      for (const p of patterns.slice(1)) {
        memPatterns.delete(p.id);
        getVectorStore().remove(p.id);
      }
    }

    return best;
  },

  prunePatterns(minConfidence: number = 0.1): number {
    if (db) {
      const info = db
        .prepare("DELETE FROM patterns WHERE confidence < ?")
        .run(minConfidence);
      return info.changes ?? 0;
    }
    let count = 0;
    for (const [id, p] of memPatterns) {
      if (p.confidence < minConfidence) {
        memPatterns.delete(id);
        getVectorStore().remove(id);
        count++;
      }
    }
    return count;
  },

  getAllPatterns(): PatternEntryV2[] {
    if (db) {
      const rows = db
        .prepare("SELECT * FROM patterns ORDER BY quality_score DESC")
        .all();
      return (rows as any[]).map(rowToPattern);
    }
    return [...memPatterns.values()];
  },

  getPatternCount(): number {
    if (db) {
      const row = db.prepare("SELECT COUNT(*) as c FROM patterns").get() as any;
      return row?.c ?? 0;
    }
    return memPatterns.size;
  },

  getAverageConfidence(): number {
    if (db) {
      const row = db
        .prepare("SELECT AVG(confidence) as avg FROM patterns")
        .get() as any;
      return Math.round((row?.avg ?? 0) * 100) / 100;
    }
    if (memPatterns.size === 0) return 0;
    let sum = 0;
    for (const p of memPatterns.values()) sum += p.confidence;
    return Math.round((sum / memPatterns.size) * 100) / 100;
  },

  // ── Outcome Operations ────────────────────────────────────────────

  storeOutcome(outcome: Omit<Outcome, "id">): Outcome {
    const id = `outcome-${++outcomeCounter}`;
    const full: Outcome = { ...outcome, id };

    if (db) {
      db.prepare(
        `
        INSERT INTO outcomes
        (id, session_id, task_description, tier, model_used, quality_score,
         critical_issues, duration_ms, pattern_ids_used, what_worked, what_failed, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        outcome.sessionId,
        outcome.taskDescription,
        outcome.tier,
        outcome.modelUsed,
        outcome.qualityScore,
        outcome.criticalIssues,
        outcome.durationMs,
        JSON.stringify(outcome.patternIdsUsed),
        JSON.stringify(outcome.whatWorked),
        JSON.stringify(outcome.whatFailed),
        outcome.createdAt,
      );
    } else {
      memOutcomes.set(id, full);
    }

    return full;
  },

  getOutcomes(sessionId: string): Outcome[] {
    if (db) {
      const rows = db
        .prepare(
          "SELECT * FROM outcomes WHERE session_id = ? ORDER BY created_at DESC",
        )
        .all(sessionId);
      return (rows as any[]).map(rowToOutcome);
    }
    return [...memOutcomes.values()].filter((o) => o.sessionId === sessionId);
  },

  getRecentOutcomes(limit: number = 20): Outcome[] {
    if (db) {
      const rows = db
        .prepare("SELECT * FROM outcomes ORDER BY created_at DESC LIMIT ?")
        .all(limit);
      return (rows as any[]).map(rowToOutcome);
    }
    return [...memOutcomes.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },

  // ── Worker Operations ─────────────────────────────────────────────

  storeWorker(worker: Omit<WorkerRecord, "id">): WorkerRecord {
    const id = `worker-${++workerCounter}`;
    const full: WorkerRecord = { ...worker, id };

    if (db) {
      db.prepare(
        `
        INSERT INTO workers
        (id, session_id, worker_type, trigger_event, status, config, findings, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        id,
        worker.sessionId,
        worker.workerType,
        worker.triggerEvent,
        worker.status,
        worker.config ? JSON.stringify(worker.config) : null,
        JSON.stringify(worker.findings),
        worker.createdAt,
        worker.completedAt,
      );
    } else {
      memWorkers.set(id, full);
    }

    return full;
  },

  getWorker(id: string): WorkerRecord | null {
    if (db) {
      const row = db.prepare("SELECT * FROM workers WHERE id = ?").get(id);
      return row ? rowToWorker(row) : null;
    }
    return memWorkers.get(id) ?? null;
  },

  updateWorker(
    id: string,
    updates: Partial<Pick<WorkerRecord, "status" | "findings" | "completedAt">>,
  ): void {
    if (db) {
      const sets: string[] = [];
      const params: any[] = [];
      if (updates.status !== undefined) {
        sets.push("status = ?");
        params.push(updates.status);
      }
      if (updates.findings !== undefined) {
        sets.push("findings = ?");
        params.push(JSON.stringify(updates.findings));
      }
      if (updates.completedAt !== undefined) {
        sets.push("completed_at = ?");
        params.push(updates.completedAt);
      }
      if (sets.length > 0) {
        params.push(id);
        db.prepare(`UPDATE workers SET ${sets.join(", ")} WHERE id = ?`).run(
          ...params,
        );
      }
    } else {
      const w = memWorkers.get(id);
      if (w) Object.assign(w, updates);
    }
  },

  getWorkersForSession(sessionId: string): WorkerRecord[] {
    if (db) {
      const rows = db
        .prepare(
          "SELECT * FROM workers WHERE session_id = ? ORDER BY created_at DESC",
        )
        .all(sessionId);
      return (rows as any[]).map(rowToWorker);
    }
    return [...memWorkers.values()].filter((w) => w.sessionId === sessionId);
  },

  /**
   * Delete outcomes and workers older than maxAgeDays.
   * Returns the total count of deleted rows.
   */
  cleanupOldData(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    if (db) {
      const outInfo = db
        .prepare("DELETE FROM outcomes WHERE created_at < ?")
        .run(cutoff);
      const workerInfo = db
        .prepare("DELETE FROM workers WHERE created_at < ?")
        .run(cutoff);
      return (outInfo.changes ?? 0) + (workerInfo.changes ?? 0);
    }
    let count = 0;
    for (const [id, o] of memOutcomes) {
      if (o.createdAt < cutoff) {
        memOutcomes.delete(id);
        count++;
      }
    }
    for (const [id, w] of memWorkers) {
      if (w.createdAt < cutoff) {
        memWorkers.delete(id);
        count++;
      }
    }
    return count;
  },
};

// ── Internal Helpers ──────────────────────────────────────────────────

async function rebuildVectorIndex(): Promise<void> {
  if (!db) return;

  const rows = db
    .prepare("SELECT id, embedding FROM patterns WHERE embedding IS NOT NULL")
    .all() as any[];

  const vs = getVectorStore();
  vs.clear();

  for (const row of rows) {
    if (row.embedding) {
      const vector = new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      );
      vs.add(row.id, vector);
    }
  }

  console.error(`[memory] Rebuilt vector index: ${vs.size} vectors`);
}

async function migrateFromJsonFile(): Promise<void> {
  if (!existsSync(OLD_PATTERNS_JSON)) return;

  try {
    const raw = readFileSync(OLD_PATTERNS_JSON, "utf-8");
    const patterns = JSON.parse(raw) as PatternEntry[];

    if (patterns.length === 0) return;

    console.error(
      `[memory] Migrating ${patterns.length} patterns from JSON...`,
    );

    for (const p of patterns) {
      await memoryStore.storePattern({
        taskType: p.taskType,
        approach: p.approach,
        filesInvolved: p.filesInvolved,
        qualityScore: p.qualityScore,
        keyDecisions: p.keyDecisions,
        tags: p.tags,
        confidence: 1.0,
        useCount: 0,
        lastUsedAt: null,
        expiresAt: null,
        createdAt: p.createdAt,
        sessionId: p.sessionId,
      });
    }

    // Rename to .migrated
    renameSync(OLD_PATTERNS_JSON, OLD_PATTERNS_JSON + ".migrated");
    console.error(
      `[memory] Migration complete. ${patterns.length} patterns imported.`,
    );
  } catch (e) {
    console.error(`[memory] Migration failed:`, e);
  }
}

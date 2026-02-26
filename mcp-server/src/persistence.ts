/**
 * Persistent pattern memory using SQLite (via better-sqlite3-compatible approach).
 * Falls back to JSON file persistence when SQLite is unavailable.
 *
 * Stores patterns in mcp-server/data/patterns.db (SQLite) or
 * mcp-server/data/patterns.json (fallback).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { PatternEntry } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, "..", "data");
const PATTERNS_JSON = join(DATA_DIR, "patterns.json");
const PATTERNS_DB = join(DATA_DIR, "patterns.db");

// ── PatternStore Interface ────────────────────────────────────────────

export interface PatternStore {
  load(): PatternEntry[];
  save(patterns: PatternEntry[]): void;
  append(pattern: PatternEntry): void;
  search(query: string, limit?: number): PatternEntry[];
  getHighestId(): number;
  readonly backend: "sqlite" | "json";
}

// ── JSON-based PatternStore (default, zero-dependency) ────────────────

class JsonPatternStore implements PatternStore {
  readonly backend = "json" as const;
  private patterns: PatternEntry[] = [];

  load(): PatternEntry[] {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      if (existsSync(PATTERNS_JSON)) {
        const raw = readFileSync(PATTERNS_JSON, "utf-8");
        this.patterns = JSON.parse(raw) as PatternEntry[];
      }
    } catch {
      this.patterns = [];
    }
    return [...this.patterns];
  }

  save(patterns: PatternEntry[]): void {
    this.patterns = patterns;
    this.flush();
  }

  append(pattern: PatternEntry): void {
    this.patterns.push(pattern);
    this.flush();
  }

  search(query: string, limit: number = 5): PatternEntry[] {
    const queryTokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const scored = this.patterns.map((p) => {
      const searchable = [p.taskType, p.approach, ...p.tags, ...p.keyDecisions]
        .join(" ")
        .toLowerCase();
      let score = 0;
      for (const token of queryTokens) {
        if (searchable.includes(token)) score++;
      }
      return { pattern: p, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score || b.pattern.qualityScore - a.pattern.qualityScore,
      )
      .slice(0, limit)
      .map((s) => s.pattern);
  }

  getHighestId(): number {
    let max = 0;
    for (const p of this.patterns) {
      const match = p.id.match(/pattern-(\d+)/);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max;
  }

  private flush(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(
        PATTERNS_JSON,
        JSON.stringify(this.patterns, null, 2),
        "utf-8",
      );
    } catch {
      // Silent fail — disk persistence is best-effort
    }
  }
}

// ── SQLite-based PatternStore ─────────────────────────────────────────
// Uses Node.js built-in node:sqlite (available since Node 22.5+).
// Falls back to JSON if unavailable.

class SqlitePatternStore implements PatternStore {
  readonly backend = "sqlite" as const;
  private db: any; // Database instance

  constructor(db: any) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        taskType TEXT NOT NULL,
        approach TEXT NOT NULL,
        filesInvolved TEXT NOT NULL,
        qualityScore REAL NOT NULL,
        keyDecisions TEXT NOT NULL,
        tags TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        sessionId TEXT NOT NULL
      )
    `);
  }

  load(): PatternEntry[] {
    const stmt = this.db.prepare(
      "SELECT * FROM patterns ORDER BY createdAt DESC",
    );
    const rows = stmt.all() as any[];
    return rows.map((row: any) => ({
      id: row.id,
      taskType: row.taskType,
      approach: row.approach,
      filesInvolved: JSON.parse(row.filesInvolved),
      qualityScore: row.qualityScore,
      keyDecisions: JSON.parse(row.keyDecisions),
      tags: JSON.parse(row.tags),
      createdAt: row.createdAt,
      sessionId: row.sessionId,
    }));
  }

  save(patterns: PatternEntry[]): void {
    this.db.exec("DELETE FROM patterns");
    const stmt = this.db.prepare(
      `INSERT INTO patterns (id, taskType, approach, filesInvolved, qualityScore, keyDecisions, tags, createdAt, sessionId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of patterns) {
      stmt.run(
        p.id,
        p.taskType,
        p.approach,
        JSON.stringify(p.filesInvolved),
        p.qualityScore,
        JSON.stringify(p.keyDecisions),
        JSON.stringify(p.tags),
        p.createdAt,
        p.sessionId,
      );
    }
  }

  append(pattern: PatternEntry): void {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO patterns (id, taskType, approach, filesInvolved, qualityScore, keyDecisions, tags, createdAt, sessionId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      pattern.id,
      pattern.taskType,
      pattern.approach,
      JSON.stringify(pattern.filesInvolved),
      pattern.qualityScore,
      JSON.stringify(pattern.keyDecisions),
      JSON.stringify(pattern.tags),
      pattern.createdAt,
      pattern.sessionId,
    );
  }

  search(query: string, limit: number = 5): PatternEntry[] {
    // SQLite FTS would be ideal, but for simplicity use LIKE matching
    const queryTokens = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    if (queryTokens.length === 0) return [];

    // Build WHERE clause with LIKE for each token
    const conditions = queryTokens.map(
      () =>
        `(LOWER(taskType) LIKE ? OR LOWER(approach) LIKE ? OR LOWER(tags) LIKE ? OR LOWER(keyDecisions) LIKE ?)`,
    );
    const params: string[] = [];
    for (const token of queryTokens) {
      const like = `%${token}%`;
      params.push(like, like, like, like);
    }

    const sql = `SELECT *, (${conditions.join(" + ")}) as matchScore
                 FROM patterns
                 WHERE ${conditions.join(" OR ")}
                 ORDER BY matchScore DESC, qualityScore DESC
                 LIMIT ?`;
    params.push(String(limit));

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map((row: any) => ({
      id: row.id,
      taskType: row.taskType,
      approach: row.approach,
      filesInvolved: JSON.parse(row.filesInvolved),
      qualityScore: row.qualityScore,
      keyDecisions: JSON.parse(row.keyDecisions),
      tags: JSON.parse(row.tags),
      createdAt: row.createdAt,
      sessionId: row.sessionId,
    }));
  }

  getHighestId(): number {
    const stmt = this.db.prepare(
      "SELECT id FROM patterns ORDER BY CAST(REPLACE(id, 'pattern-', '') AS INTEGER) DESC LIMIT 1",
    );
    const row = stmt.get() as any;
    if (!row) return 0;
    const match = row.id.match(/pattern-(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}

// ── Factory ───────────────────────────────────────────────────────────

let _store: PatternStore | null = null;

/**
 * Create or return the singleton PatternStore.
 * Attempts SQLite first, falls back to JSON.
 */
export function getPatternStore(): PatternStore {
  if (_store) return _store;

  // Try SQLite via node:sqlite (Node 22.5+)
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // Use require() for synchronous loading — dynamic import is async
    const sqliteModule = require("node:sqlite") as any;
    if (sqliteModule?.DatabaseSync) {
      const db = new sqliteModule.DatabaseSync(PATTERNS_DB);
      _store = new SqlitePatternStore(db);
      console.error(`[persistence] Using SQLite backend: ${PATTERNS_DB}`);
      return _store;
    }
  } catch {
    // node:sqlite not available — fall back
  }

  // Fallback: JSON file
  _store = new JsonPatternStore();
  console.error(`[persistence] Using JSON backend: ${PATTERNS_JSON}`);
  return _store;
}

/**
 * Synchronous factory — always returns JSON store.
 * Use this for module-level initialization where top-level await isn't available.
 */
export function getPatternStoreSync(): PatternStore {
  if (_store) return _store;
  _store = new JsonPatternStore();
  console.error(`[persistence] Using JSON backend: ${PATTERNS_JSON}`);
  return _store;
}

/**
 * Migrate existing patterns.json into a new PatternStore backend.
 */
export function migrateFromJson(store: PatternStore): void {
  if (store.backend === "json") return; // Nothing to migrate

  try {
    if (existsSync(PATTERNS_JSON)) {
      const raw = readFileSync(PATTERNS_JSON, "utf-8");
      const patterns = JSON.parse(raw) as PatternEntry[];
      if (patterns.length > 0) {
        store.save(patterns);
        console.error(
          `[persistence] Migrated ${patterns.length} patterns from JSON to ${store.backend}`,
        );
      }
    }
  } catch {
    // Migration failure is non-fatal
  }
}

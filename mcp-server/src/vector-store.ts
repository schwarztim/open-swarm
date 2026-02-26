/**
 * Vector store for semantic search using brute-force cosine similarity.
 * Persists vectors alongside SQLite — no native HNSW dependency needed.
 * Falls back gracefully: always works, just linearly scans.
 */

import { cosineSimilarity } from "./embeddings.js";

interface VectorEntry {
  id: string;
  vector: Float32Array;
  deleted: boolean;
}

class VectorStore {
  private entries: VectorEntry[] = [];
  private idToIndex = new Map<string, number>();

  /** Add a vector with an associated ID. */
  add(id: string, vector: Float32Array): void {
    const existing = this.idToIndex.get(id);
    if (existing !== undefined) {
      // Update in place
      this.entries[existing].vector = vector;
      this.entries[existing].deleted = false;
      return;
    }
    const index = this.entries.length;
    this.entries.push({ id, vector, deleted: false });
    this.idToIndex.set(id, index);
  }

  /** Search for the k nearest vectors to the query. */
  search(
    query: Float32Array,
    k: number,
  ): Array<{ id: string; distance: number }> {
    const results: Array<{ id: string; similarity: number }> = [];

    for (const entry of this.entries) {
      if (entry.deleted) continue;
      const sim = cosineSimilarity(query, entry.vector);
      results.push({ id: entry.id, similarity: sim });
    }

    // Sort by similarity descending (higher = more similar)
    results.sort((a, b) => b.similarity - a.similarity);

    return results.slice(0, k).map((r) => ({
      id: r.id,
      // Convert similarity to distance (lower = closer)
      distance: 1 - r.similarity,
    }));
  }

  /** Mark a vector as deleted. */
  remove(id: string): boolean {
    const index = this.idToIndex.get(id);
    if (index === undefined) return false;
    this.entries[index].deleted = true;
    return true;
  }

  /** Remove all deleted entries and rebuild index. */
  compact(): void {
    const live = this.entries.filter((e) => !e.deleted);
    this.entries = live;
    this.idToIndex.clear();
    for (let i = 0; i < live.length; i++) {
      this.idToIndex.set(live[i].id, i);
    }
  }

  /** Get total number of live entries. */
  get size(): number {
    return this.entries.filter((e) => !e.deleted).length;
  }

  /** Check if an ID exists. */
  has(id: string): boolean {
    const index = this.idToIndex.get(id);
    return index !== undefined && !this.entries[index].deleted;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
    this.idToIndex.clear();
  }

  /**
   * Rebuild from a set of id/vector pairs (e.g., loaded from DB).
   * Replaces all current entries.
   */
  rebuild(entries: Array<{ id: string; vector: Float32Array }>): void {
    this.clear();
    for (const e of entries) {
      this.add(e.id, e.vector);
    }
  }
}

// Singleton
let _store: VectorStore | null = null;

export function getVectorStore(): VectorStore {
  if (!_store) {
    _store = new VectorStore();
  }
  return _store;
}

export type { VectorStore };

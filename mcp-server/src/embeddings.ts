/**
 * Embedding service using @huggingface/transformers for local ONNX inference.
 * Lazy-loads all-MiniLM-L6-v2 on first call. 384-dim vectors.
 */

import { createHash } from "crypto";

// LRU cache for embeddings
const CACHE_MAX = 256;
const cache = new Map<string, Float32Array>();

function cacheKey(text: string): string {
  return createHash("md5").update(text).digest("hex");
}

function cacheSet(key: string, value: Float32Array): void {
  if (cache.size >= CACHE_MAX) {
    // Evict oldest entry
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(key, value);
}

// Lazy-loaded pipeline
let pipelineInstance: any = null;
let loadingPromise: Promise<any> | null = null;
let embeddingsAvailable = false;

/** Returns true if the real ONNX embedding model loaded successfully. */
export function isEmbeddingsAvailable(): boolean {
  return embeddingsAvailable;
}

async function getPipeline(): Promise<any> {
  if (pipelineInstance) return pipelineInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      const { pipeline } = await import("@anthropic-ai/tokenizers" as any)
        .catch(() => import("@huggingface/transformers" as any))
        .catch(() => {
          // Final fallback: use a simple bag-of-words embedding
          return null;
        });

      if (pipeline) {
        pipelineInstance = await pipeline(
          "feature-extraction",
          "Xenova/all-MiniLM-L6-v2",
          { cache_dir: new URL("../data/models/", import.meta.url).pathname },
        );
        if (pipelineInstance) {
          embeddingsAvailable = true;
        }
      }
    } catch {
      // Model loading failed — fallback to hash-based embedding
      pipelineInstance = null;
      embeddingsAvailable = false;
    }
    return pipelineInstance;
  })();

  return loadingPromise;
}

/** Build searchable text from a pattern entry's fields. */
export function patternToText(entry: {
  taskType: string;
  approach: string;
  tags: string[];
  keyDecisions: string[];
}): string {
  return [entry.taskType, entry.approach, ...entry.tags, ...entry.keyDecisions]
    .filter(Boolean)
    .join(" ");
}

/**
 * Fallback embedding: deterministic 384-dim vector from text hash.
 * Not semantic, but provides consistent vectors for HNSW indexing.
 */
function hashEmbed(text: string): Float32Array {
  const result = new Float32Array(384);
  const hash = createHash("sha512").update(text.toLowerCase()).digest();
  // Generate more bytes for full coverage
  const hash2 = createHash("sha512").update(hash).digest();
  const hash3 = createHash("sha512").update(hash2).digest();
  const all = Buffer.concat([hash, hash2, hash3]); // 192 bytes = 384 values / 2

  for (let i = 0; i < 384; i++) {
    // Map bytes to [-1, 1] range
    result[i] = all[i % all.length] / 127.5 - 1;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < 384; i++) norm += result[i] * result[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < 384; i++) result[i] /= norm;
  }

  return result;
}

/** Generate a 384-dim embedding for text. Uses ONNX model if available, hash fallback otherwise. */
export async function embed(text: string): Promise<Float32Array> {
  const key = cacheKey(text);
  const cached = cache.get(key);
  if (cached) return cached;

  const pipe = await getPipeline();

  let vector: Float32Array;
  if (pipe) {
    const output = await pipe(text, { pooling: "mean", normalize: true });
    vector = new Float32Array(output.data);
  } else {
    console.error(
      "[embeddings] WARNING: Semantic search unavailable - model failed to load. Pattern memory disabled.",
    );
    vector = hashEmbed(text);
  }

  cacheSet(key, vector);
  return vector;
}

/** Batch embed multiple texts. */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  return Promise.all(texts.map(embed));
}

/** Cosine similarity between two vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

/** Check if the ONNX model is available (vs hash fallback). */
export async function isModelLoaded(): Promise<boolean> {
  const pipe = await getPipeline();
  return pipe !== null;
}

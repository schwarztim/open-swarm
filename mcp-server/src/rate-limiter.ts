// ── Rate Limiting ──────────────────────────────────────────────────────
// Token-bucket rate limiter pacing dispatch calls under GitHub Copilot RPM limits.

import { ALL_MODELS, type RatePreset, type RateConfig, type ModelEntry } from "./model-registry.js";

// Re-export the RatePreset type for consumers importing from here
export type { RatePreset };

// ── Token-Bucket API Rate Limiter ────────────────────────────────────
// Copilot premium request multipliers (per prompt):
//   Premium (Opus, codex-max): 3x premium requests
//   Standard (Sonnet, GPT-5.x): 1x premium request
//   Fast (Haiku, codex-mini): ~0.33x premium request

interface TierRPM {
  rpm: number;
  burstMax: number;
  intervalMs: number;
  costMultiplier: number;
}

const TIER_RPM: Record<string, TierRPM> = {
  premium: { rpm: 2, burstMax: 2, intervalMs: 30000, costMultiplier: 3 },
  standard: { rpm: 10, burstMax: 5, intervalMs: 6000, costMultiplier: 1 },
  fast: { rpm: 15, burstMax: 8, intervalMs: 4000, costMultiplier: 0.33 },
};

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRateMs: number;

  constructor(maxTokens: number, refillRateMs: number) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.refillRateMs = refillRateMs;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillRateMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }

  /** Try to consume a token. Returns { ok: true } or { ok: false, retryAfterMs }. */
  tryConsume(): { ok: boolean; retryAfterMs: number } {
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return { ok: true, retryAfterMs: 0 };
    }
    const elapsed = Date.now() - this.lastRefill;
    const retryAfterMs = Math.max(0, this.refillRateMs - elapsed);
    return { ok: false, retryAfterMs };
  }

  /** Current state for status reporting. */
  status(): { tokens: number; maxTokens: number; refillRateMs: number } {
    this.refill();
    return {
      tokens: this.tokens,
      maxTokens: this.maxTokens,
      refillRateMs: this.refillRateMs,
    };
  }
}

// Per-session rate limiters keyed by "sessionId:tier"
const rateLimiters = new Map<string, TokenBucket>();

function getBucket(sessionId: string, modelTier: string): TokenBucket {
  const key = `${sessionId}:${modelTier}`;
  let bucket = rateLimiters.get(key);
  if (!bucket) {
    const tierConfig = TIER_RPM[modelTier] ?? TIER_RPM.standard;
    bucket = new TokenBucket(tierConfig.burstMax, tierConfig.intervalMs);
    rateLimiters.set(key, bucket);
  }
  return bucket;
}

/** Check rate limit before dispatching. Returns wait time in ms (0 = go ahead). */
export function checkRateLimit(
  sessionId: string,
  modelId: string,
): { ok: boolean; retryAfterMs: number; tier: string } {
  const entry = ALL_MODELS.find((m) => m.id === modelId);
  const tier = entry?.tier ?? "standard";
  const bucket = getBucket(sessionId, tier);
  const result = bucket.tryConsume();
  return { ...result, tier };
}

/** Get rate limiter status for all tiers in a session. */
export function getRateLimitStatus(
  sessionId: string,
): Record<
  string,
  { tokens: number; maxTokens: number; rpm: number; costMultiplier: number }
> {
  const result: Record<
    string,
    { tokens: number; maxTokens: number; rpm: number; costMultiplier: number }
  > = {};
  for (const [tierName, tierConfig] of Object.entries(TIER_RPM)) {
    const bucket = getBucket(sessionId, tierName);
    const s = bucket.status();
    result[tierName] = {
      tokens: s.tokens,
      maxTokens: s.maxTokens,
      rpm: tierConfig.rpm,
      costMultiplier: tierConfig.costMultiplier,
    };
  }
  return result;
}

/** Clean up rate limiters when a session ends. */
export function clearRateLimiters(sessionId: string): void {
  for (const key of rateLimiters.keys()) {
    if (key.startsWith(`${sessionId}:`)) rateLimiters.delete(key);
  }
}

export const RATE_PRESETS: Record<RatePreset, RateConfig> = {
  conservative: {
    concurrency: 2,
    maxAgents: 10,
    description:
      "Safe for any Copilot plan. 2 L2 managers at a time (~10 total agents).",
    plan: "Any (Free, Pro, Business, Enterprise)",
  },
  standard: {
    concurrency: 3,
    maxAgents: 15,
    description:
      "3 L2 managers at a time (~15 agents). Good balance of speed and stability.",
    plan: "Business or Enterprise",
  },
  aggressive: {
    concurrency: 4,
    maxAgents: 20,
    description:
      "4 L2 managers at a time (~20 agents). Provider diversity reduces per-provider load.",
    plan: "Enterprise (8 concurrent per tier)",
  },
  max: {
    concurrency: 8,
    maxAgents: 40,
    description:
      "8 L2 managers at a time (~40 agents). Maximum throughput. May hit rate limits on busy days.",
    plan: "Enterprise with headroom",
  },
  unlimited: {
    concurrency: 0,
    maxAgents: Infinity,
    description:
      "No limit. All managers dispatch at once. Use at your own risk.",
    plan: "N/A — risk of rate limit errors",
  },
};

export function resolveRateLimit(input?: number | RatePreset): number {
  if (input === undefined || input === null)
    return RATE_PRESETS.standard.concurrency;
  if (typeof input === "number") return input;
  const preset = RATE_PRESETS[input];
  return preset ? preset.concurrency : RATE_PRESETS.standard.concurrency;
}

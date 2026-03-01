// ── Dynamic Model Registry ────────────────────────────────────────────
// Model resolution, fallback chains, and role-based pool management.

// Model tiers: premium (architect/synthesizer), standard (coders/critics), fast (explorers/merge)
export interface ModelEntry {
  id: string;
  tier: "premium" | "standard" | "fast";
  provider: string; // 'anthropic' | 'openai' | 'google'
}

export type RatePreset =
  | "conservative"
  | "standard"
  | "aggressive"
  | "max"
  | "unlimited";

export interface RateConfig {
  concurrency: number;
  maxAgents: number;
  description: string;
  plan: string;
}

// All known models — add new ones here and they auto-distribute
// SOURCE OF TRUTH: QVC Group GitHub Enterprise Copilot AI Controls (models.pdf)
// RANKING SOURCE: llm-stats.com Code Arena scores (Feb 2026)
export const ALL_MODELS: ModelEntry[] = [
  // ── Premium ──────────────────────────────────────────────────────────
  { id: "claude-opus-4.6", tier: "premium", provider: "anthropic" },
  { id: "gemini-2.5-pro", tier: "premium", provider: "google" },
  // ── Standard ─────────────────────────────────────────────────────────
  { id: "claude-sonnet-4-20250514", tier: "standard", provider: "anthropic" },
  { id: "claude-sonnet-4.6", tier: "standard", provider: "anthropic" },
  { id: "gpt-4.1", tier: "standard", provider: "openai" },
  { id: "gpt-4o", tier: "standard", provider: "openai" },
  { id: "gemini-2.5-pro", tier: "standard", provider: "google" },
  // ── Fast ─────────────────────────────────────────────────────────────
  { id: "claude-haiku-4.5", tier: "fast", provider: "anthropic" },
  { id: "o4-mini", tier: "fast", provider: "openai" },
  { id: "gemini-2.5-flash", tier: "fast", provider: "google" },
];

// ── Model Fallback System ─────────────────────────────────────────────
// Explicit fallback chains — ordered by Code Arena score (llm-stats.com Feb 2026)
const MODEL_FALLBACK_CHAINS: Record<string, string[]> = {
  // Anthropic
  "claude-opus-4.6": ["claude-sonnet-4.6", "gpt-4.1", "gemini-2.5-pro"],
  "claude-sonnet-4.6": ["claude-sonnet-4-20250514", "gpt-4.1", "gemini-2.5-pro"],
  "claude-sonnet-4-20250514": ["claude-sonnet-4.6", "gpt-4.1", "gemini-2.5-pro"],
  "claude-haiku-4.5": ["o4-mini", "gemini-2.5-flash", "claude-sonnet-4.6"],
  // OpenAI
  "gpt-4.1": ["claude-sonnet-4.6", "gemini-2.5-pro", "gpt-4o"],
  "gpt-4o": ["gpt-4.1", "claude-sonnet-4.6", "gemini-2.5-pro"],
  "o4-mini": ["claude-haiku-4.5", "gemini-2.5-flash", "gpt-4.1"],
  // Google
  "gemini-2.5-pro": ["claude-sonnet-4.6", "gpt-4.1", "claude-opus-4.6"],
  "gemini-2.5-flash": ["claude-haiku-4.5", "o4-mini", "gemini-2.5-pro"],
};

// ── Model Upgrade Map ─────────────────────────────────────────────────
const MODEL_UPGRADES: Record<string, string> = {
  "claude-sonnet-4.5": "claude-sonnet-4.6",
  "claude-opus-4.5": "claude-opus-4.6",
  "claude-sonnet-4-20250514": "claude-sonnet-4.6",
};

// Available models — populated at startup, can be overridden via setAvailableModels()
let availableModels: ModelEntry[] = [...ALL_MODELS];

export function setAvailableModels(modelIds: string[]): void {
  availableModels = ALL_MODELS.filter((m) => modelIds.includes(m.id));
  rebuildPools();
}

export function getAvailableModels(): ModelEntry[] {
  return availableModels;
}

/**
 * Resolve a model to an available one. If the requested model is available, return it.
 * Otherwise walk the fallback chain, then try same-tier same-provider, same-tier any, then anything.
 */
export function resolveModel(requestedModel: string): string {
  if (availableModels.find((m) => m.id === requestedModel)) {
    const upgrade = MODEL_UPGRADES[requestedModel];
    if (upgrade && availableModels.find((m) => m.id === upgrade)) {
      console.error(
        `[model-upgrade] ${requestedModel} → ${upgrade} (upgrade available)`,
      );
      return upgrade;
    }
    return requestedModel;
  }

  const requested = ALL_MODELS.find((m) => m.id === requestedModel);
  const requestedTier = requested?.tier ?? "standard";
  const requestedProvider = requested?.provider ?? "unknown";

  // 1. Walk explicit fallback chain
  const chain = MODEL_FALLBACK_CHAINS[requestedModel];
  if (chain) {
    for (const fallback of chain) {
      if (availableModels.find((m) => m.id === fallback)) {
        console.error(
          `[model-fallback] ${requestedModel} → ${fallback} (explicit chain)`,
        );
        const upgrade = MODEL_UPGRADES[fallback];
        if (upgrade && availableModels.find((m) => m.id === upgrade)) {
          console.error(
            `[model-upgrade] ${fallback} → ${upgrade} (upgrade available)`,
          );
          return upgrade;
        }
        return fallback;
      }
    }
  }

  // 2. Same tier + same provider
  const sameTierProvider = availableModels.find(
    (m) => m.tier === requestedTier && m.provider === requestedProvider,
  );
  if (sameTierProvider) {
    console.error(
      `[model-fallback] ${requestedModel} → ${sameTierProvider.id} (same tier+provider)`,
    );
    return sameTierProvider.id;
  }

  // 3. Same tier, any provider
  const sameTier = availableModels.find((m) => m.tier === requestedTier);
  if (sameTier) {
    console.error(
      `[model-fallback] ${requestedModel} → ${sameTier.id} (same tier)`,
    );
    return sameTier.id;
  }

  // 4. Anything available
  if (availableModels.length > 0) {
    const fallback = availableModels[0].id;
    console.error(
      `[model-fallback] ${requestedModel} → ${fallback} (last resort)`,
    );
    return fallback;
  }

  console.error(
    `[model-fallback] ${requestedModel} — NO fallbacks available, returning as-is`,
  );
  return requestedModel;
}

// Track fallback events for diagnostics
const MAX_FALLBACK_LOG = 500;
const fallbackLog: Array<{
  from: string;
  to: string;
  reason: string;
  ts: Date;
}> = [];

export function resolveModelTracked(requestedModel: string): {
  model: string;
  wasFallback: boolean;
} {
  const resolved = resolveModel(requestedModel);
  const upgrade = MODEL_UPGRADES[resolved];
  const final =
    upgrade && availableModels.find((m) => m.id === upgrade)
      ? upgrade
      : resolved;
  const wasFallback = final !== requestedModel;
  if (wasFallback) {
    if (fallbackLog.length >= MAX_FALLBACK_LOG) fallbackLog.shift();
    fallbackLog.push({
      from: requestedModel,
      to: final,
      reason: final !== resolved ? "upgrade_available" : "not_available",
      ts: new Date(),
    });
  }
  return { model: final, wasFallback };
}

export function getFallbackLog(): typeof fallbackLog {
  return fallbackLog;
}

// Role-based pools — rebuilt when available models change
export let premiumPool: string[] = [];
export let coderPool: string[] = [];
export let criticPool: string[] = [];
export let fastPool: string[] = [];

function rebuildPools(): void {
  const premium = availableModels.filter((m) => m.tier === "premium");
  const standard = availableModels.filter((m) => m.tier === "standard");
  const fast = availableModels.filter((m) => m.tier === "fast");

  premiumPool = premium.map((m) => m.id);
  fastPool = fast.map((m) => m.id);

  const byProvider = new Map<string, string[]>();
  for (const m of standard) {
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m.id);
    byProvider.set(m.provider, arr);
  }
  coderPool = [];
  const providers = [...byProvider.values()];
  const maxLen = Math.max(...providers.map((p) => p.length));
  for (let i = 0; i < maxLen; i++) {
    for (const p of providers) {
      if (i < p.length) coderPool.push(p[i]);
    }
  }

  criticPool =
    standard.length > 1
      ? standard.filter((_, i) => i % 2 === 1).map((m) => m.id)
      : standard.map((m) => m.id);

  if (premiumPool.length === 0)
    premiumPool = coderPool.length > 0 ? [coderPool[0]] : ["claude-sonnet-4.6"];
  if (coderPool.length === 0) coderPool = ["claude-sonnet-4.6", "gpt-4.1", "gemini-2.5-pro"];
  if (criticPool.length === 0) criticPool = coderPool.slice(0, 2);
  if (fastPool.length === 0) fastPool = ["claude-haiku-4.5", "o4-mini", "gemini-2.5-flash"];

  const availableIds = new Set(availableModels.map((m) => m.id));
  const applyUpgrades = (pool: string[]): string[] =>
    pool.map((id) => {
      const upgrade = MODEL_UPGRADES[id];
      return upgrade && availableIds.has(upgrade) ? upgrade : id;
    });
  premiumPool = [...new Set(applyUpgrades(premiumPool))];
  coderPool = [...new Set(applyUpgrades(coderPool))];
  criticPool = [...new Set(applyUpgrades(criticPool))];
  fastPool = [...new Set(applyUpgrades(fastPool))];
}

// Initialize pools
rebuildPools();

// ── Model Rotation (dynamic) ──────────────────────────────────────────

export function getArchitectModel(): string {
  return premiumPool[0];
}

export function getCoderModel(workstreamIndex: number): string {
  return coderPool[workstreamIndex % coderPool.length];
}

export function getCriticModel(batchIndex: number): string {
  return criticPool[batchIndex % criticPool.length];
}

export function getFastModel(index: number = 0): string {
  return fastPool[index % fastPool.length];
}

export function getSynthesizerModel(): string {
  return premiumPool.length > 1 ? premiumPool[1] : premiumPool[0];
}

// Look up provider for a model ID
export function getModelProvider(modelId: string): string {
  const entry = availableModels.find((m) => m.id === modelId);
  return entry?.provider ?? "unknown";
}

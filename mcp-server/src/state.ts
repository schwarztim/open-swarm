// ── Types ──────────────────────────────────────────────────────────────

export type Tier =
  | "duo"
  | "trio"
  | "full-swarm"
  | "blitz"
  | "debate"
  | "unleashed";
export type ExecutionMode = "task" | "subprocess";
export type RatePreset =
  | "conservative"
  | "standard"
  | "aggressive"
  | "max"
  | "unlimited";

// ── L3 Worker Specialization Types ────────────────────────────────────

export type WorkerRole =
  | "coder"
  | "tester"
  | "reviewer"
  | "security"
  | "architect"
  | "documenter"
  | "debugger"
  | "devops"
  | "meta-worker";

export type TaskComplexity = "trivial" | "standard" | "complex" | "review";

export type WorkerMode = "implement" | "propose";

// ── File Claims & Anti-Drift Types ────────────────────────────────────

export interface FileClaim {
  path: string;
  claimedBy: string;
  groupId: string;
  claimedAt: number;
  released: boolean;
}

export interface DriftCheck {
  taskGoal: string;
  outputSummary: string;
  alignmentScore: number;
  driftSignals: string[];
}

// ── Pattern Memory Types ──────────────────────────────────────────────

export interface PatternEntry {
  id: string;
  taskType: string;
  approach: string;
  filesInvolved: string[];
  qualityScore: number;
  keyDecisions: string[];
  tags: string[];
  createdAt: number;
  sessionId: string;
}

// ── Worker Consensus Types ────────────────────────────────────────────

export interface ConsensusProposal {
  workstreamId: string;
  slotId: string;
  model: string;
  content: string;
  score?: number;
  submittedAt: number;
}

export interface ConsensusState {
  id: string;
  sessionId: string;
  groupId: string;
  topic: string;
  proposals: ConsensusProposal[];
  convergenceScore?: number;
  selectedProposal?: string;
  status: "collecting" | "evaluating" | "decided" | "escalated";
  createdAt: number;
  resolvedAt?: number;
}

// ── Debate Protocol Types ─────────────────────────────────────────────

export type DebatePhase =
  | "position"
  | "critique"
  | "rebuttal"
  | "evaluation"
  | "synthesis"
  | "escalation";

export type DebateStatus =
  | "pending"
  | "active"
  | "converged"
  | "stalled"
  | "escalated"
  | "resolved";

export type DebateTrigger =
  | "explicit"
  | "disagreement"
  | "quality-split"
  | "l1-directive";

export interface DebateContribution {
  slotId: string;
  agentType: string;
  model: string;
  phase: DebatePhase;
  content: string;
  timestamp: number;
  score?: DebatePositionScore;
}

export interface DebateClaim {
  id: string;
  text: string;
  sourceSlot: string;
  agreeSlots: string[];
  disagreeSlots: string[];
  status: "agreed" | "contested" | "undecided";
  round: number;
}

export interface ValidationCheckpoint {
  debateId: string;
  synthesis: string;
  submittedAt: number;
  validatedAt?: number;
  outcome: "pending" | "confirmed" | "failed" | "partial";
  findings: string[];
  reopenedDebateId?: string;
}

export interface DebateRound {
  roundNumber: number;
  phase: DebatePhase;
  contributions: DebateContribution[];
  evaluation?: DebateEvaluation;
  claims?: DebateClaim[];
  startedAt: number;
  completedAt?: number;
}

export interface DebatePositionScore {
  evidenceQuality: number;
  reasoningClarity: number;
  rebuttalEffectiveness: number;
  novelContribution: number;
  total: number;
  summary: string;
}

export interface DebateEvaluation {
  convergenceScore: number;
  convergenceDelta: number;
  sycophancyScore: number;
  positionScores: DebatePositionScore[];
  dominantPosition?: string;
  recommendation: "continue" | "converged" | "stalled" | "escalate";
  reasoning: string;
  synthesisReady: boolean;
}

export interface DebateParticipant {
  slotId: string;
  workstreamId?: string;
  agentType: string;
  model: string;
}

export interface DebateState {
  id: string;
  sessionId: string;
  groupId?: string;
  topic: string;
  trigger: DebateTrigger;
  initiatorLevel: "L1" | "L2";
  status: DebateStatus;
  participants: DebateParticipant[];
  rounds: DebateRound[];
  currentRound: number;
  maxRounds: number;
  convergenceThreshold: number;
  sycophancyThreshold: number;
  minPositionScore: number;
  fastTrack: boolean;
  contrarian?: string;
  claims: DebateClaim[];
  synthesis?: string;
  escalationContext?: string;
  validation?: ValidationCheckpoint;
  createdAt: number;
  resolvedAt?: number;
}

// ── Rate Limit Presets ────────────────────────────────────────────────
// Based on GitHub Copilot rate limits (docs.github.com/en/copilot/concepts/rate-limits)
//
// Key constraints per model tier:
//   Standard models (Sonnet, GPT-5.x, Gemini): 10-15 RPM, 5 concurrent
//   Premium models (Opus):  1-2 RPM, 1-2 concurrent
//   Fast models (Haiku, GPT-5.1-codex-mini): 15 RPM, 5-8 concurrent
//
// Each L2 manager + its workers ≈ 5 concurrent API sessions.
// Multi-provider spread helps (Anthropic/OpenAI/Google have separate quotas).

export interface RateConfig {
  concurrency: number; // max simultaneous L2 managers
  maxAgents: number; // approx total agents (managers + workers)
  description: string;
  plan: string; // recommended Copilot plan
}

// ── Token-Bucket API Rate Limiter ────────────────────────────────────
// Paces dispatch calls to stay under GitHub Copilot's per-model-tier RPM limits.
// The orchestrator is told to wait N seconds when the bucket is empty.
//
// Copilot premium request multipliers (per prompt):
//   Premium (Opus, codex-max): 3x premium requests
//   Standard (Sonnet, GPT-5.x): 1x premium request
//   Fast (Haiku, codex-mini): ~0.33x premium request
//   Gemini (Pro, Flash): ~0.5x / ~0.25x premium request
// Quality takes precedence over cost — use the best model for the job.

interface TierRPM {
  rpm: number; // requests per minute for this tier
  burstMax: number; // max burst tokens (allows small bursts then paces)
  intervalMs: number; // computed: 60000 / rpm
  costMultiplier: number; // Copilot premium request multiplier
}

const TIER_RPM: Record<string, TierRPM> = {
  premium: { rpm: 2, burstMax: 2, intervalMs: 30000, costMultiplier: 3 }, // Opus/codex-max: 3x
  standard: { rpm: 10, burstMax: 5, intervalMs: 6000, costMultiplier: 1 }, // Sonnet/GPT-5.x: 1x
  fast: { rpm: 15, burstMax: 8, intervalMs: 4000, costMultiplier: 0.33 }, // Haiku/mini/flash: ~0.33x
};

class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRateMs: number; // ms per token

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
    // How long until next token?
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

export interface PhaseDefinition {
  name: string;
  agentType: string;
  model: string;
  mode: "sync" | "background";
  parallel: boolean;
  requiresMerge: boolean;
  isGate: boolean;
  isValidationGate?: boolean;
}

export interface PhaseState {
  name: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  agentIds: string[];
  outputs: string[];
}

// ── Acceptance Test & Validation Types ────────────────────────────────

export interface AcceptanceTest {
  name: string; // "GET /api/v1/connectors returns 200"
  command: string; // "curl -sf http://localhost:8000/api/v1/connectors"
  expect: string; // "status_code:200" or "json:.status == \"ok\""
  category: "static" | "unit" | "integration";
}

export interface ValidationResult {
  workstream: string;
  tests: Array<{
    name: string;
    category: "static" | "unit" | "integration";
    status: "pass" | "fail" | "skip" | "error";
    actual?: string;
    expected?: string;
    error?: string;
    durationMs?: number;
  }>;
  summary: { total: number; passed: number; failed: number; skipped: number };
}

export interface Workstream {
  id: string;
  description: string;
  files: string[];
  modelAssigned: string;
  score?: number;
  criticalIssues?: number;
  subprocessPid?: number;
  outputFile?: string;
  sessionUuid?: string;
  acceptanceTests?: AcceptanceTest[];
  dependencies: string[]; // workstream IDs that must complete before this one
  status: "pending" | "ready" | "in_progress" | "done" | "blocked";
}

export type BoardMessageType =
  | "finding"
  | "blocker"
  | "decision"
  | "status"
  | "plan"
  | "report"
  | "debate-position"
  | "debate-critique"
  | "debate-rebuttal"
  | "debate-synthesis"
  | "debate-escalation"
  | "background"
  | "validation";

export interface BoardMessage {
  workstream: string; // who posted it
  type: BoardMessageType;
  level: "L1" | "L2" | "L3"; // hierarchy level of the sender
  group?: string; // agent group ID (L2 manager name)
  debateId?: string; // Links message to a specific debate (NEW)
  content: string;
  timestamp: number;
}

// ── 3-Level Hierarchy ─────────────────────────────────────────────────
// L1 = Orchestrator (big boss, premium model, calls MCP tools)
// L2 = Agents/Managers (dispatched by L1, can spawn L3 workers, report plans)
// L3 = Workers (spawned by L2, do actual work, report to their L2 manager)

export interface AgentGroup {
  id: string; // e.g., "group-0", "group-1"
  managerAgent: string; // L2 agent type (e.g., "manager-anthropic")
  managerModel: string; // model assigned to the L2 manager
  workerSlots: WorkerSlot[]; // L3 worker assignments
  plan: string; // L2 manager's plan (submitted during execution)
  status: "pending" | "dispatched" | "reporting" | "done";
  report?: string; // L2's final synthesized report to L1
  healthStatus?: "healthy" | "degraded" | "failed"; // WS2a: group health tracking
  failureReason?: string; // WS2a: reason for degraded/failed status
  submittedAt?: number; // WS2a: timestamp when report was submitted
}

export interface WorkerSlot {
  workstreamId: string; // which workstream this worker handles
  agentType: string; // e.g., "worker-openai"
  model: string; // model for this worker
  description: string; // what this worker should do
  files: string[]; // files assigned
  role: WorkerRole; // domain specialization (coder, tester, etc.)
  mode: WorkerMode; // implement (default) or propose (consensus mode)
  complexity?: TaskComplexity; // task complexity classification
}

export interface HistoryEntry {
  round: number;
  phase: string;
  content: string;
}

export interface RoundRecord {
  round: number;
  workstream: string;
  model: string;
  score: number;
  criticalIssues: number;
}

export interface SwarmSession {
  id: string;
  tier: Tier;
  task: string;
  phases: PhaseState[];
  currentPhaseIndex: number;
  workstreams: Workstream[];
  agentGroups: AgentGroup[]; // L2 manager groups
  history: HistoryEntry[];
  rounds: RoundRecord[];
  board: BoardMessage[]; // programmatic message board
  debates: DebateState[]; // Active and completed debates
  claims: FileClaim[]; // File ownership claims
  patterns: PatternEntry[]; // Pattern memory store
  consensuses: ConsensusState[]; // Worker consensus sessions
  patternIdsUsed: string[]; // Pattern IDs retrieved for this session (learning loop)
  promptStore: Map<string, string>; // server-side prompt storage to avoid LLM output truncation
  validationResults: ValidationResult[]; // Validation pipeline results
  maxLoops: number;
  concurrency: number; // max simultaneous L2 managers (0 = unlimited)
  createdAt: Date;
  executionMode: ExecutionMode;
  outputDir: string;
}

// ── Dynamic Model Registry ────────────────────────────────────────────

// Model tiers: premium (architect/synthesizer), standard (coders/critics), fast (explorers/merge)
interface ModelEntry {
  id: string;
  tier: "premium" | "standard" | "fast";
  provider: string; // 'anthropic' | 'openai' | 'google'
}

// All known models — add new ones here and they auto-distribute
// SOURCE OF TRUTH: QVC Group GitHub Enterprise Copilot AI Controls (models.pdf)
// RANKING SOURCE: llm-stats.com Code Arena scores (Feb 2026)
const ALL_MODELS: ModelEntry[] = [
  // Premium
  { id: "claude-opus-4.6", tier: "premium", provider: "anthropic" },
  // Standard
  { id: "claude-sonnet-4.6", tier: "standard", provider: "anthropic" },
  // Fast
  { id: "claude-haiku-4.5", tier: "fast", provider: "anthropic" },
];

// ── Model Fallback System ─────────────────────────────────────────────
// When a model isn't available, auto-resolve to the best alternative.
// Priority: same provider + same tier → same tier any provider → any available

// Explicit fallback chains — ordered by Code Arena score (llm-stats.com Feb 2026)
// Only references models enabled in QVC Enterprise Copilot (models.pdf)
// Rule: always prefer opus-4.6 over opus-4.5 (same premium cost, 4.6 is #1 vs #3)
const MODEL_FALLBACK_CHAINS: Record<string, string[]> = {
  "claude-opus-4.6": ["claude-sonnet-4.6"],
  "claude-sonnet-4.6": ["claude-opus-4.6"],
  "claude-haiku-4.5": ["claude-sonnet-4.6"],
};

// ── Model Upgrade Map ─────────────────────────────────────────────────
// Ensures newer (better) model versions are always preferred over older ones.
// When a resolved model has an upgrade and the upgrade is available, use it.
const MODEL_UPGRADES: Record<string, string> = {
  "claude-sonnet-4.5": "claude-sonnet-4.6",
  "claude-opus-4.5": "claude-opus-4.6",
};

/**
 * Resolve a model to an available one. If the requested model is available, return it.
 * Otherwise walk the fallback chain, then try same-tier same-provider, same-tier any, then anything.
 */
export function resolveModel(requestedModel: string): string {
  // If available, use it directly
  if (availableModels.find((m) => m.id === requestedModel)) {
    // WS5b: Check if an upgrade is available
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
        // WS5b: Check if an upgrade is available for the fallback too
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

  // Nothing available — return original and let it fail loud
  console.error(
    `[model-fallback] ${requestedModel} — NO fallbacks available, returning as-is`,
  );
  return requestedModel;
}

// Track fallback events for diagnostics
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
  // WS5b: Also check for upgrade on the resolved model (handles cases where
  // resolveModel returned an exact match but an upgrade is available)
  const upgrade = MODEL_UPGRADES[resolved];
  const final =
    upgrade && availableModels.find((m) => m.id === upgrade)
      ? upgrade
      : resolved;
  const wasFallback = final !== requestedModel;
  if (wasFallback) {
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

// Available models — populated at startup, can be overridden via setAvailableModels()
let availableModels: ModelEntry[] = [...ALL_MODELS];

export function setAvailableModels(modelIds: string[]): void {
  availableModels = ALL_MODELS.filter((m) => modelIds.includes(m.id));
  // Rebuild role pools
  rebuildPools();
}

export function getAvailableModels(): ModelEntry[] {
  return availableModels;
}

// Role-based pools — rebuilt when available models change
let premiumPool: string[] = [];
let coderPool: string[] = [];
let criticPool: string[] = [];
let fastPool: string[] = [];

function rebuildPools(): void {
  const premium = availableModels.filter((m) => m.tier === "premium");
  const standard = availableModels.filter((m) => m.tier === "standard");
  const fast = availableModels.filter((m) => m.tier === "fast");

  premiumPool = premium.map((m) => m.id);
  fastPool = fast.map((m) => m.id);

  // Coders: all standard models, interleaved by provider for max diversity
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

  // Critics: standard models from different providers than the default coder
  criticPool =
    standard.length > 1
      ? standard.filter((_, i) => i % 2 === 1).map((m) => m.id)
      : standard.map((m) => m.id);

  // Fallbacks if pools are empty
  if (premiumPool.length === 0)
    premiumPool = coderPool.length > 0 ? [coderPool[0]] : ["claude-sonnet-4.6"];
  if (coderPool.length === 0) coderPool = ["claude-sonnet-4.6"];
  if (criticPool.length === 0) criticPool = coderPool.slice(0, 2);
  if (fastPool.length === 0) fastPool = ["claude-haiku-4.5"];

  // WS5d: Apply upgrades across all pools — replace old models with new ones
  // if the new model is available (ensures 4.6 is always used over 4.5)
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
  // Use second premium if available for diversity, otherwise first
  return premiumPool.length > 1 ? premiumPool[1] : premiumPool[0];
}

// Export pools for introspection
export { premiumPool, coderPool, criticPool, fastPool };

// Look up provider for a model ID
export function getModelProvider(modelId: string): string {
  const entry = availableModels.find((m) => m.id === modelId);
  return entry?.provider ?? "unknown";
}

// ── Phase Definitions per Tier ─────────────────────────────────────────

function def(
  name: string,
  agentType: string,
  model: string,
  mode: "sync" | "background",
  parallel: boolean,
  requiresMerge: boolean,
  isGate: boolean,
): PhaseDefinition {
  return { name, agentType, model, mode, parallel, requiresMerge, isGate };
}

export const TIER_PHASES: Record<Tier, PhaseDefinition[]> = {
  duo: [
    def(
      "implement",
      "clean-code",
      getCoderModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
  ],
  trio: [
    def(
      "design",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "implement",
      "clean-code",
      getCoderModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
  ],
  "full-swarm": [
    def("explore", "explore", getFastModel(), "background", true, true, false),
    def(
      "merge_explore",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "design",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "implement",
      "clean-code",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_impl",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
  blitz: [
    def("recon", "explore", getFastModel(), "background", true, true, false),
    def(
      "merge_recon",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "triage",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "build",
      "clean-code",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_build",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_review",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
  debate: [
    def(
      "propose",
      "architect",
      getArchitectModel(),
      "background",
      true,
      false,
      false,
    ),
    def(
      "critique",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    def(
      "rebuttal",
      "architect",
      getArchitectModel(),
      "background",
      true,
      false,
      false,
    ),
    def(
      "merge_debate",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
  unleashed: [
    def("recon", "explore", getFastModel(), "background", true, true, false),
    def(
      "merge_recon",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "triage",
      "architect",
      getArchitectModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "build",
      "clean-code",
      getCoderModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_build",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def(
      "review",
      "code-review",
      getCriticModel(0),
      "background",
      true,
      true,
      false,
    ),
    def(
      "merge_review",
      "general-purpose",
      getFastModel(),
      "sync",
      false,
      false,
      false,
    ),
    def("gate", "task", "", "sync", false, false, true),
    def("validate-static", "task", getFastModel(), "sync", false, false, false),
    def(
      "validate-integration",
      "task",
      getCriticModel(0),
      "background",
      true,
      false,
      false,
    ),
    {
      ...def("validate-gate", "task", "", "sync", false, false, true),
      isValidationGate: true,
    },
    def(
      "synthesize",
      "architect",
      getSynthesizerModel(),
      "sync",
      false,
      false,
      false,
    ),
  ],
};

// ── Session Store ──────────────────────────────────────────────────────

export const sessions = new Map<string, SwarmSession>();

let idCounter = 0;
function generateId(): string {
  idCounter++;
  return `swarm-${Date.now()}-${idCounter}`;
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
  return session;
}

export function getSession(id: string): SwarmSession | undefined {
  return sessions.get(id);
}

export function getPhaseDefinition(
  session: SwarmSession,
  phaseIndex?: number,
): PhaseDefinition {
  const idx = phaseIndex ?? session.currentPhaseIndex;
  return TIER_PHASES[session.tier][idx];
}

// ── Phase Transition Validation ────────────────────────────────────────

export function advancePhase(sessionId: string): PhaseState {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  const currentIndex = session.currentPhaseIndex;
  const currentPhase = session.phases[currentIndex];
  const currentDef = TIER_PHASES[session.tier][currentIndex];

  // Validate current phase is done
  if (currentPhase.status !== "done") {
    throw new Error(
      `Cannot advance: phase "${currentPhase.name}" is "${currentPhase.status}", expected "done".`,
    );
  }

  // Validate merge requirement
  if (currentDef.requiresMerge) {
    const nextIndex = currentIndex + 1;
    if (nextIndex < session.phases.length) {
      const nextPhase = session.phases[nextIndex];
      const nextDef = TIER_PHASES[session.tier][nextIndex];
      if (nextDef.name.startsWith("merge_") && nextPhase.status !== "done") {
        throw new Error(
          `Cannot advance past "${currentPhase.name}": merge phase "${nextDef.name}" has not completed.`,
        );
      }
    }
  }

  // Validate gate
  if (currentDef.isGate) {
    const failedWorkstreams = session.workstreams.filter(
      (ws) => ws.score !== undefined && ws.score < 7,
    );
    if (failedWorkstreams.length > 0) {
      const details = failedWorkstreams
        .map((ws) => `${ws.id} (score: ${ws.score})`)
        .join(", ");
      throw new Error(
        `Gate failed: workstreams below threshold (≥7 required): ${details}`,
      );
    }
    const unscoredWorkstreams = session.workstreams.filter(
      (ws) => ws.score === undefined,
    );
    if (session.workstreams.length > 0 && unscoredWorkstreams.length > 0) {
      throw new Error(
        `Gate incomplete: workstreams without scores: ${unscoredWorkstreams.map((ws) => ws.id).join(", ")}`,
      );
    }
  }

  // Advance
  const nextIndex = currentIndex + 1;
  if (nextIndex >= session.phases.length) {
    throw new Error(
      `Cannot advance: "${currentPhase.name}" is the final phase of tier "${session.tier}".`,
    );
  }

  session.currentPhaseIndex = nextIndex;
  return session.phases[nextIndex];
}

// ── Tier Auto-Selection ────────────────────────────────────────────────

export function selectTier(taskDescription: string, fileCount?: number): Tier {
  const lower = taskDescription.toLowerCase();

  if (fileCount !== undefined && fileCount > 50) return "blitz";
  if (/massive|full app|entire codebase/.test(lower)) return "blitz";

  if (/debate|decide|which approach|tradeoff/.test(lower)) return "debate";

  if (
    /unleashed|max|pedal to the metal|no restraints|hurt|pain|destroy/.test(
      lower,
    )
  )
    return "unleashed";

  if (/refactor|security|architecture|complex/.test(lower)) return "full-swarm";

  if (/design|multi-file|feature/.test(lower)) return "trio";

  return "duo";
}

// ── Anonymous History Builder ──────────────────────────────────────────

export function buildAnonymousHistory(
  session: SwarmSession,
  forWorkstream?: string,
): string {
  const lines: string[] = [];
  const currentRound =
    session.rounds.length > 0
      ? Math.max(...session.rounds.map((r) => r.round))
      : 0;

  lines.push(
    `=== SWARM CONTEXT (Tier: ${session.tier}, Round: ${currentRound}) ===`,
  );
  lines.push(`TASK: ${session.task}`);
  lines.push("");

  // Filter history for the target workstream if specified
  const relevantHistory = session.history.filter((entry) => {
    if (!forWorkstream) return true;
    return (
      entry.content.includes(forWorkstream) ||
      !entry.content.includes("workstream:")
    );
  });

  for (const entry of relevantHistory) {
    lines.push(`--- ${entry.phase.toUpperCase()} (Round ${entry.round}) ---`);
    lines.push(entry.content);
    lines.push("");
  }

  // Add scores if available
  const relevantRounds = forWorkstream
    ? session.rounds.filter((r) => r.workstream === forWorkstream)
    : session.rounds;

  if (relevantRounds.length > 0) {
    lines.push("--- SCORES ---");
    for (const r of relevantRounds) {
      lines.push(
        `Round ${r.round} | Workstream: ${r.workstream} | Score: ${r.score}/10 | Critical Issues: ${r.criticalIssues}`,
      );
    }
    lines.push("");
  }

  lines.push("--- YOUR OUTPUT ---");
  lines.push(
    "A contributor completed the prior phases above. Build on their work. " +
      "Do not reference specific contributors or models. " +
      "Focus on improving quality and addressing any identified issues.",
  );

  return lines.join("\n");
}

// ── Identity Stripping ────────────────────────────────────────────────

export function stripIdentity(text: string): string {
  if (!text) return "";
  // Remove ANSI codes
  const noAnsi = text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
  // Remove model names
  return noAnsi
    .replace(/claude[-\s]?\w+/gi, "a contributor")
    .replace(/gpt[-\s]?\w+/gi, "a contributor")
    .replace(/opus|sonnet|haiku|codex/gi, "contributor")
    .replace(/gemini[-\s]?\w+/gi, "a contributor")
    .replace(/agent[_-]?\d+/gi, "a contributor")
    .replace(/workstream[_-]?\d+/gi, "workstream")
    .replace(/ws-\d+/gi, "workstream");
}

// ── Prompt Store ──────────────────────────────────────────────────────
// Store prompts server-side so the orchestrator LLM doesn't have to
// re-serialize massive prompts in its tool call output (causes truncation).

let promptCounter = 0;

export function storePrompt(session: SwarmSession, prompt: string): string {
  const ref = `prompt-${++promptCounter}`;
  session.promptStore.set(ref, prompt);
  return ref;
}

export function getPrompt(
  session: SwarmSession,
  ref: string,
): string | undefined {
  return session.promptStore.get(ref);
}

// ── Board Operations ──────────────────────────────────────────────────

export function postToBoard(
  session: SwarmSession,
  workstream: string,
  type: BoardMessage["type"],
  content: string,
  level: BoardMessage["level"] = "L3",
  group?: string,
  debateId?: string,
): BoardMessage {
  const msg: BoardMessage = {
    workstream,
    type,
    level,
    group,
    debateId,
    content: stripIdentity(content),
    timestamp: Date.now(),
  };
  session.board.push(msg);
  return msg;
}

export function readBoard(
  session: SwarmSession,
  forWorkstream?: string,
  types?: BoardMessage["type"][],
): BoardMessage[] {
  let messages = session.board;
  // Exclude own messages (anonymous — you don't see your own posts labeled)
  if (forWorkstream) {
    messages = messages.filter((m) => m.workstream !== forWorkstream);
  }
  if (types && types.length > 0) {
    messages = messages.filter((m) => types.includes(m.type));
  }
  return messages;
}

export function buildBoardContext(
  session: SwarmSession,
  forWorkstream: string,
  relevantWorkstreams?: string[], // WS4a: scope to assigned workstreams
): string {
  const messages = readBoard(session, forWorkstream);
  if (messages.length === 0) return "";

  const lines: string[] = ["", "--- FINDINGS FROM OTHER WORKSTREAMS ---"];
  for (const msg of messages) {
    if (relevantWorkstreams && relevantWorkstreams.length > 0) {
      const isRelevant = relevantWorkstreams.includes(msg.workstream);
      if (!isRelevant) {
        // Skip "finding" type from non-assigned workstreams entirely
        if (msg.type === "finding") continue;
        // For other types, include only a 1-line summary
        const preview = msg.content.substring(0, 80);
        const suffix = msg.content.length > 80 ? "..." : "";
        lines.push(`[${msg.workstream}] ${msg.type}: ${preview}${suffix}`);
        continue;
      }
    }
    lines.push(`[${msg.type.toUpperCase()}] ${msg.content}`);
  }
  lines.push("--- END FINDINGS ---");
  lines.push("");
  return lines.join("\n");
}

export function getReadyWorkstreams(session: SwarmSession): Workstream[] {
  return session.workstreams.filter((ws) => {
    if (ws.status !== "pending" && ws.status !== "ready") return false;
    // Check all dependencies are done
    const depsReady = ws.dependencies.every((depId) => {
      const dep = session.workstreams.find((w) => w.id === depId);
      return dep && dep.status === "done";
    });
    if (depsReady) ws.status = "ready";
    return depsReady;
  });
}

export function getBlockedWorkstreams(session: SwarmSession): Workstream[] {
  return session.workstreams.filter((ws) => {
    if (ws.status !== "pending") return false;
    return ws.dependencies.some((depId) => {
      const dep = session.workstreams.find((w) => w.id === depId);
      return !dep || dep.status !== "done";
    });
  });
}

// ── 3-Tier Hierarchy: Grouping & Manager Assignment ───────────────────
// L1 orchestrator dispatches L2 managers (not L3 workers).
// Each L2 manager gets a group of workstreams and spawns its own L3 workers.
// Manager models differ from their worker models for provider diversity.
// All model assignments go through resolveModel() for automatic fallback.

const MANAGER_AGENT_DEFS: Array<{
  agent: string;
  model: string;
  provider: string;
}> = [
  {
    agent: "manager-anthropic",
    model: "claude-sonnet-4.6",
    provider: "anthropic",
  },
];

/** Get a validated manager definition — resolves model with fallback */
function getValidManagerDef(index: number): {
  agent: string;
  model: string;
  provider: string;
} {
  const def = MANAGER_AGENT_DEFS[index % MANAGER_AGENT_DEFS.length];
  const resolved = resolveModel(def.model);
  const resolvedProvider = getModelProvider(resolved);
  // If model fell back to different provider, update agent name to match
  const agent =
    resolvedProvider !== "unknown" ? getManagerAgentName(resolved) : def.agent;
  return {
    agent,
    model: resolved,
    provider: resolvedProvider !== "unknown" ? resolvedProvider : def.provider,
  };
}

// Workers assigned to each manager should use DIFFERENT providers than the manager
function getWorkerModelsForManager(
  managerProvider: string,
  workerCount: number,
): string[] {
  const otherModels = coderPool.filter((m) => {
    const entry = availableModels.find((am) => am.id === m);
    return entry && entry.provider !== managerProvider;
  });
  const allModels = otherModels.length > 0 ? otherModels : coderPool;
  const result: string[] = [];
  for (let i = 0; i < workerCount; i++) {
    // Resolve each worker model through fallback system
    result.push(resolveModel(allModels[i % allModels.length]));
  }
  return result;
}

export function getManagerAgentName(modelId: string): string {
  const provider = getModelProvider(modelId);
  switch (provider) {
    case "anthropic":
      return "manager-anthropic";
    case "openai":
      return "manager-openai";
    case "google":
      return "manager-gemini";
    default:
      return "manager-anthropic";
  }
}

export function getWorkerAgentName(modelId: string): string {
  const provider = getModelProvider(modelId);
  switch (provider) {
    case "anthropic":
      return "worker-anthropic";
    case "openai":
      return "worker-openai";
    case "google":
      return "worker-gemini";
    default:
      return "worker";
  }
}

/**
 * Get the role-specific agent name for a worker.
 * If a role-specific agent config exists (e.g., worker-coder, worker-tester),
 * prefer it. Otherwise fall back to provider-based agent name.
 */
export function getRoleAgentName(role: WorkerRole, modelId: string): string {
  // Role-specific agents take priority when available
  const roleAgents: Record<WorkerRole, string> = {
    coder: "worker-coder",
    tester: "worker-tester",
    reviewer: "worker", // reviewers use generic + critic model
    security: "worker-security",
    architect: "worker-architect",
    documenter: "worker-documenter",
    debugger: "worker-debugger",
    devops: "worker", // uses generic worker (no dedicated agent yet)
    "meta-worker": "worker", // meta-workers use generic + special permissions
  };
  return roleAgents[role] ?? getWorkerAgentName(modelId);
}

/**
 * Classify a task description into a complexity level.
 * Used by L2 managers to route tasks to appropriate worker pools.
 */
export function classifyTaskComplexity(
  description: string,
  files: string[],
): TaskComplexity {
  const lower = description.toLowerCase();

  // Review tasks
  if (/\breview\b|\baudit\b|\bcheck\b|\binspect\b|\bvalidate\b/.test(lower)) {
    return "review";
  }

  // Complex: security, architecture, multi-system, performance
  if (
    /\bsecurity\b|\bvulnerab|\barchitect|\bdesign\b|\bscalabil|\bperformance\b|\bmigrat|\brefactor\b/.test(
      lower,
    )
  ) {
    return "complex";
  }

  // Complex: many files or cross-cutting concerns
  if (files.length > 5) {
    return "complex";
  }

  // Trivial: docs, renames, config, simple updates
  if (
    /\bdoc\b|\breadme\b|\bcomment\b|\brename\b|\bconfig\b|\bformat\b|\btypo\b|\bfix\s+typo\b/.test(
      lower,
    )
  ) {
    return "trivial";
  }

  // Standard: everything else (feature impl, bug fixes, etc.)
  return "standard";
}

/**
 * Infer the best worker role for a task based on its description.
 */
export function inferWorkerRole(description: string): WorkerRole {
  const lower = description.toLowerCase();

  if (
    /\btest\b|\bspec\b|\bcoverage\b|\bunit test\b|\bintegration test\b/.test(
      lower,
    )
  )
    return "tester";
  if (/\breview\b|\baudit\b|\bcode review\b|\bquality\b/.test(lower))
    return "reviewer";
  if (
    /\bsecurity\b|\bvulnerab|\bauth\b|\bencrypt\b|\bsanitiz|\binjection\b/.test(
      lower,
    )
  )
    return "security";
  if (
    /\barchitect|\bdesign\b|\bapi contract\b|\bschema\b|\bdata model\b/.test(
      lower,
    )
  )
    return "architect";
  if (/\bdoc\b|\breadme\b|\bchangelog\b|\bcomment\b|\bdiagram\b/.test(lower))
    return "documenter";
  if (
    /\bdebug\b|\broot cause\b|\bbisect\b|\breproducg?\b|\bstack trace\b|\bfix\b.*\bbug\b/.test(
      lower,
    )
  )
    return "debugger";
  if (
    /\bdeploy\b|\bci\/cd\b|\bdocker\b|\bpipeline\b|\binfra\b|\bterraform\b/.test(
      lower,
    )
  )
    return "devops";

  return "coder"; // default role
}

/**
 * Get the model pool appropriate for a task complexity level.
 */
export function getModelForComplexity(
  complexity: TaskComplexity,
  index: number,
): string {
  switch (complexity) {
    case "trivial":
      return getFastModel(index);
    case "standard":
      return getCoderModel(index);
    case "complex":
      return premiumPool.length > 0
        ? premiumPool[index % premiumPool.length]
        : getCoderModel(index);
    case "review":
      return getCriticModel(index);
  }
}

/**
 * Group workstreams into L2 agent groups.
 * Target: 2-4 workers per manager. Managers rotate across providers.
 */
export function groupWorkstreams(session: SwarmSession): AgentGroup[] {
  const wsCount = session.workstreams.length;
  if (wsCount === 0) return [];

  // Determine group size: aim for 2-4 workers per manager
  let workersPerGroup: number;
  if (wsCount <= 4) workersPerGroup = 2;
  else if (wsCount <= 12) workersPerGroup = 3;
  else workersPerGroup = 4; // 32 ws → 8 groups of 4

  const groupCount = Math.ceil(wsCount / workersPerGroup);
  const groups: AgentGroup[] = [];

  for (let g = 0; g < groupCount; g++) {
    const managerDef = getValidManagerDef(g);
    const startIdx = g * workersPerGroup;
    const endIdx = Math.min(startIdx + workersPerGroup, wsCount);
    const groupWorkstreams = session.workstreams.slice(startIdx, endIdx);

    const workerModels = getWorkerModelsForManager(
      managerDef.provider,
      groupWorkstreams.length,
    );

    const workerSlots: WorkerSlot[] = groupWorkstreams.map((ws, i) => {
      const role = inferWorkerRole(ws.description);
      const complexity = classifyTaskComplexity(ws.description, ws.files);
      const model = resolveModel(getModelForComplexity(complexity, i));
      return {
        workstreamId: ws.id,
        agentType: getRoleAgentName(role, model),
        model,
        description: ws.description,
        files: ws.files,
        role,
        mode: "implement" as WorkerMode,
        complexity,
      };
    });

    groups.push({
      id: `group-${g}`,
      managerAgent: managerDef.agent,
      managerModel: managerDef.model,
      workerSlots,
      plan: "",
      status: "pending",
    });
  }

  session.agentGroups = groups;
  return groups;
}

/**
 * Build the L2 manager prompt. Includes:
 * - Domain/workstreams owned
 * - Worker agent specs (who to spawn)
 * - Board context from other L2 groups (inter-team communication, blue lines)
 * - Intra-team communication protocol (L3↔L3 via shared scratch dir)
 * - Escalation protocol (debates → L1 boss)
 */
export function buildManagerPrompt(
  session: SwarmSession,
  group: AgentGroup,
  phaseName: string,
  history: string,
): string {
  // WS4b: Collect the manager's assigned workstream IDs to scope board context
  const assignedWorkstreamIds = group.workerSlots.map((ws) => ws.workstreamId);

  // WS4c: Truncate task description if > 2000 chars
  const taskSpec =
    session.task.length > 2000
      ? session.task.substring(0, 2000) +
        "\n[Task truncated — full spec available via board messages]"
      : session.task;

  // WS4: Use buildBoardContext scoped to this manager's assigned workstreams
  const boardCtxRaw = buildBoardContext(
    session,
    group.id,
    assignedWorkstreamIds,
  );
  const crossGroupCtx = boardCtxRaw.trim() || "No cross-group messages yet.";

  const workerSpecs = group.workerSlots
    .map((ws, i) => {
      const filesStr =
        ws.files.length > 0 ? `Files: ${ws.files.join(", ")}` : "Files: TBD";
      return `  Worker ${i}: subagent_type="${ws.agentType}" | Workstream: ${ws.workstreamId} | ${ws.description} | ${filesStr}`;
    })
    .join("\n");

  const scratchDir = `${session.outputDir}/${group.id}`;
  const statusFile = `${session.outputDir}/${group.id}-status.md`;
  const statusBoard = `${session.outputDir}/status-board.md`;

  return [
    history,
    "",
    "═══════════════════════════════════════════════════════════════",
    `YOUR ROLE: L2 AGENT MANAGER — ${group.id}`,
    `PHASE: ${phaseName}`,
    "═══════════════════════════════════════════════════════════════",
    "",
    "## TASK",
    taskSpec,
    "",
    "## HIERARCHY",
    "```",
    "L1 Orchestrator (the boss — makes strategic decisions, resolves debates)",
    `  └── YOU: L2 Manager [${group.id}] (plan, delegate, coordinate, report)`,
    group.workerSlots
      .map(
        (ws, i) =>
          `        └── L3 Worker ${i} [${ws.workstreamId}] (${ws.agentType})`,
      )
      .join("\n"),
    "```",
    "",
    "## YOUR TEAM",
    workerSpecs,
    "",
    "## COMMUNICATION CHANNELS",
    "",
    "### COMMUNICATION RULES",
    "```",
    "L1 ↔ L2: You talk to the orchestrator (boss) via the board     ✅",
    "L2 ↔ L2: You talk to OTHER managers via the board              ✅",
    "L2 → L3: You direct workers via task() prompts                 ✅",
    "L3 → L2: Workers report TO YOU via the board                   ✅",
    "L3 ✗ L3: Workers NEVER talk directly to other workers          🚫",
    "```",
    "",
    "### 🔴 THE BOARD — Your primary communication channel",
    `Session ID: ${session.id}`,
    `Your Group: ${group.id}`,
    "",
    "**All communication flows through the board.** Not status files, not scratch dirs.",
    "",
    "#### Posting to the board (you → everyone)",
    "```",
    `swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    '  type="<plan|finding|status|blocker|report>", content="<message>")',
    "```",
    "",
    "Post types:",
    "  - **plan**: Post your plan BEFORE dispatching workers (so other managers see it)",
    "  - **finding**: Discovery that other managers should know about",
    "  - **status**: Progress update for the boss",
    "  - **blocker**: Something blocking your work — boss needs to decide",
    "  - **report**: Your final synthesized report",
    "",
    "#### Reading the board (everyone → you)",
    "```",
    `swarm_board(sessionId="${session.id}")                     // Everything`,
    `swarm_board(sessionId="${session.id}", level="L2")         // Other managers' posts`,
    `swarm_board(sessionId="${session.id}", level="L3", group="${group.id}")  // YOUR workers' posts`,
    `swarm_board(sessionId="${session.id}", level="L1")         // Boss directives/decisions`,
    "```",
    "",
    "#### 🔵 Cross-team context (from other L2 managers so far)",
    crossGroupCtx,
    "",
    "### 📡 WORKER COMMUNICATION PROTOCOL",
    "When you dispatch workers, COPY-PASTE this EXACT block into EVERY worker prompt:",
    "```",
    "╔══════════════════════════════════════════════════════════╗",
    `║ SESSION_ID = "${session.id}"`,
    `║ GROUP_ID = "${group.id}"`,
    '║ WORKSTREAM_ID = "<FILL IN THE WORKER\'S WS ID>"',
    "╚══════════════════════════════════════════════════════════╝",
    "",
    "BOARD COMMANDS — use these EXACTLY as written:",
    "",
    "Read board:",
    `  swarm_board(sessionId="${session.id}", level="L2", group="${group.id}")`,
    "",
    "Post finding:",
    `  swarm_relay(sessionId="${session.id}", workstream="<WORKSTREAM_ID>", level="L3", group="${group.id}", type="finding", content="<message>")`,
    "",
    "Post blocker:",
    `  swarm_relay(sessionId="${session.id}", workstream="<WORKSTREAM_ID>", level="L3", group="${group.id}", type="blocker", content="<message>")`,
    "```",
    "",
    '⚠️ CRITICAL: The sessionId is "' +
      session.id +
      '". Workers MUST use this EXACT string.',
    'DO NOT let workers invent session IDs like "workstream2-session" or "SESSION_ID_PLACEHOLDER".',
    "",
    "Tell each worker:",
    "1. **At start**: Read the board for manager directives",
    "2. **During work**: Post findings/status to the board",
    "3. **If blocked**: Post a blocker, then continue with best judgment",
    "4. **On completion**: Post final status to the board",
    "5. **NEVER** communicate directly with other workers. ALL goes through you.",
    "",
    "### 🔁 MANAGER POLLING — READ THE BOARD BETWEEN BATCHES",
    "After dispatching each batch of workers, CHECK THE BOARD before dispatching the next:",
    "```",
    `// Check for worker questions/blockers`,
    `swarm_board(sessionId="${session.id}", level="L3", group="${group.id}")`,
    `// Check for cross-team findings from other managers`,
    `swarm_board(sessionId="${session.id}", level="L2")`,
    `// Check for boss directives`,
    `swarm_board(sessionId="${session.id}", level="L1")`,
    "```",
    "If a worker posted a question/blocker, answer it by posting a decision:",
    `swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    '  type="decision", content="RE: <worker question> — <your answer>")',
    "",
    "### ⚠️ Escalation (debates → L1 boss)",
    "If your workers disagree and you CANNOT resolve it:",
    "  - Do NOT guess. Post a blocker to the board.",
    `  - swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2",`,
    '    type="blocker", content="ESCALATION: <describe the disagreement>")',
    "  - The L1 orchestrator will read the board and make the call.",
    "",
    "### 🔥 Structured Debate Protocol (for worker disagreements)",
    "If your workers produce CONFLICTING outputs that you cannot easily resolve:",
    "",
    "1. DO NOT guess or pick one arbitrarily",
    `2. Call swarm_debate(action="start", sessionId="${session.id}", groupId="${group.id}",`,
    '   topic="<what they disagree on>", trigger="disagreement")',
    "3. The server will set up a structured debate between workers",
    '4. Call swarm_debate(action="next", debateId=<returned id>) to get debate phase prompts',
    "5. Dispatch workers with the debate prompts (parallel)",
    '6. Submit their outputs via swarm_debate(action="submit", debateId=<id>, slotId=<slot>, content=<output>)',
    '7. Call swarm_debate(action="evaluate", debateId=<id>) for convergence check',
    '8. If converged → call swarm_debate(action="synthesize"); if stalled → escalate to L1',
    "",
    "When to trigger debate:",
    "  - Workers propose incompatible approaches to the same problem",
    "  - Quality scores diverge significantly (>3 point gap)",
    "  - Workers flag contradictory findings about the codebase",
    "  - Your workstream assignment is tagged as debate-type",
    "",
    "The debate protocol ensures adversarial critique yields higher accuracy than",
    "collaborative consensus (Agent-Skills: multi-agent-patterns §Debate Protocols).",
    "",
    "## EXECUTION PROTOCOL",
    "",
    `1. SETUP: mkdir -p ${scratchDir}`,
    `   Post your plan to the board:`,
    `   swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    `     type="plan", content="<how you're splitting work across workers>")`,
    "",
    "2. CHECK THE BOARD for cross-team context and boss directives:",
    `   swarm_board(sessionId="${session.id}", level="L2")  // other managers`,
    `   swarm_board(sessionId="${session.id}", level="L1")  // boss directives`,
    "",
    "3. PLAN: Analyze the task. Decide how to split work across your workers.",
    "",
    "4. DISPATCH WORKERS IN STAGGERED BATCHES (GitHub Copilot rate limits):",
    "   ⚠️ Do NOT launch all workers at once — this will trigger API rate limiting.",
    "   Launch in batches of 2, with a sleep between batches:",
    "   ```",
    "   # Batch 1 — launch 2 workers in same message",
    '   task(subagent_type="<agent>", description="<task>", prompt="<instructions>")',
    '   task(subagent_type="<agent>", description="<task>", prompt="<instructions>")',
    "   # Wait for rate limit cooldown",
    '   bash("sleep 8")',
    "   ```",
    "   In each worker prompt, ALWAYS include:",
    `   - SESSION_ID: ${session.id}`,
    `   - GROUP_ID: ${group.id}`,
    "   - WORKSTREAM_ID: <their workstream id>",
    "   - Their specific assignment and files",
    "   - The communication protocol (swarm_relay/swarm_board instructions above)",
    "",
    "5. BETWEEN BATCHES — POLL THE BOARD:",
    `   swarm_board(sessionId="${session.id}", level="L3", group="${group.id}")  // worker posts`,
    `   swarm_board(sessionId="${session.id}", level="L2")  // other managers`,
    "   Answer any worker questions. Incorporate cross-team findings.",
    "   Adjust remaining worker dispatches based on new context.",
    "",
    "6. REVIEW & COORDINATE:",
    "   - Check each worker's output for quality",
    "   - If workers conflict: resolve it yourself OR re-dispatch with clarification",
    "   - If a debate is unresolvable: post BLOCKER to board for L1",
    "",
    "7. SYNTHESIZE & REPORT:",
    "   Post final report to the board:",
    `   swarm_relay(sessionId="${session.id}", workstream="${group.id}", level="L2", group="${group.id}",`,
    '     type="report", content="<your full report below>")',
    "",
    "   Then return the report in this EXACT format:",
    "",
    "## Plan",
    "<how you divided work across your team>",
    "",
    "## Results",
    "<synthesized deliverable from all workers>",
    "",
    "## Team Coordination",
    "<how workers communicated, conflicts resolved>",
    "",
    "## Issues",
    "<problems found, blockers hit>",
    "",
    "## Escalations",
    "<NONE or unresolved debates that need L1 boss decision>",
    "",
    "## Cross-Team Notes",
    "<things other L2 managers should know about your work>",
    "",
    "─── CRITICAL: DO NOT DO THE WORK YOURSELF ───",
    "You are a manager. Spawn workers. Only touch code to resolve worker conflicts.",
    "",
    "─── WS3b: TEST SUITE REQUIREMENT ───",
    "BEFORE reporting completion, run the project's test suite if one exists:",
    "  - Python: pytest --tb=short -q",
    "  - Node:   npm test",
    "  - Go:     go test ./...",
    "Report test results in your completion report. If tests fail, fix them before submitting.",
  ].join("\n");
}

// ── Debate Protocol Helpers ───────────────────────────────────────────
// Implements structured multi-round debate at any hierarchy level.
// Based on Agent-Skills multi-agent-patterns: debate protocols, adversarial
// critique, weighted voting, and sycophancy detection.

let debateCounter = 0;

export function generateDebateId(): string {
  return `debate-${++debateCounter}`;
}

/**
 * Get a debate-appropriate model. Ensures provider diversity among debaters.
 * For L2-level debates, uses workers from the manager's group.
 * For L1-level debates, uses standard-tier models from the coder pool.
 */
export function getDebaterModel(
  index: number,
  groupId: string | undefined,
  session: SwarmSession,
): string {
  if (groupId) {
    const group = session.agentGroups.find((g) => g.id === groupId);
    if (group && index < group.workerSlots.length) {
      return group.workerSlots[index].model;
    }
  }
  return getCoderModel(index);
}

/**
 * Get the agent type for a debate participant.
 */
export function getDebaterAgentType(
  index: number,
  groupId: string | undefined,
  session: SwarmSession,
): string {
  if (groupId) {
    const group = session.agentGroups.find((g) => g.id === groupId);
    if (group && index < group.workerSlots.length) {
      return group.workerSlots[index].agentType;
    }
  }
  return getWorkerAgentName(getCoderModel(index));
}

/**
 * Create a new debate and attach it to the session.
 */
export function createDebate(
  session: SwarmSession,
  topic: string,
  trigger: DebateTrigger,
  groupId?: string,
  participantCount: number = 2,
  maxRounds: number = 3,
): DebateState {
  const id = generateDebateId();
  const initiatorLevel = groupId ? "L2" : "L1";

  const participants: DebateParticipant[] = [];
  for (let i = 0; i < participantCount; i++) {
    const model = getDebaterModel(i, groupId, session);
    const agentType = getDebaterAgentType(i, groupId, session);
    participants.push({
      slotId: `debater-${i}`,
      agentType,
      model,
    });
  }

  const debate: DebateState = {
    id,
    sessionId: session.id,
    groupId,
    topic,
    trigger,
    initiatorLevel,
    status: "pending",
    participants,
    rounds: [],
    currentRound: 0,
    maxRounds,
    convergenceThreshold: 0.7,
    sycophancyThreshold: 0.85,
    minPositionScore: 6,
    fastTrack: false,
    claims: [],
    createdAt: Date.now(),
  };

  session.debates.push(debate);
  return debate;
}

/**
 * Get a debate by ID from a session.
 */
export function getDebate(
  session: SwarmSession,
  debateId: string,
): DebateState | undefined {
  return session.debates.find((d) => d.id === debateId);
}

/**
 * Advance a debate to the next phase within a round, or start a new round.
 * Returns the current phase and what prompts to generate.
 */
export function advanceDebatePhase(debate: DebateState): {
  phase: DebatePhase;
  round: number;
  isNewRound: boolean;
} {
  const currentRound = debate.rounds[debate.rounds.length - 1];

  if (!currentRound || currentRound.completedAt) {
    // Start a new round
    const roundNumber = debate.currentRound + 1;
    debate.currentRound = roundNumber;
    const newRound: DebateRound = {
      roundNumber,
      phase: "position",
      contributions: [],
      startedAt: Date.now(),
    };
    debate.rounds.push(newRound);
    debate.status = "active";
    return { phase: "position", round: roundNumber, isNewRound: true };
  }

  // Check what contributions exist for this round to determine next phase
  const positionCount = currentRound.contributions.filter(
    (c) => c.phase === "position",
  ).length;
  const critiqueCount = currentRound.contributions.filter(
    (c) => c.phase === "critique",
  ).length;
  const rebuttalCount = currentRound.contributions.filter(
    (c) => c.phase === "rebuttal",
  ).length;
  const participantCount = debate.participants.length;

  if (positionCount < participantCount) {
    currentRound.phase = "position";
    return { phase: "position", round: debate.currentRound, isNewRound: false };
  }

  // Each participant critiques all OTHER positions
  const expectedCritiques = participantCount * (participantCount - 1);
  if (critiqueCount < expectedCritiques) {
    currentRound.phase = "critique";
    return { phase: "critique", round: debate.currentRound, isNewRound: false };
  }

  if (rebuttalCount < participantCount) {
    currentRound.phase = "rebuttal";
    return { phase: "rebuttal", round: debate.currentRound, isNewRound: false };
  }

  // All contributions collected — ready for evaluation
  currentRound.phase = "evaluation";
  return { phase: "evaluation", round: debate.currentRound, isNewRound: false };
}

/**
 * Build the position prompt for a debate participant.
 * The participant sees the topic and any prior round history (anonymized).
 */
export function buildDebatePositionPrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const priorRounds = debate.rounds.filter((r) => r.completedAt);
  let historySection = "";

  if (priorRounds.length > 0) {
    const roundSummaries = priorRounds.map((r) => {
      const positions = r.contributions
        .filter((c) => c.phase === "position")
        .map(
          (c, i) =>
            `  Position ${i + 1}: ${c.content.substring(0, 500)}${c.content.length > 500 ? "..." : ""}`,
        )
        .join("\n");
      const evalNote = r.evaluation
        ? `  Evaluation: convergence=${(r.evaluation.convergenceScore * 100).toFixed(0)}%, recommendation=${r.evaluation.recommendation}`
        : "";
      return `Round ${r.roundNumber}:\n${positions}\n${evalNote}`;
    });
    historySection = `\n## PRIOR DEBATE ROUNDS (anonymous)\n${roundSummaries.join("\n\n")}\n`;
  }

  return `You are participating in a structured debate. Your role is to present and defend your position.

## DEBATE TOPIC
${debate.topic}

## TASK CONTEXT
${session.task}
${historySection}
## YOUR ASSIGNMENT
Take a clear, well-reasoned POSITION on the topic above.

Requirements:
1. State your position clearly in the first paragraph
2. Provide EVIDENCE (code references, technical reasoning, specific examples)
3. Acknowledge potential counterarguments
4. Be concrete — avoid vague generalities
5. If this is a revision from a prior round, explain what changed and why

FORMAT:
## Position
<your clear position statement>

## Evidence
<specific supporting evidence, code references, technical reasoning>

## Counterarguments Acknowledged
<potential objections you're aware of>

## Confidence
<HIGH/MEDIUM/LOW with brief justification>
`;
}

/**
 * Build the critique prompt for a debate participant.
 * The participant sees OTHER participants' positions (anonymized) and must critique them.
 */
export function buildDebateCritiquePrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const currentRound = debate.rounds[debate.rounds.length - 1];
  const otherPositions = currentRound.contributions
    .filter((c) => c.phase === "position" && c.slotId !== participant.slotId)
    .map((c, i) => `### Anonymous Position ${i + 1}\n${c.content}`)
    .join("\n\n");

  const myPosition = currentRound.contributions.find(
    (c) => c.phase === "position" && c.slotId === participant.slotId,
  );

  return `You are participating in a structured debate. Your role is to CRITIQUE other positions.

## DEBATE TOPIC
${debate.topic}

## YOUR POSITION (for reference)
${myPosition?.content ?? "Not yet submitted"}

## OTHER POSITIONS TO CRITIQUE
${otherPositions}

## YOUR ASSIGNMENT
Critique each position above. Be thorough and adversarial — the goal is to find weaknesses, not to be polite.

Requirements:
1. For EACH position, identify specific weaknesses, gaps, or errors
2. Challenge unsupported claims with "what evidence supports this?"
3. Identify logical fallacies or reasoning gaps
4. Point out missing considerations or edge cases
5. Be specific — reference exact claims from the position
6. Do NOT be sycophantic — genuine disagreement produces better outcomes

FORMAT (for each position):
## Critique of Position N
### Strengths
<what this position gets right>
### Weaknesses
<specific issues, gaps, errors>
### Questions
<what the proponent should address in rebuttal>
`;
}

/**
 * Build the rebuttal prompt for a debate participant.
 * The participant sees critiques of their position and must defend/revise.
 */
export function buildDebateRebuttalPrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const currentRound = debate.rounds[debate.rounds.length - 1];

  const myPosition = currentRound.contributions.find(
    (c) => c.phase === "position" && c.slotId === participant.slotId,
  );

  const critiquesOfMe = currentRound.contributions
    .filter((c) => c.phase === "critique" && c.slotId !== participant.slotId)
    .map((c, i) => {
      // Extract the critique of this participant's position from the full critique
      return `### Critique from Reviewer ${i + 1}\n${c.content}`;
    })
    .join("\n\n");

  return `You are participating in a structured debate. Your role is to DEFEND or REVISE your position.

## DEBATE TOPIC
${debate.topic}

## YOUR ORIGINAL POSITION
${myPosition?.content ?? "Not yet submitted"}

## CRITIQUES OF YOUR POSITION
${critiquesOfMe}

## YOUR ASSIGNMENT
Respond to each critique. You may:
- DEFEND your position with additional evidence if you believe you're correct
- REVISE your position if the critiques raise valid points
- PARTIALLY CONCEDE specific points while defending others

Requirements:
1. Address EVERY critique raised — do not ignore any
2. Provide NEW evidence or reasoning (don't just repeat your original position)
3. Be honest — if a critique is valid, acknowledge it and adjust
4. Show how your revised position is stronger than before
5. Do NOT simply agree to avoid conflict — defend genuinely held views

FORMAT:
## Response to Critiques
<address each critique point by point>

## Revised Position (if changed)
<your updated position, or state "Position unchanged" with reasoning>

## Key Insight from Debate
<what you learned from the critiques, even if you disagree>

## Final Confidence
<HIGH/MEDIUM/LOW — may differ from original>
`;
}

/**
 * Build the synthesis prompt for the debate moderator.
 */
export function buildDebateSynthesisPrompt(
  debate: DebateState,
  session: SwarmSession,
): string {
  const roundSummaries = debate.rounds
    .map((r) => {
      const positions = r.contributions
        .filter((c) => c.phase === "position")
        .map(
          (c, i) =>
            `  Position ${i + 1} (${c.score ? `score: ${c.score.total}/11` : "unscored"}): ${c.content.substring(0, 800)}`,
        )
        .join("\n");
      const rebuttals = r.contributions
        .filter((c) => c.phase === "rebuttal")
        .map((c, i) => `  Rebuttal ${i + 1}: ${c.content.substring(0, 500)}`)
        .join("\n");
      const evalNote = r.evaluation
        ? `  Evaluation: convergence=${(r.evaluation.convergenceScore * 100).toFixed(0)}%, sycophancy=${(r.evaluation.sycophancyScore * 100).toFixed(0)}%, recommendation=${r.evaluation.recommendation}`
        : "";
      return `### Round ${r.roundNumber}\nPositions:\n${positions}\nRebuttals:\n${rebuttals}\n${evalNote}`;
    })
    .join("\n\n");

  const lastEval = debate.rounds[debate.rounds.length - 1]?.evaluation;

  return `You are the DEBATE SYNTHESIZER. Produce the final decision from the debate.

## DEBATE TOPIC
${debate.topic}

## TASK CONTEXT
${session.task}

## DEBATE HISTORY
${roundSummaries}

## LAST EVALUATION
${
  lastEval
    ? `Convergence: ${(lastEval.convergenceScore * 100).toFixed(0)}%
Dominant position: ${lastEval.dominantPosition ?? "none"}
Recommendation: ${lastEval.recommendation}
Reasoning: ${lastEval.reasoning}`
    : "No evaluation available"
}

## YOUR ASSIGNMENT
Synthesize the debate into a FINAL DECISION. You are not picking a winner — you are producing the best answer informed by all perspectives.

Requirements:
1. State the final position clearly
2. Explain which arguments from each side influenced the decision
3. Address the strongest counterargument that was raised
4. Include confidence level and any caveats
5. If positions were irreconcilable, explain the trade-off being made

FORMAT:
## Final Decision
<the synthesized position>

## Reasoning
<how you arrived at this, which arguments were most persuasive>

## Incorporated from Each Side
<specific insights from each debater that made it into the final decision>

## Caveats
<conditions under which a different decision might be appropriate>

## Confidence: <HIGH/MEDIUM/LOW>
`;
}

/**
 * Build the escalation context for sending a stalled debate to the parent level.
 */
export function buildEscalationContext(
  debate: DebateState,
  session: SwarmSession,
): string {
  const roundSummaries = debate.rounds
    .map((r) => {
      const positions = r.contributions
        .filter((c) => c.phase === "position")
        .map((c, i) => `  Position ${i + 1}: ${c.content.substring(0, 600)}`)
        .join("\n");
      const evalNote = r.evaluation
        ? `  Convergence: ${(r.evaluation.convergenceScore * 100).toFixed(0)}%, Sycophancy: ${(r.evaluation.sycophancyScore * 100).toFixed(0)}%, Recommendation: ${r.evaluation.recommendation}`
        : "";
      return `Round ${r.roundNumber}:\n${positions}\n${evalNote}`;
    })
    .join("\n\n");

  return `## ESCALATED DEBATE: ${debate.topic}
Debate ID: ${debate.id}
Group: ${debate.groupId ?? "L1-level"}
Trigger: ${debate.trigger}
Rounds completed: ${debate.currentRound}/${debate.maxRounds}
Status: ${debate.status}

### Debate Summary
${roundSummaries}

### Why Escalated
${debate.rounds[debate.rounds.length - 1]?.evaluation?.reasoning ?? "Max rounds exceeded without convergence"}

### What is needed
A decision from the L1 orchestrator on which approach to take, or a directive to modify the approach entirely.
`;
}

/**
 * Score debate positions using structural heuristics.
 * Fast server-side scoring without LLM calls.
 */
export function scoreDebatePositions(
  round: DebateRound,
  debate: DebateState,
): DebatePositionScore[] {
  return debate.participants.map((participant) => {
    const position = round.contributions.find(
      (c) => c.slotId === participant.slotId && c.phase === "position",
    );
    const rebuttal = round.contributions.find(
      (c) => c.slotId === participant.slotId && c.phase === "rebuttal",
    );
    const critiquesReceived = round.contributions.filter(
      (c) => c.phase === "critique" && c.slotId !== participant.slotId,
    );

    // Evidence: presence of specific markers (code blocks, numbers, file refs)
    const evidenceMarkers =
      (position?.content ?? "").match(
        /```|`[^`]+`|\d+\.\d+|\bfile\b|\bline\b|\bfunction\b|\bclass\b|\bmodule\b/gi,
      ) ?? [];
    const evidenceQuality = Math.min(3, Math.floor(evidenceMarkers.length / 2));

    // Reasoning: structured arguments
    const reasoningMarkers =
      (position?.content ?? "").match(
        /\bbecause\b|\btherefore\b|\bhowever\b|\bif\b.*\bthen\b|\bconsequently\b|\bthus\b|\bin contrast\b|\bon the other hand\b/gi,
      ) ?? [];
    const reasoningClarity = Math.min(
      3,
      Math.floor(reasoningMarkers.length / 1.5),
    );

    // Rebuttal effectiveness: did they address the critiques?
    const addressedCount = critiquesReceived.filter((critique) => {
      const keywords = critique.content
        .split(/\s+/)
        .filter((w) => w.length > 5)
        .slice(0, 5);
      return keywords.some((kw) =>
        (rebuttal?.content ?? "").toLowerCase().includes(kw.toLowerCase()),
      );
    }).length;
    const rebuttalEffectiveness =
      critiquesReceived.length > 0
        ? Math.min(
            3,
            Math.round((addressedCount / critiquesReceived.length) * 3),
          )
        : 1;

    // Novelty: unique terms not in other positions
    const otherContent = round.contributions
      .filter((c) => c.phase === "position" && c.slotId !== participant.slotId)
      .map((c) => c.content.toLowerCase())
      .join(" ");
    const myTerms = new Set(
      (position?.content ?? "").toLowerCase().match(/\b\w{6,}\b/g) ?? [],
    );
    const otherTerms = new Set(otherContent.match(/\b\w{6,}\b/g) ?? []);
    const uniqueTerms = [...myTerms].filter((t) => !otherTerms.has(t));
    const novelContribution = Math.min(2, Math.floor(uniqueTerms.length / 10));

    const total =
      evidenceQuality +
      reasoningClarity +
      rebuttalEffectiveness +
      novelContribution;

    const score: DebatePositionScore = {
      evidenceQuality,
      reasoningClarity,
      rebuttalEffectiveness,
      novelContribution,
      total,
      summary: `${total}/11 — evidence:${evidenceQuality} reasoning:${reasoningClarity} rebuttal:${rebuttalEffectiveness} novelty:${novelContribution}`,
    };

    // Store score on contribution
    if (rebuttal) rebuttal.score = score;
    else if (position) position.score = score;

    return score;
  });
}

/**
 * Compute convergence between debate positions.
 * Measures how similar the positions are becoming across rounds.
 */
export function computeDebateConvergence(debate: DebateState): {
  score: number;
  delta: number;
  trending: "converging" | "diverging" | "stable";
} {
  if (debate.rounds.length === 0) {
    return { score: 0, delta: 0, trending: "stable" };
  }

  const currentRound = debate.rounds[debate.rounds.length - 1];
  const positions = currentRound.contributions.filter(
    (c) => c.phase === "position",
  );
  const rebuttals = currentRound.contributions.filter(
    (c) => c.phase === "rebuttal",
  );

  // Use rebuttals if available (they're revised positions), else use positions
  const finalTexts =
    rebuttals.length > 0
      ? rebuttals.map((c) => c.content.toLowerCase())
      : positions.map((c) => c.content.toLowerCase());

  if (finalTexts.length < 2) {
    return { score: 1, delta: 0, trending: "stable" };
  }

  // Compute pairwise similarity using word overlap (Jaccard-like)
  const wordSets = finalTexts.map((t) => new Set(t.match(/\b\w{4,}\b/g) ?? []));
  let totalSimilarity = 0;
  let pairCount = 0;

  for (let i = 0; i < wordSets.length; i++) {
    for (let j = i + 1; j < wordSets.length; j++) {
      const intersection = [...wordSets[i]].filter((w) => wordSets[j].has(w));
      const union = new Set([...wordSets[i], ...wordSets[j]]);
      const similarity = union.size > 0 ? intersection.length / union.size : 0;
      totalSimilarity += similarity;
      pairCount++;
    }
  }

  const currentScore = pairCount > 0 ? totalSimilarity / pairCount : 0;

  // Compute delta from previous round
  let previousScore = 0;
  if (debate.rounds.length >= 2) {
    const prevRound = debate.rounds[debate.rounds.length - 2];
    const prevTexts = prevRound.contributions
      .filter((c) => c.phase === "rebuttal" || c.phase === "position")
      .map((c) => c.content.toLowerCase());
    const prevWordSets = prevTexts.map(
      (t) => new Set(t.match(/\b\w{4,}\b/g) ?? []),
    );
    let prevTotal = 0;
    let prevPairs = 0;
    for (let i = 0; i < prevWordSets.length; i++) {
      for (let j = i + 1; j < prevWordSets.length; j++) {
        const inter = [...prevWordSets[i]].filter((w) =>
          prevWordSets[j].has(w),
        );
        const uni = new Set([...prevWordSets[i], ...prevWordSets[j]]);
        prevTotal += uni.size > 0 ? inter.length / uni.size : 0;
        prevPairs++;
      }
    }
    previousScore = prevPairs > 0 ? prevTotal / prevPairs : 0;
  }

  const delta = currentScore - previousScore;
  const trending: "converging" | "diverging" | "stable" =
    delta > 0.05 ? "converging" : delta < -0.05 ? "diverging" : "stable";

  return {
    score: Math.round(currentScore * 1000) / 1000,
    delta: Math.round(delta * 1000) / 1000,
    trending,
  };
}

/**
 * Detect sycophancy in debate contributions.
 * Sycophancy = agents agreeing without substance, collapsing rebuttals,
 * or mimicking each other's positions without genuine reasoning.
 */
export function detectDebateSycophancy(debate: DebateState): {
  detected: boolean;
  score: number; // 0-1, higher = more sycophantic
  indicators: string[];
} {
  if (debate.rounds.length === 0) {
    return { detected: false, score: 0, indicators: [] };
  }

  const currentRound = debate.rounds[debate.rounds.length - 1];
  const indicators: string[] = [];
  let sycophancySignals = 0;
  const maxSignals = 5;

  // Signal 1: Rebuttal length collapse (rebuttals much shorter than positions)
  const positions = currentRound.contributions.filter(
    (c) => c.phase === "position",
  );
  const rebuttals = currentRound.contributions.filter(
    (c) => c.phase === "rebuttal",
  );
  if (rebuttals.length > 0 && positions.length > 0) {
    const avgPosLen =
      positions.reduce((s, c) => s + c.content.length, 0) / positions.length;
    const avgRebLen =
      rebuttals.reduce((s, c) => s + c.content.length, 0) / rebuttals.length;
    if (avgRebLen < avgPosLen * 0.3) {
      sycophancySignals++;
      indicators.push(
        `Rebuttal collapse: avg rebuttal ${Math.round(avgRebLen)} chars vs avg position ${Math.round(avgPosLen)} chars`,
      );
    }
  }

  // Signal 2: Agreement markers without substance
  const agreementPatterns =
    /\b(i agree|you're right|good point|fair enough|I concede|valid point|no objection)\b/gi;
  const substantivePatterns =
    /\b(however|but|although|despite|nevertheless|in contrast|my concern|the issue)\b/gi;
  for (const rebuttal of rebuttals) {
    const agreeCount = (rebuttal.content.match(agreementPatterns) ?? []).length;
    const substantiveCount = (rebuttal.content.match(substantivePatterns) ?? [])
      .length;
    if (agreeCount > 2 && substantiveCount === 0) {
      sycophancySignals++;
      indicators.push(
        `Hollow agreement in ${rebuttal.slotId}: ${agreeCount} agreement markers, 0 substantive markers`,
      );
    }
  }

  // Signal 3: Position convergence without critique integration
  // (positions become identical but critiques were soft)
  const critiques = currentRound.contributions.filter(
    (c) => c.phase === "critique",
  );
  const softCritiquePatterns =
    /\b(minor|small|perhaps|maybe|slightly|could consider)\b/gi;
  const hardCritiquePatterns =
    /\b(wrong|incorrect|fundamentally|critical|major|flawed|broken|impossible)\b/gi;
  let softCount = 0;
  let hardCount = 0;
  for (const critique of critiques) {
    softCount += (critique.content.match(softCritiquePatterns) ?? []).length;
    hardCount += (critique.content.match(hardCritiquePatterns) ?? []).length;
  }
  if (critiques.length > 0 && softCount > hardCount * 3 && hardCount < 2) {
    sycophancySignals++;
    indicators.push(
      `Soft critiques: ${softCount} hedging markers vs ${hardCount} substantive markers`,
    );
  }

  // Signal 4: Cross-round position drift (positions becoming copies of each other)
  if (debate.rounds.length >= 2) {
    const prevPositions = debate.rounds[debate.rounds.length - 2].contributions
      .filter((c) => c.phase === "position")
      .map((c) => new Set(c.content.toLowerCase().match(/\b\w{5,}\b/g) ?? []));
    const currPositions = positions.map(
      (c) => new Set(c.content.toLowerCase().match(/\b\w{5,}\b/g) ?? []),
    );

    // Check if positions are converging toward each other's PREVIOUS content
    if (prevPositions.length >= 2 && currPositions.length >= 2) {
      // Check if position 0 now looks more like prev position 1 (copying)
      const crossSim0to1 = jaccard(
        currPositions[0],
        prevPositions[1] ?? new Set(),
      );
      const crossSim1to0 = jaccard(
        currPositions[1] ?? new Set(),
        prevPositions[0],
      );
      if (crossSim0to1 > 0.6 || crossSim1to0 > 0.6) {
        sycophancySignals++;
        indicators.push(
          `Position mimicry detected: positions copying each other's prior content`,
        );
      }
    }
  }

  // Signal 5: "Position unchanged" without defense
  for (const rebuttal of rebuttals) {
    if (
      /position unchanged/i.test(rebuttal.content) &&
      rebuttal.content.length < 200
    ) {
      sycophancySignals++;
      indicators.push(
        `${rebuttal.slotId} claims position unchanged with minimal defense`,
      );
    }
  }

  const score = Math.min(1, sycophancySignals / maxSignals);
  return {
    detected: score >= debate.sycophancyThreshold,
    score: Math.round(score * 100) / 100,
    indicators,
  };
}

/** Jaccard similarity between two sets */
function jaccard(a: Set<string>, b: Set<string>): number {
  const inter = [...a].filter((x) => b.has(x));
  const union = new Set([...a, ...b]);
  return union.size > 0 ? inter.length / union.size : 0;
}

/**
 * Build the full debate evaluation from scored positions, convergence, and sycophancy.
 */
export function buildDebateEvaluation(
  scores: DebatePositionScore[],
  convergence: ReturnType<typeof computeDebateConvergence>,
  sycophancy: ReturnType<typeof detectDebateSycophancy>,
  debate: DebateState,
): DebateEvaluation {
  const dominantIdx = scores.reduce(
    (best, s, i) => (s.total > scores[best].total ? i : best),
    0,
  );
  const dominantScore = scores[dominantIdx];
  const secondBest =
    scores.length > 1
      ? Math.max(
          ...scores.filter((_, i) => i !== dominantIdx).map((s) => s.total),
        )
      : 0;
  const hasClearWinner = dominantScore.total - secondBest >= 2;

  let recommendation: DebateEvaluation["recommendation"];
  let reasoning: string;

  if (sycophancy.detected) {
    recommendation = "escalate";
    reasoning = `Sycophancy detected (${(sycophancy.score * 100).toFixed(0)}%). Positions are converging without substantive reasoning. Indicators: ${sycophancy.indicators.join("; ")}`;
  } else if (convergence.score >= debate.convergenceThreshold) {
    recommendation = "converged";
    reasoning = `Convergence reached ${(convergence.score * 100).toFixed(0)}% (threshold: ${(debate.convergenceThreshold * 100).toFixed(0)}%). ${hasClearWinner ? `Clear strongest position: debater-${dominantIdx}` : "No dominant position — synthesis needed."}`;
  } else if (debate.currentRound >= debate.maxRounds) {
    recommendation = "stalled";
    reasoning = `Max rounds (${debate.maxRounds}) reached with convergence at ${(convergence.score * 100).toFixed(0)}%. Forcing resolution.`;
  } else if (convergence.trending === "diverging") {
    recommendation = debate.currentRound >= 2 ? "escalate" : "continue";
    reasoning = `Positions are diverging (delta: ${(convergence.delta * 100).toFixed(0)}%). ${debate.currentRound >= 2 ? "Multiple rounds of divergence — escalation recommended." : "One more round may help."}`;
  } else if (convergence.trending === "stable" && debate.currentRound >= 2) {
    recommendation = "stalled";
    reasoning = `No convergence progress after ${debate.currentRound} rounds (stable at ${(convergence.score * 100).toFixed(0)}%).`;
  } else {
    recommendation = "continue";
    reasoning = `Convergence at ${(convergence.score * 100).toFixed(0)}%, trending ${convergence.trending}. More rounds may reach threshold.`;
  }

  return {
    convergenceScore: convergence.score,
    convergenceDelta: convergence.delta,
    sycophancyScore: sycophancy.score,
    positionScores: scores,
    dominantPosition: hasClearWinner
      ? debate.participants[dominantIdx].slotId
      : undefined,
    recommendation,
    reasoning,
    synthesisReady: recommendation === "converged",
  };
}

// ── Partial Consensus: Claim Extraction & Tracking ───────────────────

/**
 * Extract discrete claims from position text.
 * Looks for structured sections (## Position, ## Evidence) and splits into atomic statements.
 */
export function extractClaimsFromPositions(
  debate: DebateState,
  round: DebateRound,
): DebateClaim[] {
  const positions = round.contributions.filter((c) => c.phase === "position");
  const claims: DebateClaim[] = [];
  let claimCounter = debate.claims.length;

  for (const pos of positions) {
    // Split position into sentences/statements, filter short noise
    const statements = pos.content
      .split(/(?<=[.!?\n])\s+/)
      .map((s) => s.trim())
      .filter(
        (s) => s.length > 30 && !s.startsWith("#") && !s.startsWith("```"),
      );

    // Deduplicate: skip if a substantially similar claim already exists
    for (const stmt of statements) {
      const stmtWords = new Set(stmt.toLowerCase().match(/\b\w{5,}\b/g) ?? []);
      const isDuplicate = claims.some((existing) => {
        const existWords = new Set(
          existing.text.toLowerCase().match(/\b\w{5,}\b/g) ?? [],
        );
        return jaccard(stmtWords, existWords) > 0.6;
      });
      if (isDuplicate) continue;

      claims.push({
        id: `claim-${claimCounter++}`,
        text: stmt.substring(0, 300),
        sourceSlot: pos.slotId,
        agreeSlots: [pos.slotId],
        disagreeSlots: [],
        status: "undecided",
        round: round.roundNumber,
      });
    }
  }

  return claims;
}

/**
 * Update claim agreement based on rebuttals and critiques.
 * Scans rebuttal text for references to existing claims — agreement or disagreement.
 */
export function updateClaimConsensus(
  debate: DebateState,
  round: DebateRound,
): void {
  const rebuttals = round.contributions.filter((c) => c.phase === "rebuttal");
  const critiques = round.contributions.filter((c) => c.phase === "critique");
  const allResponses = [...rebuttals, ...critiques];

  for (const claim of debate.claims) {
    const claimWords = new Set(
      claim.text.toLowerCase().match(/\b\w{5,}\b/g) ?? [],
    );

    for (const response of allResponses) {
      if (
        claim.agreeSlots.includes(response.slotId) ||
        claim.disagreeSlots.includes(response.slotId)
      ) {
        continue; // Already tracked
      }

      const responseWords = new Set(
        response.content.toLowerCase().match(/\b\w{5,}\b/g) ?? [],
      );
      const overlap = jaccard(claimWords, responseWords);
      if (overlap < 0.15) continue; // Not referencing this claim

      // Check for agreement or disagreement markers near the claim reference
      const lowerContent = response.content.toLowerCase();
      const disagreeMarkers =
        /\b(disagree|wrong|incorrect|flawed|reject|oppose|counter|however|but)\b/gi;
      const agreeMarkers =
        /\b(agree|correct|valid|support|endorse|concur|accept)\b/gi;
      const disagreeCount = (lowerContent.match(disagreeMarkers) ?? []).length;
      const agreeCount = (lowerContent.match(agreeMarkers) ?? []).length;

      if (agreeCount > disagreeCount) {
        claim.agreeSlots.push(response.slotId);
      } else if (disagreeCount > 0) {
        claim.disagreeSlots.push(response.slotId);
      }
    }

    // Update claim status
    const totalParticipants = debate.participants.length;
    const agreeRatio = claim.agreeSlots.length / totalParticipants;
    if (agreeRatio >= 0.7) {
      claim.status = "agreed";
    } else if (claim.disagreeSlots.length > 0) {
      claim.status = "contested";
    } else {
      claim.status = "undecided";
    }
  }

  // Store updated claims on the round
  round.claims = [...debate.claims];
}

/**
 * Get partial consensus summary: what's agreed, what's contested, what's undecided.
 */
export function getPartialConsensus(debate: DebateState): {
  agreed: DebateClaim[];
  contested: DebateClaim[];
  undecided: DebateClaim[];
  consensusRatio: number;
} {
  const agreed = debate.claims.filter((c) => c.status === "agreed");
  const contested = debate.claims.filter((c) => c.status === "contested");
  const undecided = debate.claims.filter((c) => c.status === "undecided");
  const total = debate.claims.length || 1;

  return {
    agreed,
    contested,
    undecided,
    consensusRatio: agreed.length / total,
  };
}

// ── Fast-Track: Skip Unnecessary Rounds ──────────────────────────────

/**
 * Check if a debate can be fast-tracked after Round 1.
 * Conditions: convergence ≥ threshold, no sycophancy, all positions score ≥ minimum.
 */
export function checkFastTrack(
  debate: DebateState,
  convergence: ReturnType<typeof computeDebateConvergence>,
  sycophancy: ReturnType<typeof detectDebateSycophancy>,
  scores: DebatePositionScore[],
): { eligible: boolean; reason: string } {
  if (debate.currentRound !== 1) {
    return { eligible: false, reason: "Fast-track only applies after Round 1" };
  }

  if (convergence.score < debate.convergenceThreshold) {
    return {
      eligible: false,
      reason: `Convergence ${(convergence.score * 100).toFixed(0)}% below threshold ${(debate.convergenceThreshold * 100).toFixed(0)}%`,
    };
  }

  if (sycophancy.detected) {
    return {
      eligible: false,
      reason: `Sycophancy detected (${(sycophancy.score * 100).toFixed(0)}%) — cannot fast-track`,
    };
  }

  const lowScores = scores.filter((s) => s.total < debate.minPositionScore);
  if (lowScores.length > 0) {
    return {
      eligible: false,
      reason: `${lowScores.length} position(s) below minimum score (${debate.minPositionScore}/11)`,
    };
  }

  debate.fastTrack = true;
  return {
    eligible: true,
    reason: `All conditions met: convergence ${(convergence.score * 100).toFixed(0)}%, no sycophancy, all positions ≥${debate.minPositionScore}/11. Skipping to synthesis.`,
  };
}

// ── Devil's Advocate: Forced Dissent ─────────────────────────────────

/**
 * Check if a contrarian should be assigned and do it.
 * Triggered when Round 1 convergence > 0.6 but < threshold (premature agreement risk).
 */
export function assignContrarian(
  debate: DebateState,
  convergence: ReturnType<typeof computeDebateConvergence>,
  scores: DebatePositionScore[],
): { assigned: boolean; slotId?: string; reason: string } {
  if (debate.contrarian) {
    return {
      assigned: false,
      reason: `Contrarian already assigned: ${debate.contrarian}`,
    };
  }

  if (debate.currentRound !== 1) {
    return {
      assigned: false,
      reason: "Contrarian assignment only after Round 1",
    };
  }

  // Only assign if convergence is suspiciously high but not fast-track eligible
  if (convergence.score < 0.5) {
    return {
      assigned: false,
      reason: "Positions are sufficiently diverse — no contrarian needed",
    };
  }

  // Assign the WEAKEST scorer as contrarian (they have least to lose by switching)
  const minScoreIdx = scores.reduce(
    (min, s, i) => (s.total < scores[min].total ? i : min),
    0,
  );
  const contrarianSlot = debate.participants[minScoreIdx].slotId;
  debate.contrarian = contrarianSlot;

  return {
    assigned: true,
    slotId: contrarianSlot,
    reason: `Early convergence at ${(convergence.score * 100).toFixed(0)}% — ${contrarianSlot} assigned as devil's advocate to stress-test consensus`,
  };
}

/**
 * Build a contrarian-modified position prompt.
 * Instructs the assigned devil's advocate to steelman the opposite view.
 */
export function buildContrarianPrompt(
  debate: DebateState,
  participant: DebateParticipant,
  session: SwarmSession,
): string {
  const lastRound = debate.rounds[debate.rounds.length - 1];
  const dominantPosition = lastRound?.evaluation?.dominantPosition;
  const dominantContent =
    lastRound?.contributions
      .filter((c) => c.phase === "position" || c.phase === "rebuttal")
      .find((c) => c.slotId === dominantPosition)?.content ?? "";

  const consensus = getPartialConsensus(debate);
  const agreedClaims = consensus.agreed.map((c) => `  - ${c.text}`).join("\n");

  return `You are the DEVIL'S ADVOCATE in this debate. Your job is to STRESS-TEST the emerging consensus.

## DEBATE TOPIC
${debate.topic}

## TASK CONTEXT
${session.task}

## EMERGING CONSENSUS (you must challenge this)
${dominantContent.substring(0, 1000)}

## AGREED CLAIMS (challenge the weakest of these)
${agreedClaims || "No claims formally agreed yet."}

## YOUR ASSIGNMENT
Take the STRONGEST POSSIBLE opposing position. This is not about being contrarian for its own sake — it's about finding blind spots.

Requirements:
1. Identify the WEAKEST assumption in the consensus position
2. Construct a compelling alternative that the other side hasn't considered
3. Find edge cases, failure modes, or scaling issues the consensus ignores
4. Use CONCRETE evidence — code paths, performance data, real-world examples
5. Be intellectually honest — if the consensus is genuinely strong, say so but still probe its limits

FORMAT:
## Contrarian Position
<your strongest opposing argument>

## Weakest Assumption in Consensus
<the assumption most likely to be wrong>

## Evidence Against Consensus
<specific technical evidence>

## Failure Modes
<scenarios where the consensus approach breaks>

## Confidence That Consensus Is Wrong: <HIGH/MEDIUM/LOW>
`;
}

// ── Validation Checkpoint: Post-Implementation Feedback ──────────────

/**
 * Create a validation checkpoint for a resolved debate.
 * Called after workers implement the synthesis — enables feedback loop.
 */
export function createValidationCheckpoint(
  debate: DebateState,
): ValidationCheckpoint {
  if (!debate.synthesis) {
    throw new Error(
      "Cannot create validation checkpoint: debate has no synthesis",
    );
  }

  const checkpoint: ValidationCheckpoint = {
    debateId: debate.id,
    synthesis: debate.synthesis,
    submittedAt: Date.now(),
    outcome: "pending",
    findings: [],
  };

  debate.validation = checkpoint;
  return checkpoint;
}

/**
 * Submit validation results for a debate's synthesis.
 * If validation fails, creates a new debate with the original context + findings.
 */
export function submitValidation(
  session: SwarmSession,
  debate: DebateState,
  outcome: "confirmed" | "failed" | "partial",
  findings: string[],
): {
  checkpoint: ValidationCheckpoint;
  reopened: boolean;
  newDebateId?: string;
} {
  if (!debate.validation) {
    debate.validation = createValidationCheckpoint(debate);
  }

  debate.validation.outcome = outcome;
  debate.validation.findings = findings;
  debate.validation.validatedAt = Date.now();

  let reopened = false;
  let newDebateId: string | undefined;

  if (outcome === "failed" || outcome === "partial") {
    // Reopen debate with new evidence
    const newTopic = `[REOPENED] ${debate.topic} — validation ${outcome}: ${findings.slice(0, 2).join("; ")}`;
    const newDebate = createDebate(
      session,
      newTopic,
      "disagreement",
      debate.groupId,
      debate.participants.length,
      2, // Fewer rounds for reopened debates — we have more context now
    );

    newDebate.claims = [...debate.claims]; // Carry forward claim tracking
    debate.validation.reopenedDebateId = newDebate.id;
    reopened = true;
    newDebateId = newDebate.id;
  }

  return { checkpoint: debate.validation, reopened, newDebateId };
}

// ── File Claims System ────────────────────────────────────────────────
// Prevents file conflicts between workers by tracking ownership.

export function claimFiles(
  session: SwarmSession,
  paths: string[],
  claimedBy: string,
  groupId: string,
): { claimed: string[]; conflicts: Array<{ path: string; owner: string }> } {
  const claimed: string[] = [];
  const conflicts: Array<{ path: string; owner: string }> = [];

  for (const path of paths) {
    const existing = session.claims.find((c) => c.path === path && !c.released);
    if (existing && existing.claimedBy !== claimedBy) {
      conflicts.push({ path, owner: existing.claimedBy });
    } else {
      // Claim or re-claim
      const existingOwn = session.claims.find(
        (c) => c.path === path && c.claimedBy === claimedBy,
      );
      if (!existingOwn || existingOwn.released) {
        session.claims.push({
          path,
          claimedBy,
          groupId,
          claimedAt: Date.now(),
          released: false,
        });
      }
      claimed.push(path);
    }
  }

  return { claimed, conflicts };
}

export function releaseFiles(
  session: SwarmSession,
  paths: string[],
  claimedBy: string,
): string[] {
  const released: string[] = [];
  for (const path of paths) {
    const claim = session.claims.find(
      (c) => c.path === path && c.claimedBy === claimedBy && !c.released,
    );
    if (claim) {
      claim.released = true;
      released.push(path);
    }
  }
  return released;
}

export function checkFileClaims(
  session: SwarmSession,
  paths: string[],
): Array<{ path: string; claimedBy: string; groupId: string }> {
  return paths
    .map((path) => {
      const claim = session.claims.find((c) => c.path === path && !c.released);
      return claim
        ? { path, claimedBy: claim.claimedBy, groupId: claim.groupId }
        : null;
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);
}

export function getClaimsForWorkstream(
  session: SwarmSession,
  workstreamId: string,
): FileClaim[] {
  return session.claims.filter(
    (c) => c.claimedBy === workstreamId && !c.released,
  );
}

export function getAllActiveClaims(session: SwarmSession): FileClaim[] {
  return session.claims.filter((c) => !c.released);
}

// ── Anti-Drift Detection ──────────────────────────────────────────────
// Compare worker output against original assignment to detect goal drift.

export function checkDrift(taskGoal: string, output: string): DriftCheck {
  const goalTokens = new Set(
    taskGoal
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );
  const outputTokens = new Set(
    output
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 3),
  );

  // Measure how many goal keywords appear in output
  let overlap = 0;
  for (const token of goalTokens) {
    if (outputTokens.has(token)) overlap++;
  }
  const alignmentScore = goalTokens.size > 0 ? overlap / goalTokens.size : 1;

  const driftSignals: string[] = [];

  // Check for common drift indicators
  if (alignmentScore < 0.3) {
    driftSignals.push("Output has very low keyword overlap with original task");
  }

  // Check if output is suspiciously short
  if (output.length < taskGoal.length * 0.5 && output.length < 200) {
    driftSignals.push(
      "Output is much shorter than expected for the task scope",
    );
  }

  // Check for scope creep signals
  const scopeCreepPatterns =
    /\b(also|additionally|while I was at it|bonus|extra|unrelated)\b/gi;
  const scopeMatches = output.match(scopeCreepPatterns);
  if (scopeMatches && scopeMatches.length >= 2) {
    driftSignals.push(
      `Possible scope creep detected (${scopeMatches.length} tangential markers)`,
    );
  }

  // Summarize output (first 200 chars)
  const outputSummary =
    output.substring(0, 200) + (output.length > 200 ? "..." : "");

  return { taskGoal, outputSummary, alignmentScore, driftSignals };
}

// ── Worker Consensus Protocol ─────────────────────────────────────────
// Lightweight voting for L3 workers on complex tasks.

let consensusCounter = 0;

export function createConsensus(
  session: SwarmSession,
  groupId: string,
  topic: string,
): ConsensusState {
  const consensus: ConsensusState = {
    id: `consensus-${++consensusCounter}`,
    sessionId: session.id,
    groupId,
    topic,
    proposals: [],
    status: "collecting",
    createdAt: Date.now(),
  };
  session.consensuses.push(consensus);
  return consensus;
}

export function getConsensus(
  session: SwarmSession,
  id: string,
): ConsensusState | undefined {
  return session.consensuses.find((c) => c.id === id);
}

export function submitProposal(
  consensus: ConsensusState,
  workstreamId: string,
  slotId: string,
  model: string,
  content: string,
): void {
  consensus.proposals.push({
    workstreamId,
    slotId,
    model,
    content,
    submittedAt: Date.now(),
  });
}

/**
 * Quick convergence check for consensus proposals.
 * Uses Jaccard similarity on key terms across proposals.
 */
export function evaluateConsensus(consensus: ConsensusState): {
  convergenceScore: number;
  recommendation: "implement-best" | "debate" | "need-more-proposals";
} {
  if (consensus.proposals.length < 2) {
    return { convergenceScore: 0, recommendation: "need-more-proposals" };
  }

  // Tokenize each proposal
  const tokenSets = consensus.proposals.map(
    (p) =>
      new Set(
        p.content
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length > 3),
      ),
  );

  // Compute average pairwise Jaccard similarity
  let totalSim = 0;
  let pairs = 0;
  for (let i = 0; i < tokenSets.length; i++) {
    for (let j = i + 1; j < tokenSets.length; j++) {
      const intersection = [...tokenSets[i]].filter((t) =>
        tokenSets[j].has(t),
      ).length;
      const union = new Set([...tokenSets[i], ...tokenSets[j]]).size;
      totalSim += union > 0 ? intersection / union : 0;
      pairs++;
    }
  }
  const convergenceScore = pairs > 0 ? totalSim / pairs : 0;
  consensus.convergenceScore = convergenceScore;

  if (convergenceScore >= 0.6) {
    consensus.status = "decided";
    return { convergenceScore, recommendation: "implement-best" };
  } else {
    return { convergenceScore, recommendation: "debate" };
  }
}

// ── Acceptance Test Parsing ────────────────────────────────────────────

/**
 * Parse structured acceptance tests from a task prompt.
 * Format:
 *   ACCEPTANCE_TESTS:
 *   WS1:
 *     - name: "GET connectors returns 200"
 *       command: "curl -sf http://localhost:8000/api/v1/connectors"
 *       expect: "status_code:200"
 *       category: "integration"
 */
export function parseAcceptanceTests(
  task: string,
): Map<string, AcceptanceTest[]> {
  const result = new Map<string, AcceptanceTest[]>();
  const blockMatch = task.match(
    /ACCEPTANCE_TESTS:\s*\n([\s\S]*?)(?:\n(?=[A-Z_]+:)|\n---|\n$|$)/,
  );
  if (!blockMatch) return result;

  const block = blockMatch[1];
  // Split by workstream headers (e.g., "WS1:", "ws-0:")
  const wsRegex = /^(\S+):\s*$/gm;
  let match: RegExpExecArray | null;
  const wsPositions: Array<{ id: string; start: number }> = [];
  while ((match = wsRegex.exec(block)) !== null) {
    wsPositions.push({ id: match[1], start: match.index + match[0].length });
  }

  for (let i = 0; i < wsPositions.length; i++) {
    const end =
      i + 1 < wsPositions.length ? wsPositions[i + 1].start : block.length;
    const wsBlock = block.substring(wsPositions[i].start, end);
    const tests: AcceptanceTest[] = [];

    // Parse individual test entries
    const testRegex =
      /- name:\s*"([^"]+)"\s+command:\s*"([^"]+)"\s+expect:\s*"([^"]+)"(?:\s+category:\s*"([^"]+)")?/g;
    let testMatch: RegExpExecArray | null;
    while ((testMatch = testRegex.exec(wsBlock)) !== null) {
      tests.push({
        name: testMatch[1],
        command: testMatch[2],
        expect: testMatch[3],
        category: (testMatch[4] as AcceptanceTest["category"]) ?? "integration",
      });
    }

    if (tests.length > 0) {
      result.set(wsPositions[i].id, tests);
    }
  }

  return result;
}

// ── Verifier Model Selection ──────────────────────────────────────────

/**
 * Select a verifier model from a different provider than the builder.
 * Ensures clean-room validation — the verifier doesn't share the builder's biases.
 */
export function getVerifierModel(builderModel: string, index: number): string {
  const builderProvider = getModelProvider(builderModel);
  // Pick from criticPool, excluding builder's provider
  const candidates = criticPool.filter(
    (m) => getModelProvider(m) !== builderProvider,
  );
  if (candidates.length > 0) return candidates[index % candidates.length];
  return criticPool[index % criticPool.length]; // fallback if single provider
}

// ── Verifier Prompt Builder ───────────────────────────────────────────

/**
 * Build the prompt for a verifier agent. The verifier:
 * - Receives the workstream's acceptanceTests[]
 * - Does NOT receive the builder's code or approach (clean-room testing)
 * - Gets exact test commands to execute
 * - Must report results in a structured VALIDATION_RESULT: JSON block
 */
export function buildVerifierPrompt(
  session: SwarmSession,
  workstream: Workstream,
  tests: AcceptanceTest[],
): string {
  const testList = tests
    .map(
      (t, i) =>
        `  ${i + 1}. ${t.name}\n     Command: ${t.command}\n     Expect: ${t.expect}\n     Category: ${t.category}`,
    )
    .join("\n");

  return [
    `=== VALIDATION TASK ===`,
    `You are an independent verifier. Your job is to run acceptance tests against the project.`,
    `You did NOT build this code — you are testing it from the outside.`,
    ``,
    `Project task: ${session.task}`,
    `Workstream: ${workstream.id} — ${workstream.description}`,
    `Files: ${workstream.files.join(", ") || "See project root"}`,
    ``,
    `=== STARTUP ===`,
    `1. Detect the project type from files (package.json → npm, setup.py → pip, go.mod → go, docker-compose.yml → docker)`,
    `2. Install dependencies if needed`,
    `3. Start the application (npm run dev / docker compose up -d / uvicorn / etc.)`,
    `4. Wait for the app to be ready (retry health check for up to 30s)`,
    ``,
    `=== ACCEPTANCE TESTS ===`,
    testList,
    ``,
    `=== EXECUTION ===`,
    `For each test:`,
    `- Run the command`,
    `- Compare output against the expect condition:`,
    `  - "status_code:NNN" → check HTTP status code`,
    `  - "exit_code:N" → check command exit code`,
    `  - "json:.field == value" → check JSON field in response`,
    `  - "contains:text" → check output contains text`,
    `- Record pass/fail with actual vs expected`,
    ``,
    `=== REPORTING ===`,
    `After running all tests, output a structured block:`,
    ``,
    `VALIDATION_RESULT:`,
    `{`,
    `  "workstream": "${workstream.id}",`,
    `  "results": [`,
    `    { "name": "test name", "category": "integration", "status": "pass|fail|skip|error", "actual": "...", "expected": "...", "error": "..." }`,
    `  ]`,
    `}`,
    ``,
    `Then shut down any processes you started.`,
  ].join("\n");
}

// ── Types ──────────────────────────────────────────────────────────────

export type Tier = 'duo' | 'trio' | 'full-swarm' | 'blitz' | 'debate' | 'unleashed';
export type ExecutionMode = 'task' | 'subprocess';
export type RatePreset = 'conservative' | 'standard' | 'aggressive' | 'max' | 'unlimited';

// ── Rate Limit Presets ────────────────────────────────────────────────
// Based on GitHub Copilot rate limits (docs.github.com/en/copilot/concepts/rate-limits)
//
// Key constraints per model tier:
//   Standard models (Sonnet, GPT-5.x, Gemini): 10-15 RPM, 5 concurrent
//   Premium models (Opus):  1-2 RPM, 1-2 concurrent
//   Fast models (Haiku, GPT-4.1): 15 RPM, 5-8 concurrent
//
// Each L2 manager + its workers ≈ 5 concurrent API sessions.
// Multi-provider spread helps (Anthropic/OpenAI/Google have separate quotas).
//
// Model multipliers (premium request cost):
//   Opus 4.5/4.6 = 3x, Sonnet 4.5/4/4.6 = 1x, Haiku 4.5 = 0.33x
//   GPT-5.x-Codex = 1x, GPT-4.1 = free on paid plans

export interface RateConfig {
  concurrency: number;    // max simultaneous L2 managers
  maxAgents: number;      // approx total agents (managers + workers)
  description: string;
  plan: string;           // recommended Copilot plan
}

export const RATE_PRESETS: Record<RatePreset, RateConfig> = {
  conservative: {
    concurrency: 2,
    maxAgents: 10,
    description: 'Safe for any Copilot plan. 2 L2 managers at a time (~10 total agents).',
    plan: 'Any (Free, Pro, Business, Enterprise)',
  },
  standard: {
    concurrency: 3,
    maxAgents: 15,
    description: '3 L2 managers at a time (~15 agents). Good balance of speed and stability.',
    plan: 'Business or Enterprise',
  },
  aggressive: {
    concurrency: 4,
    maxAgents: 20,
    description: '4 L2 managers at a time (~20 agents). Provider diversity reduces per-provider load.',
    plan: 'Enterprise (8 concurrent per tier)',
  },
  max: {
    concurrency: 8,
    maxAgents: 40,
    description: '8 L2 managers at a time (~40 agents). Maximum throughput. May hit rate limits on busy days.',
    plan: 'Enterprise with headroom',
  },
  unlimited: {
    concurrency: 0,
    maxAgents: Infinity,
    description: 'No limit. All managers dispatch at once. Use at your own risk.',
    plan: 'N/A — risk of rate limit errors',
  },
};

export function resolveRateLimit(input?: number | RatePreset): number {
  if (input === undefined || input === null) return RATE_PRESETS.standard.concurrency;
  if (typeof input === 'number') return input;
  const preset = RATE_PRESETS[input];
  return preset ? preset.concurrency : RATE_PRESETS.standard.concurrency;
}

export interface PhaseDefinition {
  name: string;
  agentType: string;
  model: string;
  mode: 'sync' | 'background';
  parallel: boolean;
  requiresMerge: boolean;
  isGate: boolean;
}

export interface PhaseState {
  name: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped';
  agentIds: string[];
  outputs: string[];
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
  dependencies: string[]; // workstream IDs that must complete before this one
  status: 'pending' | 'ready' | 'in_progress' | 'done' | 'blocked';
}

export interface BoardMessage {
  workstream: string; // who posted it
  type: 'finding' | 'blocker' | 'decision' | 'status' | 'plan' | 'report';
  level: 'L1' | 'L2' | 'L3'; // hierarchy level of the sender
  group?: string; // agent group ID (L2 manager name)
  content: string;
  timestamp: number;
}

// ── 3-Level Hierarchy ─────────────────────────────────────────────────
// L1 = Orchestrator (big boss, premium model, calls MCP tools)
// L2 = Agents/Managers (dispatched by L1, can spawn L3 workers, report plans)
// L3 = Workers (spawned by L2, do actual work, report to their L2 manager)

export interface AgentGroup {
  id: string;          // e.g., "group-0", "group-1"
  managerAgent: string; // L2 agent type (e.g., "manager-anthropic")
  managerModel: string; // model assigned to the L2 manager
  workerSlots: WorkerSlot[]; // L3 worker assignments
  plan: string;        // L2 manager's plan (submitted during execution)
  status: 'pending' | 'dispatched' | 'reporting' | 'done';
  report?: string;     // L2's final synthesized report to L1
}

export interface WorkerSlot {
  workstreamId: string; // which workstream this worker handles
  agentType: string;    // e.g., "worker-openai"
  model: string;        // model for this worker
  description: string;  // what this worker should do
  files: string[];      // files assigned
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
  promptStore: Map<string, string>; // server-side prompt storage to avoid LLM output truncation
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
  tier: 'premium' | 'standard' | 'fast';
  provider: string; // 'anthropic' | 'openai' | 'google'
}

// All known models — add new ones here and they auto-distribute
const ALL_MODELS: ModelEntry[] = [
  // Premium — deep reasoning, architecture, synthesis
  { id: 'claude-opus-4.6',       tier: 'premium',  provider: 'anthropic' },
  { id: 'claude-opus-4.5',       tier: 'premium',  provider: 'anthropic' },
  { id: 'gpt-5.1-codex-max',     tier: 'premium',  provider: 'openai' },
  // Standard — coding, reviewing, general work
  { id: 'claude-sonnet-4.6',     tier: 'standard', provider: 'anthropic' },
  { id: 'claude-sonnet-4.5',     tier: 'standard', provider: 'anthropic' },
  { id: 'claude-sonnet-4',       tier: 'standard', provider: 'anthropic' },
  { id: 'gpt-5.3-codex',         tier: 'standard', provider: 'openai' },
  { id: 'gpt-5.2-codex',         tier: 'standard', provider: 'openai' },
  { id: 'gpt-5.1-codex',         tier: 'standard', provider: 'openai' },
  { id: 'gpt-5.2',               tier: 'standard', provider: 'openai' },
  { id: 'gpt-5.1',               tier: 'standard', provider: 'openai' },
  { id: 'gemini-3-pro-preview',  tier: 'standard', provider: 'google' },
  // Fast — explorers, merges, cheap parallel work
  { id: 'claude-haiku-4.5',      tier: 'fast',     provider: 'anthropic' },
  { id: 'gpt-4.1',               tier: 'fast',     provider: 'openai' },
  { id: 'gpt-5.1-codex-mini',    tier: 'fast',     provider: 'openai' },
];

// ── Model Fallback System ─────────────────────────────────────────────
// When a model isn't available, auto-resolve to the best alternative.
// Priority: same provider + same tier → same tier any provider → any available

// Explicit fallback chains — first match wins
const MODEL_FALLBACK_CHAINS: Record<string, string[]> = {
  // Anthropic premium
  'claude-opus-4.6':     ['claude-opus-4.5', 'claude-sonnet-4.6', 'claude-sonnet-4.5', 'gpt-5.1-codex-max', 'gpt-5.3-codex'],
  'claude-opus-4.5':     ['claude-opus-4.6', 'claude-sonnet-4.5', 'claude-sonnet-4.6', 'gpt-5.1-codex-max', 'gpt-5.3-codex'],
  // Anthropic standard
  'claude-sonnet-4.6':   ['claude-sonnet-4.5', 'claude-sonnet-4', 'gpt-5.3-codex', 'gpt-5.2-codex'],
  'claude-sonnet-4.5':   ['claude-sonnet-4.6', 'claude-sonnet-4', 'gpt-5.3-codex', 'gpt-5.2-codex'],
  'claude-sonnet-4':     ['claude-sonnet-4.5', 'claude-sonnet-4.6', 'gpt-5.2-codex', 'gpt-5.1-codex'],
  // OpenAI premium
  'gpt-5.1-codex-max':   ['gpt-5.3-codex', 'gpt-5.2-codex', 'claude-opus-4.6', 'claude-opus-4.5'],
  // OpenAI standard
  'gpt-5.3-codex':       ['gpt-5.2-codex', 'gpt-5.1-codex', 'gpt-5.2', 'claude-sonnet-4.6', 'claude-sonnet-4.5'],
  'gpt-5.2-codex':       ['gpt-5.3-codex', 'gpt-5.1-codex', 'gpt-5.2', 'claude-sonnet-4.5', 'claude-sonnet-4'],
  'gpt-5.1-codex':       ['gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-5.1', 'claude-sonnet-4', 'claude-sonnet-4.5'],
  'gpt-5.2':             ['gpt-5.1', 'gpt-5.2-codex', 'gpt-5.1-codex', 'claude-sonnet-4.5'],
  'gpt-5.1':             ['gpt-5.2', 'gpt-5.1-codex', 'gpt-5.2-codex', 'claude-sonnet-4'],
  // Google
  'gemini-3-pro-preview': ['claude-sonnet-4.5', 'gpt-5.2-codex', 'claude-sonnet-4.6', 'gpt-5.3-codex'],
  // Fast
  'claude-haiku-4.5':    ['gpt-4.1', 'gpt-5.1-codex-mini', 'claude-sonnet-4', 'gpt-5.1'],
  'gpt-4.1':             ['gpt-5.1-codex-mini', 'claude-haiku-4.5', 'gpt-5.1', 'claude-sonnet-4'],
  'gpt-5.1-codex-mini':  ['gpt-4.1', 'claude-haiku-4.5', 'gpt-5.1', 'claude-sonnet-4'],
};

/**
 * Resolve a model to an available one. If the requested model is available, return it.
 * Otherwise walk the fallback chain, then try same-tier same-provider, same-tier any, then anything.
 */
export function resolveModel(requestedModel: string): string {
  // If available, use it directly
  if (availableModels.find((m) => m.id === requestedModel)) return requestedModel;

  const requested = ALL_MODELS.find((m) => m.id === requestedModel);
  const requestedTier = requested?.tier ?? 'standard';
  const requestedProvider = requested?.provider ?? 'unknown';

  // 1. Walk explicit fallback chain
  const chain = MODEL_FALLBACK_CHAINS[requestedModel];
  if (chain) {
    for (const fallback of chain) {
      if (availableModels.find((m) => m.id === fallback)) {
        console.error(`[model-fallback] ${requestedModel} → ${fallback} (explicit chain)`);
        return fallback;
      }
    }
  }

  // 2. Same tier + same provider
  const sameTierProvider = availableModels.find(
    (m) => m.tier === requestedTier && m.provider === requestedProvider
  );
  if (sameTierProvider) {
    console.error(`[model-fallback] ${requestedModel} → ${sameTierProvider.id} (same tier+provider)`);
    return sameTierProvider.id;
  }

  // 3. Same tier, any provider
  const sameTier = availableModels.find((m) => m.tier === requestedTier);
  if (sameTier) {
    console.error(`[model-fallback] ${requestedModel} → ${sameTier.id} (same tier)`);
    return sameTier.id;
  }

  // 4. Anything available
  if (availableModels.length > 0) {
    const fallback = availableModels[0].id;
    console.error(`[model-fallback] ${requestedModel} → ${fallback} (last resort)`);
    return fallback;
  }

  // Nothing available — return original and let it fail loud
  console.error(`[model-fallback] ${requestedModel} — NO fallbacks available, returning as-is`);
  return requestedModel;
}

// Track fallback events for diagnostics
const fallbackLog: Array<{ from: string; to: string; reason: string; ts: Date }> = [];

export function resolveModelTracked(requestedModel: string): { model: string; wasFallback: boolean } {
  const resolved = resolveModel(requestedModel);
  const wasFallback = resolved !== requestedModel;
  if (wasFallback) {
    fallbackLog.push({ from: requestedModel, to: resolved, reason: 'not_available', ts: new Date() });
  }
  return { model: resolved, wasFallback };
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
  const premium = availableModels.filter((m) => m.tier === 'premium');
  const standard = availableModels.filter((m) => m.tier === 'standard');
  const fast = availableModels.filter((m) => m.tier === 'fast');

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
  criticPool = standard.length > 1
    ? standard.filter((_, i) => i % 2 === 1).map((m) => m.id)
    : standard.map((m) => m.id);

  // Fallbacks if pools are empty
  if (premiumPool.length === 0) premiumPool = coderPool.length > 0 ? [coderPool[0]] : ['claude-sonnet-4.6'];
  if (coderPool.length === 0) coderPool = ['claude-sonnet-4.6'];
  if (criticPool.length === 0) criticPool = coderPool.slice(0, 2);
  if (fastPool.length === 0) fastPool = ['claude-haiku-4.5'];
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
  return entry?.provider ?? 'unknown';
}

// ── Phase Definitions per Tier ─────────────────────────────────────────

function def(
  name: string,
  agentType: string,
  model: string,
  mode: 'sync' | 'background',
  parallel: boolean,
  requiresMerge: boolean,
  isGate: boolean,
): PhaseDefinition {
  return { name, agentType, model, mode, parallel, requiresMerge, isGate };
}

export const TIER_PHASES: Record<Tier, PhaseDefinition[]> = {
  duo: [
    def('implement', 'clean-code', getCoderModel(0), 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'sync', false, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
  ],
  trio: [
    def('design', 'architect', getArchitectModel(), 'sync', false, false, false),
    def('implement', 'clean-code', getCoderModel(0), 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'sync', false, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
    def('validate', 'task', '', 'sync', false, false, false),
  ],
  'full-swarm': [
    def('explore', 'explore', getFastModel(), 'background', true, true, false),
    def('merge_explore', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('design', 'architect', getArchitectModel(), 'sync', false, false, false),
    def('implement', 'clean-code', getCoderModel(0), 'background', true, true, false),
    def('merge_impl', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'background', true, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
    def('integration', 'task', '', 'sync', false, false, false),
    def('validate', 'task', '', 'sync', false, false, false),
    def('synthesize', 'architect', getSynthesizerModel(), 'sync', false, false, false),
  ],
  blitz: [
    def('recon', 'explore', getFastModel(), 'background', true, true, false),
    def('merge_recon', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('triage', 'architect', getArchitectModel(), 'sync', false, false, false),
    def('build', 'clean-code', getCoderModel(0), 'background', true, true, false),
    def('merge_build', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'background', true, true, false),
    def('merge_review', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
    def('integration', 'task', '', 'sync', false, false, false),
    def('validate', 'task', '', 'sync', false, false, false),
    def('synthesize', 'architect', getSynthesizerModel(), 'sync', false, false, false),
  ],
  debate: [
    def('propose', 'architect', getArchitectModel(), 'background', true, false, false),
    def('critique', 'code-review', getCriticModel(0), 'background', true, false, false),
    def('rebuttal', 'architect', getArchitectModel(), 'background', true, false, false),
    def('merge_debate', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('synthesize', 'architect', getSynthesizerModel(), 'sync', false, false, false),
  ],
  unleashed: [
    def('recon', 'explore', getFastModel(), 'background', true, true, false),
    def('merge_recon', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('triage', 'architect', getArchitectModel(), 'sync', false, false, false),
    def('build', 'clean-code', getCoderModel(0), 'background', true, true, false),
    def('merge_build', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'background', true, true, false),
    def('merge_review', 'general-purpose', getFastModel(), 'sync', false, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
    def('integration', 'task', '', 'sync', false, false, false),
    def('validate', 'task', '', 'sync', false, false, false),
    def('synthesize', 'architect', getSynthesizerModel(), 'sync', false, false, false),
  ],
};

// ── Session Store ──────────────────────────────────────────────────────

export const sessions = new Map<string, SwarmSession>();

let idCounter = 0;
function generateId(): string {
  idCounter++;
  return `swarm-${Date.now()}-${idCounter}`;
}

export function createSession(tier: Tier, task: string, executionMode: ExecutionMode = 'task', concurrency?: number | RatePreset): SwarmSession {
  const id = generateId();
  const phaseDefs = TIER_PHASES[tier];
  const phases: PhaseState[] = phaseDefs.map((p) => ({
    name: p.name,
    status: 'pending',
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
    promptStore: new Map(),
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

export function getPhaseDefinition(session: SwarmSession, phaseIndex?: number): PhaseDefinition {
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
  if (currentPhase.status !== 'done') {
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
      if (nextDef.name.startsWith('merge_') && nextPhase.status !== 'done') {
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
        .join(', ');
      throw new Error(
        `Gate failed: workstreams below threshold (≥7 required): ${details}`,
      );
    }
    const unscoredWorkstreams = session.workstreams.filter(
      (ws) => ws.score === undefined,
    );
    if (session.workstreams.length > 0 && unscoredWorkstreams.length > 0) {
      throw new Error(
        `Gate incomplete: workstreams without scores: ${unscoredWorkstreams.map((ws) => ws.id).join(', ')}`,
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

  if (fileCount !== undefined && fileCount > 50) return 'blitz';
  if (/massive|full app|entire codebase/.test(lower)) return 'blitz';

  if (/debate|decide|which approach|tradeoff/.test(lower)) return 'debate';

  if (/unleashed|max|pedal to the metal|no restraints|hurt|pain|destroy/.test(lower)) return 'unleashed';

  if (/refactor|security|architecture|complex/.test(lower)) return 'full-swarm';

  if (/design|multi-file|feature/.test(lower)) return 'trio';

  return 'duo';
}

// ── Anonymous History Builder ──────────────────────────────────────────

export function buildAnonymousHistory(session: SwarmSession, forWorkstream?: string): string {
  const lines: string[] = [];
  const currentRound = session.rounds.length > 0
    ? Math.max(...session.rounds.map((r) => r.round))
    : 0;

  lines.push(`=== SWARM CONTEXT (Tier: ${session.tier}, Round: ${currentRound}) ===`);
  lines.push(`TASK: ${session.task}`);
  lines.push('');

  // Filter history for the target workstream if specified
  const relevantHistory = session.history.filter((entry) => {
    if (!forWorkstream) return true;
    return entry.content.includes(forWorkstream) || !entry.content.includes('workstream:');
  });

  for (const entry of relevantHistory) {
    lines.push(`--- ${entry.phase.toUpperCase()} (Round ${entry.round}) ---`);
    lines.push(entry.content);
    lines.push('');
  }

  // Add scores if available
  const relevantRounds = forWorkstream
    ? session.rounds.filter((r) => r.workstream === forWorkstream)
    : session.rounds;

  if (relevantRounds.length > 0) {
    lines.push('--- SCORES ---');
    for (const r of relevantRounds) {
      lines.push(
        `Round ${r.round} | Workstream: ${r.workstream} | Score: ${r.score}/10 | Critical Issues: ${r.criticalIssues}`,
      );
    }
    lines.push('');
  }

  lines.push('--- YOUR OUTPUT ---');
  lines.push(
    'A contributor completed the prior phases above. Build on their work. ' +
    'Do not reference specific contributors or models. ' +
    'Focus on improving quality and addressing any identified issues.',
  );

  return lines.join('\n');
}

// ── Identity Stripping ────────────────────────────────────────────────

export function stripIdentity(text: string): string {
  if (!text) return '';
  // Remove ANSI codes
  const noAnsi = text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
  // Remove model names
  return noAnsi
    .replace(/claude[-\s]?\w+/gi, 'a contributor')
    .replace(/gpt[-\s]?\w+/gi, 'a contributor')
    .replace(/opus|sonnet|haiku|codex/gi, 'contributor')
    .replace(/gemini[-\s]?\w+/gi, 'a contributor')
    .replace(/agent[_-]?\d+/gi, 'a contributor')
    .replace(/workstream[_-]?\d+/gi, 'workstream')
    .replace(/ws-\d+/gi, 'workstream');
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

export function getPrompt(session: SwarmSession, ref: string): string | undefined {
  return session.promptStore.get(ref);
}

// ── Board Operations ──────────────────────────────────────────────────

export function postToBoard(
  session: SwarmSession,
  workstream: string,
  type: BoardMessage['type'],
  content: string,
  level: BoardMessage['level'] = 'L3',
  group?: string,
): BoardMessage {
  const msg: BoardMessage = {
    workstream,
    type,
    level,
    group,
    content: stripIdentity(content),
    timestamp: Date.now(),
  };
  session.board.push(msg);
  return msg;
}

export function readBoard(
  session: SwarmSession,
  forWorkstream?: string,
  types?: BoardMessage['type'][],
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

export function buildBoardContext(session: SwarmSession, forWorkstream: string): string {
  const messages = readBoard(session, forWorkstream);
  if (messages.length === 0) return '';

  const lines: string[] = ['', '--- FINDINGS FROM OTHER WORKSTREAMS ---'];
  for (const msg of messages) {
    lines.push(`[${msg.type.toUpperCase()}] ${msg.content}`);
  }
  lines.push('--- END FINDINGS ---');
  lines.push('');
  return lines.join('\n');
}

export function getReadyWorkstreams(session: SwarmSession): Workstream[] {
  return session.workstreams.filter((ws) => {
    if (ws.status !== 'pending' && ws.status !== 'ready') return false;
    // Check all dependencies are done
    const depsReady = ws.dependencies.every((depId) => {
      const dep = session.workstreams.find((w) => w.id === depId);
      return dep && dep.status === 'done';
    });
    if (depsReady) ws.status = 'ready';
    return depsReady;
  });
}

export function getBlockedWorkstreams(session: SwarmSession): Workstream[] {
  return session.workstreams.filter((ws) => {
    if (ws.status !== 'pending') return false;
    return ws.dependencies.some((depId) => {
      const dep = session.workstreams.find((w) => w.id === depId);
      return !dep || dep.status !== 'done';
    });
  });
}

// ── 3-Tier Hierarchy: Grouping & Manager Assignment ───────────────────
// L1 orchestrator dispatches L2 managers (not L3 workers).
// Each L2 manager gets a group of workstreams and spawns its own L3 workers.
// Manager models differ from their worker models for provider diversity.
// All model assignments go through resolveModel() for automatic fallback.

const MANAGER_AGENT_DEFS: Array<{ agent: string; model: string; provider: string }> = [
  { agent: 'manager-anthropic', model: 'claude-sonnet-4.5',    provider: 'anthropic' },
  { agent: 'manager-openai',    model: 'gpt-5.3-codex',        provider: 'openai' },
  { agent: 'manager-gemini',    model: 'gemini-3-pro-preview',  provider: 'google' },
  { agent: 'manager-anthropic', model: 'claude-sonnet-4',       provider: 'anthropic' },
  { agent: 'manager-openai',    model: 'gpt-5.2-codex',        provider: 'openai' },
];

/** Get a validated manager definition — resolves model with fallback */
function getValidManagerDef(index: number): { agent: string; model: string; provider: string } {
  const def = MANAGER_AGENT_DEFS[index % MANAGER_AGENT_DEFS.length];
  const resolved = resolveModel(def.model);
  const resolvedProvider = getModelProvider(resolved);
  // If model fell back to different provider, update agent name to match
  const agent = resolvedProvider !== 'unknown'
    ? getManagerAgentName(resolved)
    : def.agent;
  return { agent, model: resolved, provider: resolvedProvider !== 'unknown' ? resolvedProvider : def.provider };
}

// Workers assigned to each manager should use DIFFERENT providers than the manager
function getWorkerModelsForManager(managerProvider: string, workerCount: number): string[] {
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
    case 'anthropic': return 'manager-anthropic';
    case 'openai': return 'manager-openai';
    case 'google': return 'manager-gemini';
    default: return 'manager-anthropic';
  }
}

export function getWorkerAgentName(modelId: string): string {
  const provider = getModelProvider(modelId);
  switch (provider) {
    case 'anthropic': return 'worker-anthropic';
    case 'openai': return 'worker-openai';
    case 'google': return 'worker-gemini';
    default: return 'worker';
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

    const workerSlots: WorkerSlot[] = groupWorkstreams.map((ws, i) => ({
      workstreamId: ws.id,
      agentType: getWorkerAgentName(workerModels[i]),
      model: workerModels[i],
      description: ws.description,
      files: ws.files,
    }));

    groups.push({
      id: `group-${g}`,
      managerAgent: managerDef.agent,
      managerModel: managerDef.model,
      workerSlots,
      plan: '',
      status: 'pending',
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
  // Get cross-group findings (blue lines: L2↔L2 communication)
  const otherGroupMsgs = session.board.filter(m =>
    m.group !== group.id && (m.type === 'report' || m.type === 'finding' || m.type === 'decision')
  );
  const crossGroupCtx = otherGroupMsgs.length > 0
    ? otherGroupMsgs.map(m =>
        `[${m.level}/${m.group ?? m.workstream}] ${m.type.toUpperCase()}: ${m.content}`
      ).join('\n')
    : 'No cross-group messages yet.';

  const workerSpecs = group.workerSlots.map((ws, i) => {
    const filesStr = ws.files.length > 0 ? `Files: ${ws.files.join(', ')}` : 'Files: TBD';
    return `  Worker ${i}: subagent_type="${ws.agentType}" | Workstream: ${ws.workstreamId} | ${ws.description} | ${filesStr}`;
  }).join('\n');

  const scratchDir = `${session.outputDir}/${group.id}`;
  const statusFile = `${session.outputDir}/${group.id}-status.md`;
  const statusBoard = `${session.outputDir}/status-board.md`;

  return [
    history,
    '',
    '═══════════════════════════════════════════════════════════════',
    `YOUR ROLE: L2 AGENT MANAGER — ${group.id}`,
    `PHASE: ${phaseName}`,
    '═══════════════════════════════════════════════════════════════',
    '',
    '## HIERARCHY',
    '```',
    'L1 Orchestrator (the boss — makes strategic decisions, resolves debates)',
    `  └── YOU: L2 Manager [${group.id}] (plan, delegate, coordinate, report)`,
    group.workerSlots.map((ws, i) =>
      `        └── L3 Worker ${i} [${ws.workstreamId}] (${ws.agentType})`
    ).join('\n'),
    '```',
    '',
    '## YOUR TEAM',
    workerSpecs,
    '',
    '## COMMUNICATION CHANNELS',
    '',
    '### 🔴 STATUS REPORTING (L2 → L1) — MANDATORY',
    'The orchestrator needs to see the big picture while you work.',
    `Your status file: ${statusFile}`,
    `Global status board: ${statusBoard}`,
    '',
    'You MUST update your status file at EVERY milestone:',
    '```bash',
    `cat >> ${statusFile} << 'EOF'`,
    `[$(date +%H:%M:%S)] PHASE: planning | STATUS: <status> | SUMMARY: <1-line big picture>`,
    'EOF',
    '```',
    '',
    'Required status updates:',
    '  1. After planning: what you intend to do, how work is split',
    '  2. After dispatching workers: which workers launched, what each is doing',
    '  3. After each worker completes: pass/fail, key findings',
    '  4. After coordination: conflicts found, how resolved',
    '  5. Before final report: executive summary for the boss',
    '',
    `Also append to the global board so the boss sees all teams:`,
    '```bash',
    `echo "[${group.id}] $(date +%H:%M:%S) | <status>" >> ${statusBoard}`,
    '```',
    '',
    '### 🔵 Intra-team (your workers talk to each other)',
    `Workers share a scratch directory: ${scratchDir}/`,
    'Tell each worker to:',
    `  1. Write their findings to ${scratchDir}/<workstream-id>-findings.md`,
    `  2. Read ${scratchDir}/ for teammate findings before finalizing`,
    'This lets workers on your team coordinate without going through you.',
    '',
    '### 🔵 Cross-team context (from other L2 managers)',
    crossGroupCtx,
    '',
    '### ⚠️ Escalation (debates → L1 boss)',
    'If your workers disagree and you CANNOT resolve it:',
    '  - Do NOT guess. Mark it as ESCALATION in your report.',
    `  - Write it to ${statusFile} immediately so the boss can see it.`,
    '  - The L1 orchestrator (the boss) will make the call.',
    '',
    '## EXECUTION PROTOCOL',
    '',
    `1. SETUP: mkdir -p ${scratchDir} && touch ${statusFile}`,
    `   Update status: "PLANNING — analyzing task and dividing work"`,
    '',
    '2. PLAN: Analyze the task. Decide how to split work across your workers.',
    '   Update status: "PLANNED — <summary of plan>"',
    '',
    '3. DISPATCH ALL WORKERS SIMULTANEOUSLY:',
    '   For EACH worker, call task() in the SAME message:',
    '   ```',
    '   task(subagent_type="<agent>", description="<task>", prompt="<instructions>")',
    '   ```',
    '   In each worker prompt, include:',
    `   - Their specific assignment and files`,
    `   - Path to scratch dir (${scratchDir}) for team communication`,
    '   - Context from cross-team findings above',
    '   Update status: "DISPATCHED — N workers launched"',
    '',
    '4. REVIEW & COORDINATE:',
    '   - Check each worker\'s output for quality',
    '   - If workers conflict: resolve it yourself OR re-dispatch with clarification',
    '   - If a debate is unresolvable: mark as ESCALATION',
    '   Update status after each worker: "WORKER <id> COMPLETE — <1-line result>"',
    '',
    '5. SYNTHESIZE & REPORT in this EXACT format:',
    '',
    '## Plan',
    '<how you divided work across your team>',
    '',
    '## Results',
    '<synthesized deliverable from all workers>',
    '',
    '## Team Coordination',
    '<how workers communicated, conflicts resolved>',
    '',
    '## Issues',
    '<problems found, blockers hit>',
    '',
    '## Escalations',
    '<NONE or unresolved debates that need L1 boss decision>',
    '',
    '## Cross-Team Notes',
    '<things other L2 managers should know about your work>',
    '',
    '─── CRITICAL: DO NOT DO THE WORK YOURSELF ───',
    'You are a manager. Spawn workers. Only touch code to resolve worker conflicts.',
  ].join('\n');
}

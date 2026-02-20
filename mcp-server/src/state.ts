// ── Types ──────────────────────────────────────────────────────────────

export type Tier = 'duo' | 'trio' | 'full-swarm' | 'blitz' | 'debate';
export type ExecutionMode = 'task' | 'subprocess';

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
  history: HistoryEntry[];
  rounds: RoundRecord[];
  maxLoops: number;
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
];

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
};

// ── Session Store ──────────────────────────────────────────────────────

export const sessions = new Map<string, SwarmSession>();

let idCounter = 0;
function generateId(): string {
  idCounter++;
  return `swarm-${Date.now()}-${idCounter}`;
}

export function createSession(tier: Tier, task: string, executionMode: ExecutionMode = 'task'): SwarmSession {
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
    history: [],
    rounds: [],
    maxLoops: 3,
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

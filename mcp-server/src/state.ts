// ── Types ──────────────────────────────────────────────────────────────

export type Tier = 'duo' | 'trio' | 'full-swarm' | 'blitz' | 'debate';

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
}

// ── Model Rotation ─────────────────────────────────────────────────────

export const CODER_MODELS = [
  'claude-sonnet-4.6',
  'gpt-5.1-codex',
  'claude-sonnet-4.5',
  'gpt-5.2-codex',
] as const;

export const CRITIC_MODELS = [
  'gpt-5.2-codex',
  'claude-sonnet-4.6',
] as const;

export function getCoderModel(workstreamIndex: number): string {
  return CODER_MODELS[workstreamIndex % CODER_MODELS.length];
}

export function getCriticModel(batchIndex: number): string {
  return CRITIC_MODELS[batchIndex % CRITIC_MODELS.length];
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

const HAIKU = 'claude-haiku-4.5';
const OPUS = 'claude-opus-4.6';

export const TIER_PHASES: Record<Tier, PhaseDefinition[]> = {
  duo: [
    def('implement', 'clean-code', getCoderModel(0), 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'sync', false, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
  ],
  trio: [
    def('design', 'architect', OPUS, 'sync', false, false, false),
    def('implement', 'clean-code', getCoderModel(0), 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'sync', false, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
    def('validate', 'task', '', 'sync', false, false, false),
  ],
  'full-swarm': [
    def('explore', 'explore', HAIKU, 'background', true, true, false),
    def('merge_explore', 'general-purpose', HAIKU, 'sync', false, false, false),
    def('design', 'architect', OPUS, 'sync', false, false, false),
    def('implement', 'clean-code', getCoderModel(0), 'background', true, true, false),
    def('merge_impl', 'general-purpose', HAIKU, 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'background', true, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
    def('integration', 'task', '', 'sync', false, false, false),
    def('validate', 'task', '', 'sync', false, false, false),
    def('synthesize', 'architect', OPUS, 'sync', false, false, false),
  ],
  blitz: [
    def('recon', 'explore', HAIKU, 'background', true, true, false),
    def('merge_recon', 'general-purpose', HAIKU, 'sync', false, false, false),
    def('triage', 'architect', OPUS, 'sync', false, false, false),
    def('build', 'clean-code', getCoderModel(0), 'background', true, true, false),
    def('merge_build', 'general-purpose', HAIKU, 'sync', false, false, false),
    def('review', 'code-review', getCriticModel(0), 'background', true, true, false),
    def('merge_review', 'general-purpose', HAIKU, 'sync', false, false, false),
    def('gate', 'task', '', 'sync', false, false, true),
    def('integration', 'task', '', 'sync', false, false, false),
    def('validate', 'task', '', 'sync', false, false, false),
    def('synthesize', 'architect', OPUS, 'sync', false, false, false),
  ],
  debate: [
    def('propose', 'architect', OPUS, 'background', true, false, false),
    def('critique', 'code-review', getCriticModel(0), 'background', true, false, false),
    def('rebuttal', 'architect', OPUS, 'background', true, false, false),
    def('merge_debate', 'general-purpose', HAIKU, 'sync', false, false, false),
    def('synthesize', 'architect', OPUS, 'sync', false, false, false),
  ],
};

// ── Session Store ──────────────────────────────────────────────────────

export const sessions = new Map<string, SwarmSession>();

let idCounter = 0;
function generateId(): string {
  idCounter++;
  return `swarm-${Date.now()}-${idCounter}`;
}

export function createSession(tier: Tier, task: string): SwarmSession {
  const phaseDefs = TIER_PHASES[tier];
  const phases: PhaseState[] = phaseDefs.map((p) => ({
    name: p.name,
    status: 'pending',
    agentIds: [],
    outputs: [],
  }));

  const session: SwarmSession = {
    id: generateId(),
    tier,
    task,
    phases,
    currentPhaseIndex: 0,
    workstreams: [],
    history: [],
    rounds: [],
    maxLoops: 3,
    createdAt: new Date(),
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

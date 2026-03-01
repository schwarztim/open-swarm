// ── Swarm Types ───────────────────────────────────────────────────────
// Shared type definitions used across multiple swarm modules.
// Extracted from state.ts to prevent circular dependencies.

export type Tier =
  | "duo"
  | "trio"
  | "full-swarm"
  | "blitz"
  | "debate"
  | "unleashed";
export type ExecutionMode = "task" | "subprocess";

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
  | "integration"
  | "database"
  | "auth"
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

// ── Phase Types ───────────────────────────────────────────────────────

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
  name: string;
  command: string;
  expect: string;
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

// ── Workstream & Hierarchy Types ──────────────────────────────────────

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
  dependencies: string[];
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
  workstream: string;
  type: BoardMessageType;
  level: "L1" | "L2" | "L3";
  group?: string;
  debateId?: string;
  content: string;
  timestamp: number;
}

export interface AgentGroup {
  id: string;
  managerAgent: string;
  managerModel: string;
  workerSlots: WorkerSlot[];
  plan: string;
  status: "pending" | "dispatched" | "reporting" | "done";
  report?: string;
  healthStatus?: "healthy" | "degraded" | "failed";
  failureReason?: string;
  submittedAt?: number;
}

export interface WorkerSlot {
  workstreamId: string;
  agentType: string;
  model: string;
  description: string;
  files: string[];
  role: WorkerRole;
  mode: WorkerMode;
  complexity?: TaskComplexity;
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
  agentGroups: AgentGroup[];
  history: HistoryEntry[];
  rounds: RoundRecord[];
  board: BoardMessage[];
  debates: DebateState[];
  claims: FileClaim[];
  patterns: PatternEntry[];
  consensuses: ConsensusState[];
  patternIdsUsed: string[];
  promptStore: Map<string, string>;
  validationResults: ValidationResult[];
  maxLoops: number;
  concurrency: number;
  createdAt: Date;
  executionMode: ExecutionMode;
  outputDir: string;
  validationRetries?: number;
}

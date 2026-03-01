// ── State Barrel ──────────────────────────────────────────────────────
// Re-exports all public symbols from extracted modules.
// Maintains backward compatibility for consumers importing from "./state.js".

// ── Types ─────────────────────────────────────────────────────────────
export type {
  Tier,
  ExecutionMode,
  WorkerRole,
  TaskComplexity,
  WorkerMode,
  FileClaim,
  DriftCheck,
  PatternEntry,
  ConsensusState,
  ConsensusProposal,
  DebatePhase,
  DebateStatus,
  DebateTrigger,
  DebateContribution,
  DebateClaim,
  ValidationCheckpoint,
  DebateRound,
  DebatePositionScore,
  DebateEvaluation,
  DebateParticipant,
  DebateState,
  PhaseDefinition,
  PhaseState,
  AcceptanceTest,
  ValidationResult,
  Workstream,
  BoardMessageType,
  BoardMessage,
  AgentGroup,
  WorkerSlot,
  HistoryEntry,
  RoundRecord,
  SwarmSession,
} from "./swarm-types.js";

export type { RatePreset, RateConfig, ModelEntry } from "./model-registry.js";

// ── Model Registry ────────────────────────────────────────────────────
export {
  ALL_MODELS,
  setAvailableModels,
  getAvailableModels,
  resolveModel,
  resolveModelTracked,
  getFallbackLog,
  premiumPool,
  coderPool,
  criticPool,
  fastPool,
  getArchitectModel,
  getCoderModel,
  getCriticModel,
  getFastModel,
  getSynthesizerModel,
  getModelProvider,
} from "./model-registry.js";

// ── Rate Limiting ─────────────────────────────────────────────────────
export {
  TokenBucket,
  checkRateLimit,
  getRateLimitStatus,
  clearRateLimiters,
  RATE_PRESETS,
  resolveRateLimit,
} from "./rate-limiter.js";

// ── Phase Engine ──────────────────────────────────────────────────────
export { TIER_PHASES, getPhaseDefinition } from "./phase-engine.js";

// ── Session Store ─────────────────────────────────────────────────────
export {
  sessions,
  createSession,
  getSession,
  getAllSessions,
  destroySession,
  cleanupStaleSessions,
} from "./session.js";

// ── Board ─────────────────────────────────────────────────────────────
export {
  stripIdentity,
  postToBoard,
  readBoard,
  buildBoardContext,
} from "./board.js";

// ── Prompt Builder ────────────────────────────────────────────────────
export {
  storePrompt,
  getPrompt,
  buildAnonymousHistory,
  buildManagerPrompt,
} from "./prompt-builder.js";

// ── Hierarchy & Coordination ──────────────────────────────────────────
export {
  selectTier,
  analyzeTaskComplexity,
  updateReadyWorkstreams,
  getReadyWorkstreams,
  getBlockedWorkstreams,
  getManagerAgentName,
  getWorkerAgentName,
  getRoleAgentName,
  classifyTaskComplexity,
  inferWorkerRole,
  getModelForComplexity,
  groupWorkstreams,
  DRIFT_THRESHOLD,
  checkDrift,
  createConsensus,
  getConsensus,
  submitProposal,
  evaluateConsensus,
  parseAcceptanceTests,
  getVerifierModel,
  buildVerifierPrompt,
} from "./hierarchy.js";

// ── Debate Protocol ───────────────────────────────────────────────────
export {
  generateDebateId,
  getDebaterModel,
  getDebaterAgentType,
  createDebate,
  getDebate,
  advanceDebatePhase,
  buildDebatePositionPrompt,
  buildDebateCritiquePrompt,
  buildDebateRebuttalPrompt,
  buildDebateSynthesisPrompt,
  buildEscalationContext,
  scoreDebatePositions,
  computeDebateConvergence,
  detectDebateSycophancy,
  buildDebateEvaluation,
  extractClaimsFromPositions,
  updateClaimConsensus,
  getPartialConsensus,
  checkFastTrack,
  assignContrarian,
  buildContrarianPrompt,
  createValidationCheckpoint,
  submitValidation,
} from "./debate.js";

// ── File Claims ───────────────────────────────────────────────────────
export {
  claimFiles,
  releaseFiles,
  checkFileClaims,
  getClaimsForWorkstream,
  getAllActiveClaims,
} from "./file-claims.js";

// ── advancePhase wrapper ──────────────────────────────────────────────
// The original advancePhase(sessionId: string) looked up the session from
// the sessions Map. The extracted phase-engine.ts takes SwarmSession directly.
// This wrapper preserves the original signature for backward compatibility.

import { advancePhase as _advancePhaseSession } from "./phase-engine.js";
import { sessions as _sessions } from "./session.js";
import type { PhaseState } from "./swarm-types.js";

export function advancePhase(sessionId: string): PhaseState {
  const session = _sessions.get(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return _advancePhaseSession(session);
}

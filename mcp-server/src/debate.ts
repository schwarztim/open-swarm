// ── Debate Protocol ───────────────────────────────────────────────────
// Barrel file — re-exports all public symbols from extracted modules.

export {
  generateDebateId,
  getDebaterModel,
  getDebaterAgentType,
  createDebate,
  getDebate,
  advanceDebatePhase,
} from "./debate-core.js";

export {
  buildDebatePositionPrompt,
  buildDebateCritiquePrompt,
  buildDebateRebuttalPrompt,
  buildDebateSynthesisPrompt,
  buildEscalationContext,
  buildContrarianPrompt,
} from "./debate-prompts.js";

export {
  scoreDebatePositions,
  computeDebateConvergence,
  detectDebateSycophancy,
  buildDebateEvaluation,
} from "./debate-scoring.js";

export {
  extractClaimsFromPositions,
  updateClaimConsensus,
  getPartialConsensus,
  checkFastTrack,
  assignContrarian,
  createValidationCheckpoint,
  submitValidation,
} from "./debate-claims.js";

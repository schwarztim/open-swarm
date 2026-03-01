// ── Hierarchy & Coordination ──────────────────────────────────────────
// Barrel file — re-exports all public symbols from extracted modules.

export {
  analyzeTaskComplexity,
  selectTier,
  classifyTaskComplexity,
  getModelForComplexity,
} from "./tier-selection.js";

export {
  updateReadyWorkstreams,
  getReadyWorkstreams,
  getBlockedWorkstreams,
  groupWorkstreams,
} from "./workstream-management.js";

export {
  getManagerAgentName,
  getWorkerAgentName,
  getRoleAgentName,
  inferWorkerRole,
} from "./agent-naming.js";

export {
  DRIFT_THRESHOLD,
  checkDrift,
  createConsensus,
  getConsensus,
  submitProposal,
  evaluateConsensus,
} from "./drift-detection.js";

export {
  parseAcceptanceTests,
  getVerifierModel,
  buildVerifierPrompt,
} from "./verification.js";

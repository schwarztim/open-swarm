/**
 * Integration tests for Open Swarm MCP server.
 * Run with: npx tsx test/integration.test.ts
 *
 * Tests cover:
 * - swarm_init → swarm_next → swarm_submit lifecycle
 * - Debate protocol
 * - File claims
 * - Pattern memory persistence
 * - Worker consensus
 * - Tier selection
 * - Anti-drift enforcement
 */

import {
  handleSwarmInit,
  handleSwarmNext,
  handleSwarmSubmit,
  handleSwarmStatus,
  handleSwarmGate,
  handleSwarmRelay,
  handleSwarmDebate,
  handleSwarmClaim,
  handleSwarmMemory,
  handleSwarmConsensus,
} from "../src/tools.js";

// ── Test Helpers ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function parse(result: {
  content: Array<{ type: string; text: string }>;
}): any {
  return JSON.parse(result.content[0].text);
}

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

function section(name: string): void {
  console.log(`\n── ${name} ──`);
}

// ── Tests ─────────────────────────────────────────────────────────────

section("Swarm Lifecycle: init → next → submit");

// 1. swarm_init
const initResult = parse(handleSwarmInit({ task: "Build a login page" }));
assert(!!initResult.sessionId, "swarm_init returns sessionId");
assert(initResult.tier === "duo", "auto-selects duo tier for simple task");
assert(initResult.totalPhases > 0, "has phases defined");
const sessionId = initResult.sessionId;

// 2. swarm_next
const nextResult = parse(handleSwarmNext({ sessionId }));
assert(nextResult.phase === "implement", "first phase is implement");
assert(nextResult.parallel === false, "duo tier is non-parallel");
assert(!!nextResult.taskCall, "returns taskCall for dispatch");

// 3. swarm_submit
const submitResult = parse(
  handleSwarmSubmit({
    sessionId,
    output:
      "Built the login page with email and password fields for the login page task",
  }),
);
assert(!submitResult.error, "submit succeeds without error");
assert(submitResult.phaseStatus === "done", "phase marked as done");

// 4. swarm_status
const statusResult = parse(handleSwarmStatus({ sessionId }));
assert(statusResult.tier === "duo", "status shows correct tier");
assert(statusResult.phases.length > 0, "status shows phases");

section("Tier Selection");

const fullSwarm = parse(
  handleSwarmInit({ task: "Refactor the authentication architecture" }),
);
assert(fullSwarm.tier === "full-swarm", "complex task selects full-swarm tier");

const debateTier = parse(
  handleSwarmInit({ task: "Debate which approach is better for caching" }),
);
assert(debateTier.tier === "debate", "debate keyword selects debate tier");

const blitzTier = parse(handleSwarmInit({ task: "Fix stuff", fileCount: 100 }));
assert(blitzTier.tier === "blitz", "high file count selects blitz tier");

section("Anti-Drift Enforcement");

const driftSession = parse(
  handleSwarmInit({ task: "Implement user authentication with JWT tokens" }),
);
const driftSid = driftSession.sessionId;
// Advance to in_progress
parse(handleSwarmNext({ sessionId: driftSid }));

// Submit something totally off-topic
const driftResult = parse(
  handleSwarmSubmit({
    sessionId: driftSid,
    output:
      "Here is a recipe for chocolate cake with vanilla frosting and sprinkles",
  }),
);
assert(!!driftResult.error, "off-topic output is rejected by drift check");
assert(
  driftResult.error?.includes("drifted") ||
    driftResult.error?.includes("rejected"),
  "error message mentions drift",
);

// Submit something on-topic
const onTopicResult = parse(
  handleSwarmSubmit({
    sessionId: driftSid,
    output:
      "Implemented JWT authentication with token generation, validation middleware, and user session management. Added bcrypt password hashing.",
  }),
);
assert(!onTopicResult.error, "on-topic output is accepted");

section("Debate Protocol");

const debateInit = parse(
  handleSwarmInit({ task: "Design the API", tier: "debate" }),
);
const debateSid = debateInit.sessionId;

// Start a debate
const debateStart = parse(
  handleSwarmDebate({
    sessionId: debateSid,
    action: "start",
    topic: "REST vs GraphQL for the API",
    trigger: "explicit",
    participantCount: 2,
    maxRounds: 2,
  }),
);
assert(!!debateStart.debateId, "debate start returns debateId");
assert(debateStart.participants.length === 2, "debate has 2 participants");
const debateId = debateStart.debateId;

// Get next phase (should be position)
const debateNext = parse(
  handleSwarmDebate({
    sessionId: debateSid,
    action: "next",
    debateId,
  }),
);
assert(debateNext.phase === "position", "first debate phase is position");
assert(debateNext.taskCalls?.length === 2, "position phase has 2 task calls");

// Submit positions
for (const tc of debateNext.taskCalls) {
  parse(
    handleSwarmDebate({
      sessionId: debateSid,
      action: "submit",
      debateId,
      slotId: tc.slotId,
      content: `Position from ${tc.slotId}: REST is better because of simplicity and caching`,
    }),
  );
}

// Check status
const debateStatus = parse(
  handleSwarmDebate({
    sessionId: debateSid,
    action: "status",
    debateId,
  }),
);
assert(debateStatus.status === "active", "debate is active after submissions");
assert(debateStatus.rounds?.length >= 1, "debate has at least one round");

section("File Claims");

const claimInit = parse(
  handleSwarmInit({ task: "Edit multiple files", tier: "full-swarm" }),
);
const claimSid = claimInit.sessionId;

// Claim files
const claimResult = parse(
  handleSwarmClaim({
    sessionId: claimSid,
    action: "claim",
    paths: ["src/auth.ts", "src/login.ts"],
    workstreamId: "ws-0",
    groupId: "group-0",
  }),
);
assert(!claimResult.error, "file claim succeeds");
assert(
  claimResult.claimed?.length === 2 || claimResult.action === "claim",
  "claimed 2 files",
);

// Check claims
const checkResult = parse(
  handleSwarmClaim({
    sessionId: claimSid,
    action: "check",
    paths: ["src/auth.ts"],
  }),
);
assert(!checkResult.error, "claim check succeeds");

// Attempt conflicting claim
const conflictResult = parse(
  handleSwarmClaim({
    sessionId: claimSid,
    action: "claim",
    paths: ["src/auth.ts"],
    workstreamId: "ws-1",
    groupId: "group-1",
  }),
);
// Should report conflict
assert(
  conflictResult.conflicts?.length > 0 || conflictResult.error,
  "conflicting claim is detected",
);

// Release files
const releaseResult = parse(
  handleSwarmClaim({
    sessionId: claimSid,
    action: "release",
    paths: ["src/auth.ts", "src/login.ts"],
    workstreamId: "ws-0",
  }),
);
assert(!releaseResult.error, "file release succeeds");

// List all claims
const listResult = parse(
  handleSwarmClaim({
    sessionId: claimSid,
    action: "list",
  }),
);
assert(!listResult.error, "list claims succeeds");

section("Pattern Memory");

const memInit = parse(handleSwarmInit({ task: "Auth implementation" }));
const memSid = memInit.sessionId;

// Store a pattern
const storeResult = parse(
  handleSwarmMemory({
    sessionId: memSid,
    action: "store",
    taskType: "auth-jwt",
    approach: "JWT with refresh tokens and bcrypt hashing",
    filesInvolved: ["src/auth.ts", "src/middleware.ts"],
    qualityScore: 9,
    keyDecisions: ["Used RS256 for JWT signing", "Refresh token rotation"],
    tags: ["auth", "jwt", "security"],
  }),
);
assert(!storeResult.error, "pattern store succeeds");
assert(
  !!storeResult.patternId || !!storeResult.pattern,
  "returns pattern identifier",
);

// Search patterns
const searchResult = parse(
  handleSwarmMemory({
    sessionId: memSid,
    action: "search",
    query: "authentication jwt",
  }),
);
assert(!searchResult.error, "pattern search succeeds");
assert(
  searchResult.patterns?.length > 0 || searchResult.results?.length > 0,
  "search finds stored pattern",
);

// List all patterns
const listPatterns = parse(
  handleSwarmMemory({
    sessionId: memSid,
    action: "list",
  }),
);
assert(!listPatterns.error, "pattern list succeeds");

section("Worker Consensus");

const consInit = parse(
  handleSwarmInit({ task: "Build user service", tier: "full-swarm" }),
);
const consSid = consInit.sessionId;

// Start consensus
const consStart = parse(
  handleSwarmConsensus({
    sessionId: consSid,
    action: "start",
    groupId: "group-0",
    topic: "Database schema for users table",
  }),
);
assert(!consStart.error, "consensus start succeeds");
assert(!!consStart.consensusId, "returns consensusId");
const consensusId = consStart.consensusId;

// Submit proposals
parse(
  handleSwarmConsensus({
    sessionId: consSid,
    action: "propose",
    consensusId,
    workstreamId: "ws-0",
    slotId: "proposer-0",
    model: "claude-sonnet-4.5",
    content:
      "Use PostgreSQL with UUID primary keys and JSONB for flexible attributes in the users database table schema",
  }),
);

parse(
  handleSwarmConsensus({
    sessionId: consSid,
    action: "propose",
    consensusId,
    workstreamId: "ws-1",
    slotId: "proposer-1",
    model: "gpt-5.2-codex",
    content:
      "Use PostgreSQL with UUID primary keys and structured columns for the users database table schema design",
  }),
);

// Evaluate consensus
const evalResult = parse(
  handleSwarmConsensus({
    sessionId: consSid,
    action: "evaluate",
    consensusId,
  }),
);
assert(!evalResult.error, "consensus evaluate succeeds");
assert(
  evalResult.convergenceScore !== undefined,
  "evaluate returns convergence score",
);
assert(!!evalResult.recommendation, "evaluate returns recommendation");

// Check status
const consStatus = parse(
  handleSwarmConsensus({
    sessionId: consSid,
    action: "status",
    consensusId,
  }),
);
assert(!consStatus.error, "consensus status succeeds");

section("Board Relay");

const relayInit = parse(handleSwarmInit({ task: "Multi-team project" }));
const relaySid = relayInit.sessionId;

const relayResult = parse(
  handleSwarmRelay({
    sessionId: relaySid,
    workstream: "ws-0",
    type: "finding",
    level: "L2",
    content: "Found a shared utility that both teams can use",
  }),
);
assert(!relayResult.error, "relay posting succeeds");

// ── Summary ───────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`\nFailures:`);
  for (const f of failures) {
    console.log(`  ✗ ${f}`);
  }
}
console.log(`${"═".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);

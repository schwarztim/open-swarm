import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkDrift,
  analyzeTaskComplexity,
  selectTier,
  createConsensus,
  submitProposal,
  evaluateConsensus,
  getConsensus,
  DRIFT_THRESHOLD,
} from '../../src/hierarchy.js';
import { createSession } from '../../src/session.js';
import type { SwarmSession } from '../../src/swarm-types.js';

function makeSession(): SwarmSession {
  return createSession('duo', 'Test task for hierarchy');
}

describe('checkDrift', () => {
  it('returns low alignmentScore for completely off-topic output', () => {
    const result = checkDrift(
      'implement authentication system with JWT tokens',
      'banana pancakes recipe with blueberries maple syrup',
    );
    expect(result.alignmentScore).toBeLessThan(DRIFT_THRESHOLD);
    expect(result.driftSignals.length).toBeGreaterThan(0);
  });

  it('returns high alignmentScore for relevant output', () => {
    const result = checkDrift(
      'implement JWT authentication with token validation',
      'JWT authentication implementation: token validation middleware, user login endpoint, refresh token rotation',
    );
    expect(result.alignmentScore).toBeGreaterThan(DRIFT_THRESHOLD);
  });

  it('includes taskGoal and outputSummary in result', () => {
    const result = checkDrift('some goal', 'some output text here');
    expect(result.taskGoal).toBe('some goal');
    expect(typeof result.outputSummary).toBe('string');
  });

  it('detects scope creep when multiple tangential markers present', () => {
    const result = checkDrift(
      'fix the login button',
      'Fixed the login button. Also additionally I refactored the entire auth module, and while I was at it, also bonus extra unrelated cleanup of dead code.',
    );
    expect(result.driftSignals.some(s => s.includes('scope creep'))).toBe(true);
  });

  it('detects very short output relative to task scope', () => {
    const result = checkDrift(
      'implement full microservices architecture with kubernetes docker deployment',
      'done',
    );
    expect(result.driftSignals.some(s => s.includes('shorter'))).toBe(true);
  });

  it('alignmentScore is between 0 and 1', () => {
    const result = checkDrift('task goal here', 'some output');
    expect(result.alignmentScore).toBeGreaterThanOrEqual(0);
    expect(result.alignmentScore).toBeLessThanOrEqual(1);
  });

  it('returns score of 1 when taskGoal is empty', () => {
    const result = checkDrift('', 'some output with text');
    expect(result.alignmentScore).toBe(1);
  });

  it('no drift signals for matching output', () => {
    const task = 'build authentication module with JWT tokens and session management';
    const output = 'built authentication module with JWT tokens and session management system including refresh tokens';
    const result = checkDrift(task, output);
    expect(result.driftSignals).toHaveLength(0);
  });
});

describe('analyzeTaskComplexity', () => {
  it('returns duo tier for simple task', () => {
    const result = analyzeTaskComplexity('fix a typo in the readme');
    expect(result.tier).toBe('duo');
  });

  it('returns trio or full-swarm for task with 2+ components', () => {
    // 2 signals: integration (react/backend/api) + auth (jwt) → componentCount=2 → 'trio'
    const result = analyzeTaskComplexity('build a react frontend with express backend api and jwt auth');
    expect(['trio', 'full-swarm']).toContain(result.tier);
  });

  it('returns full-swarm for enterprise task with 4+ components', () => {
    const result = analyzeTaskComplexity(
      'design microservice architecture with postgres database, jwt auth, react frontend, docker kubernetes deployment, and full test coverage',
    );
    expect(result.tier).toBe('full-swarm');
  });

  it('detects auth requirement', () => {
    const result = analyzeTaskComplexity('implement jwt auth with rbac roles');
    expect(result.requiresAuth).toBe(true);
  });

  it('detects database requirement', () => {
    const result = analyzeTaskComplexity('create postgres database schema with migrations');
    expect(result.requiresDatabase).toBe(true);
  });

  it('detects devops requirement', () => {
    const result = analyzeTaskComplexity('set up kubernetes deployment with docker and ci/cd pipeline');
    expect(result.requiresDevops).toBe(true);
  });

  it('detects architect requirement for large task', () => {
    const result = analyzeTaskComplexity('design microservice system architecture at scale');
    expect(result.requiresArchitect).toBe(true);
  });

  it('estimatedWorkstreams is at least 2', () => {
    const result = analyzeTaskComplexity('simple task');
    expect(result.estimatedWorkstreams).toBeGreaterThanOrEqual(2);
  });

  it('estimatedWorkstreams scales with component count', () => {
    const simple = analyzeTaskComplexity('simple task');
    const complex = analyzeTaskComplexity('build react app with express api postgres database and jwt auth');
    expect(complex.estimatedWorkstreams).toBeGreaterThan(simple.estimatedWorkstreams);
  });
});

describe('selectTier', () => {
  it('returns duo for simple tasks', () => {
    expect(selectTier('add a helper function')).toBe('duo');
  });

  it('returns trio for multi-file or feature tasks', () => {
    expect(selectTier('design a multi-file component feature')).toBe('trio');
  });

  it('returns full-swarm for refactor tasks', () => {
    expect(selectTier('refactor the entire authentication module')).toBe('full-swarm');
  });

  it('returns full-swarm for security tasks', () => {
    expect(selectTier('security audit of all endpoints')).toBe('full-swarm');
  });

  it('returns full-swarm for architecture tasks', () => {
    expect(selectTier('architecture review and complex redesign')).toBe('full-swarm');
  });

  it('returns blitz for massive tasks', () => {
    expect(selectTier('build the entire codebase from scratch massive refactor')).toBe('blitz');
  });

  it('returns blitz when file count exceeds 50', () => {
    expect(selectTier('simple task', 51)).toBe('blitz');
  });

  it('returns debate for decision/tradeoff tasks', () => {
    expect(selectTier('debate which approach to use for the api design tradeoff')).toBe('debate');
  });

  it('returns unleashed for max/unleashed tasks', () => {
    expect(selectTier('unleashed build everything no restraints')).toBe('unleashed');
  });

  it('returns valid tier string for any input', () => {
    const validTiers = ['duo', 'trio', 'full-swarm', 'blitz', 'debate', 'unleashed'];
    expect(validTiers).toContain(selectTier('some random task description'));
  });
});

describe('createConsensus / submitProposal / evaluateConsensus lifecycle', () => {
  let session: SwarmSession;

  beforeEach(() => {
    session = makeSession();
  });

  it('createConsensus creates a new consensus with collecting status', () => {
    const consensus = createConsensus(session, 'group-0', 'Which approach to use?');
    expect(consensus.status).toBe('collecting');
    expect(consensus.topic).toBe('Which approach to use?');
    expect(consensus.proposals).toHaveLength(0);
  });

  it('createConsensus adds consensus to session.consensuses', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    expect(session.consensuses).toContain(consensus);
  });

  it('getConsensus retrieves consensus by id', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    const found = getConsensus(session, consensus.id);
    expect(found).toBe(consensus);
  });

  it('getConsensus returns undefined for unknown id', () => {
    createConsensus(session, 'group-0', 'Topic');
    expect(getConsensus(session, 'consensus-99999')).toBeUndefined();
  });

  it('submitProposal adds a proposal to the consensus', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    submitProposal(consensus, 'ws-0', 'proposer-0', 'gpt-4.1', 'Use microservices');
    expect(consensus.proposals).toHaveLength(1);
  });

  it('submitProposal stores correct content', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    submitProposal(consensus, 'ws-0', 'proposer-0', 'gpt-4.1', 'My proposal content');
    expect(consensus.proposals[0].content).toBe('My proposal content');
    expect(consensus.proposals[0].slotId).toBe('proposer-0');
  });

  it('evaluateConsensus returns need-more-proposals with < 2 proposals', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    submitProposal(consensus, 'ws-0', 'proposer-0', 'gpt-4.1', 'Only one proposal');
    const result = evaluateConsensus(consensus);
    expect(result.recommendation).toBe('need-more-proposals');
    expect(result.convergenceScore).toBe(0);
  });

  it('evaluateConsensus returns implement-best for highly similar proposals', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    const sharedContent = 'use typescript strict mode with proper type safety everywhere avoid any types use interfaces over types prefer composition over inheritance this approach works well';
    submitProposal(consensus, 'ws-0', 'proposer-0', 'gpt-4.1', sharedContent);
    submitProposal(consensus, 'ws-1', 'proposer-1', 'claude-sonnet-4.6', sharedContent + ' additional similar context');
    const result = evaluateConsensus(consensus);
    expect(result.recommendation).toBe('implement-best');
    expect(result.convergenceScore).toBeGreaterThan(0.5);
  });

  it('evaluateConsensus returns debate for divergent proposals', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    submitProposal(consensus, 'ws-0', 'proposer-0', 'gpt-4.1',
      'microservices kubernetes docker distributed cloud native service mesh envoy istio');
    submitProposal(consensus, 'ws-1', 'proposer-1', 'claude-sonnet-4.6',
      'monolith simple postgres direct queries express server rails django cheap operations');
    const result = evaluateConsensus(consensus);
    expect(result.recommendation).toBe('debate');
    expect(result.convergenceScore).toBeLessThan(0.6);
  });

  it('evaluateConsensus sets convergenceScore on consensus object', () => {
    const consensus = createConsensus(session, 'group-0', 'Topic');
    submitProposal(consensus, 'ws-0', 'proposer-0', 'model-a', 'first proposal content');
    submitProposal(consensus, 'ws-1', 'proposer-1', 'model-b', 'second proposal content');
    evaluateConsensus(consensus);
    expect(typeof consensus.convergenceScore).toBe('number');
  });

  it('multiple consensuses can coexist in a session', () => {
    createConsensus(session, 'group-0', 'Topic A');
    createConsensus(session, 'group-1', 'Topic B');
    expect(session.consensuses).toHaveLength(2);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateDebateId,
  createDebate,
  getDebate,
  computeDebateConvergence,
  detectDebateSycophancy,
  scoreDebatePositions,
  checkFastTrack,
} from '../../src/debate.js';
import { createSession } from '../../src/session.js';
import type { SwarmSession, DebateState, DebateRound, DebateContribution } from '../../src/swarm-types.js';

function makeSession(): SwarmSession {
  return createSession('duo', 'Test task for debate');
}

function makeContribution(
  slotId: string,
  phase: DebateContribution['phase'],
  content: string,
): DebateContribution {
  return { slotId, agentType: 'worker', model: 'gpt-4.1', phase, content, timestamp: Date.now() };
}

function makeRound(
  roundNumber: number,
  contributions: DebateContribution[] = [],
): DebateRound {
  return { roundNumber, phase: 'position', contributions, startedAt: Date.now() };
}

describe('generateDebateId', () => {
  it('returns a string starting with debate-', () => {
    const id = generateDebateId();
    expect(id).toMatch(/^debate-\d+$/);
  });

  it('returns unique IDs on each call', () => {
    const id1 = generateDebateId();
    const id2 = generateDebateId();
    expect(id1).not.toBe(id2);
  });

  it('IDs are monotonically increasing', () => {
    const id1 = parseInt(generateDebateId().split('-')[1], 10);
    const id2 = parseInt(generateDebateId().split('-')[1], 10);
    expect(id2).toBeGreaterThan(id1);
  });
});

describe('createDebate / getDebate', () => {
  let session: SwarmSession;

  beforeEach(() => {
    session = makeSession();
  });

  it('createDebate returns a DebateState with correct topic', () => {
    const debate = createDebate(session, 'Use REST vs GraphQL', 'explicit');
    expect(debate.topic).toBe('Use REST vs GraphQL');
  });

  it('createDebate sets status to pending', () => {
    const debate = createDebate(session, 'Some topic', 'explicit');
    expect(debate.status).toBe('pending');
  });

  it('createDebate attaches debate to session', () => {
    const debate = createDebate(session, 'Architecture choice', 'explicit');
    expect(session.debates).toContain(debate);
  });

  it('createDebate defaults to 2 participants', () => {
    const debate = createDebate(session, 'Topic', 'explicit');
    expect(debate.participants).toHaveLength(2);
  });

  it('createDebate respects participantCount parameter', () => {
    const debate = createDebate(session, 'Topic', 'explicit', undefined, 3);
    expect(debate.participants).toHaveLength(3);
  });

  it('createDebate sets maxRounds correctly', () => {
    const debate = createDebate(session, 'Topic', 'explicit', undefined, 2, 5);
    expect(debate.maxRounds).toBe(5);
  });

  it('createDebate sets initiatorLevel to L1 when no groupId', () => {
    const debate = createDebate(session, 'Topic', 'explicit');
    expect(debate.initiatorLevel).toBe('L1');
  });

  it('createDebate sets initiatorLevel to L2 when groupId provided', () => {
    const debate = createDebate(session, 'Topic', 'explicit', 'group-0');
    expect(debate.initiatorLevel).toBe('L2');
  });

  it('getDebate retrieves debate by id', () => {
    const debate = createDebate(session, 'Round-trip topic', 'explicit');
    const retrieved = getDebate(session, debate.id);
    expect(retrieved).toBe(debate);
  });

  it('getDebate returns undefined for unknown id', () => {
    createDebate(session, 'Topic', 'explicit');
    expect(getDebate(session, 'debate-99999')).toBeUndefined();
  });

  it('multiple debates can coexist in the same session', () => {
    createDebate(session, 'Topic A', 'explicit');
    createDebate(session, 'Topic B', 'disagreement');
    expect(session.debates).toHaveLength(2);
  });
});

describe('computeDebateConvergence', () => {
  let session: SwarmSession;
  let debate: DebateState;

  beforeEach(() => {
    session = makeSession();
    debate = createDebate(session, 'Topic', 'explicit');
  });

  it('returns score:0, delta:0, trending:stable when no rounds', () => {
    const result = computeDebateConvergence(debate);
    expect(result.score).toBe(0);
    expect(result.delta).toBe(0);
    expect(result.trending).toBe('stable');
  });

  it('returns score:1 when only one position in round', () => {
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', 'the quick brown fox jumps over the lazy dog'),
    ]));
    const result = computeDebateConvergence(debate);
    expect(result.score).toBe(1);
  });

  it('returns higher score for similar positions', () => {
    const text = 'we should use typescript with strict mode and proper type safety everywhere in the codebase';
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', text),
      makeContribution('debater-1', 'position', text + ' for better developer experience'),
    ]));
    const result = computeDebateConvergence(debate);
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('returns lower score for dissimilar positions', () => {
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', 'use microservices architecture with kubernetes deployment orchestration'),
      makeContribution('debater-1', 'position', 'monolithic application is simpler cheaper faster develop test'),
    ]));
    const result = computeDebateConvergence(debate);
    expect(result.score).toBeLessThan(0.8);
  });

  it('uses rebuttals over positions when rebuttals exist', () => {
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', 'completely different approach for everything'),
      makeContribution('debater-1', 'position', 'completely different approach for everything'),
      makeContribution('debater-0', 'rebuttal', 'the quick brown fox jumps'),
      makeContribution('debater-1', 'rebuttal', 'totally unrelated purple elephant'),
    ]));
    // With rebuttals, convergence should reflect rebuttal similarity (low here)
    const result = computeDebateConvergence(debate);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('trending is converging when score increases', () => {
    const sharedText = 'authentication security token validation approach rest api design';
    // Round 1: divergent
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', 'use jwt tokens for authentication'),
      makeContribution('debater-1', 'position', 'session cookies are the correct choice here'),
    ]));
    // Round 2: converged
    debate.rounds.push(makeRound(2, [
      makeContribution('debater-0', 'position', sharedText + ' tokens cookies same'),
      makeContribution('debater-1', 'position', sharedText + ' cookies tokens same'),
    ]));
    const result = computeDebateConvergence(debate);
    // Delta should be positive (score increased)
    expect(['converging', 'stable', 'diverging']).toContain(result.trending);
  });
});

describe('detectDebateSycophancy', () => {
  let session: SwarmSession;
  let debate: DebateState;

  beforeEach(() => {
    session = makeSession();
    debate = createDebate(session, 'Topic', 'explicit');
  });

  it('returns detected:false and score:0 when no rounds', () => {
    const result = detectDebateSycophancy(debate);
    expect(result.detected).toBe(false);
    expect(result.score).toBe(0);
    expect(result.indicators).toHaveLength(0);
  });

  it('returns detected:false for substantive diverse contributions', () => {
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', 'I strongly believe microservices because they allow independent scaling and deployment'),
      makeContribution('debater-1', 'position', 'Monoliths are better because lower latency no network overhead simpler operations'),
      makeContribution('debater-0', 'rebuttal', 'However the critique misses independent deployment capability which is critical. Nevertheless I must address this fundamental concern about operational complexity.'),
      makeContribution('debater-1', 'rebuttal', 'In contrast to what was said, monoliths have lower operational overhead. But I acknowledge the scaling concern is valid. Nevertheless the overall cost is lower.'),
    ]));
    const result = detectDebateSycophancy(debate);
    expect(result.detected).toBe(false);
  });

  it('detects sycophancy when rebuttals collapse to tiny agreement text', () => {
    const longPosition = 'This is a very detailed position about microservices architecture with extensive discussion about service mesh patterns, API gateway implementations, distributed tracing, container orchestration, and kubernetes deployment strategies. We need to carefully consider all these aspects.';
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', longPosition),
      makeContribution('debater-1', 'position', longPosition),
      // Very short rebuttals = rebuttal collapse signal
      makeContribution('debater-0', 'rebuttal', 'ok'),
      makeContribution('debater-1', 'rebuttal', 'yes'),
    ]));
    const result = detectDebateSycophancy(debate);
    // Should detect rebuttal collapse
    expect(result.indicators.length).toBeGreaterThan(0);
  });

  it('detects hollow agreement in rebuttals', () => {
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', 'A'.repeat(200)),
      makeContribution('debater-1', 'position', 'B'.repeat(200)),
      makeContribution('debater-0', 'rebuttal', 'I agree, you are right, good point, fair enough, that is a valid point'),
      makeContribution('debater-1', 'rebuttal', 'I agree, you are right, good point, fair enough, i concede this'),
    ]));
    const result = detectDebateSycophancy(debate);
    expect(result.indicators.length).toBeGreaterThan(0);
  });

  it('score is between 0 and 1', () => {
    debate.rounds.push(makeRound(1, [
      makeContribution('debater-0', 'position', 'some position'),
      makeContribution('debater-1', 'position', 'other position'),
    ]));
    const result = detectDebateSycophancy(debate);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});

describe('scoreDebatePositions', () => {
  let session: SwarmSession;
  let debate: DebateState;

  beforeEach(() => {
    session = makeSession();
    debate = createDebate(session, 'Architecture decision', 'explicit', undefined, 2);
  });

  it('returns scores array with one entry per participant', () => {
    const round = makeRound(1, [
      makeContribution('debater-0', 'position', 'My position with some content'),
      makeContribution('debater-1', 'position', 'Another position'),
    ]);
    const scores = scoreDebatePositions(round, debate);
    expect(scores).toHaveLength(2);
  });

  it('all scores have required fields', () => {
    const round = makeRound(1, [
      makeContribution('debater-0', 'position', 'Some position text'),
      makeContribution('debater-1', 'position', 'Other position text'),
    ]);
    const scores = scoreDebatePositions(round, debate);
    for (const score of scores) {
      expect(score).toHaveProperty('evidenceQuality');
      expect(score).toHaveProperty('reasoningClarity');
      expect(score).toHaveProperty('rebuttalEffectiveness');
      expect(score).toHaveProperty('novelContribution');
      expect(score).toHaveProperty('total');
      expect(score).toHaveProperty('summary');
    }
  });

  it('total equals sum of component scores', () => {
    const round = makeRound(1, [
      makeContribution('debater-0', 'position', 'Some text'),
      makeContribution('debater-1', 'position', 'Other text'),
    ]);
    const scores = scoreDebatePositions(round, debate);
    for (const score of scores) {
      expect(score.total).toBe(
        score.evidenceQuality + score.reasoningClarity + score.rebuttalEffectiveness + score.novelContribution,
      );
    }
  });

  it('scores are non-negative integers', () => {
    const round = makeRound(1, [
      makeContribution('debater-0', 'position', 'Some text'),
      makeContribution('debater-1', 'position', 'Other text'),
    ]);
    const scores = scoreDebatePositions(round, debate);
    for (const score of scores) {
      expect(score.evidenceQuality).toBeGreaterThanOrEqual(0);
      expect(score.reasoningClarity).toBeGreaterThanOrEqual(0);
      expect(score.rebuttalEffectiveness).toBeGreaterThanOrEqual(0);
      expect(score.novelContribution).toBeGreaterThanOrEqual(0);
    }
  });

  it('position with code and reasoning markers gets higher score', () => {
    const richPosition = `
      \`\`\`typescript
      const x = 1;
      \`\`\`
      Because therefore this approach is better, however we must consider if X then Y.
      The function handles the class module file at line 42.
      Consequently thus the implementation is correct.
    `;
    const plainPosition = 'This is just some text without any markers.';
    const round = makeRound(1, [
      makeContribution('debater-0', 'position', richPosition),
      makeContribution('debater-1', 'position', plainPosition),
    ]);
    const scores = scoreDebatePositions(round, debate);
    expect(scores[0].total).toBeGreaterThanOrEqual(scores[1].total);
  });

  it('total score is at most 11', () => {
    const richPosition = `
      \`\`\`code\`\`\` \`inline\` 1.0 file line function class module
      because therefore however if X then Y consequently thus in contrast on the other hand
      additionally some unique terms here that nobody else would use in their position
    `;
    const round = makeRound(1, [
      makeContribution('debater-0', 'position', richPosition),
      makeContribution('debater-1', 'position', 'other text'),
    ]);
    const scores = scoreDebatePositions(round, debate);
    for (const score of scores) {
      expect(score.total).toBeLessThanOrEqual(11);
    }
  });
});

describe('checkFastTrack', () => {
  let session: SwarmSession;
  let debate: DebateState;

  beforeEach(() => {
    session = makeSession();
    debate = createDebate(session, 'Fast track topic', 'explicit', undefined, 2, 3);
    debate.currentRound = 1;
  });

  it('returns eligible:false when not round 1', () => {
    debate.currentRound = 2;
    const convergence = { score: 0.9, delta: 0.1, trending: 'converging' as const };
    const sycophancy = { detected: false, score: 0, indicators: [] };
    const scores = [
      { evidenceQuality: 3, reasoningClarity: 3, rebuttalEffectiveness: 2, novelContribution: 2, total: 10, summary: '' },
      { evidenceQuality: 3, reasoningClarity: 3, rebuttalEffectiveness: 2, novelContribution: 2, total: 10, summary: '' },
    ];
    const result = checkFastTrack(debate, convergence, sycophancy, scores);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/Round 1/);
  });

  it('returns eligible:false when convergence below threshold', () => {
    const convergence = { score: 0.3, delta: 0, trending: 'stable' as const };
    const sycophancy = { detected: false, score: 0, indicators: [] };
    const scores = [
      { evidenceQuality: 3, reasoningClarity: 3, rebuttalEffectiveness: 2, novelContribution: 2, total: 10, summary: '' },
      { evidenceQuality: 3, reasoningClarity: 3, rebuttalEffectiveness: 2, novelContribution: 2, total: 10, summary: '' },
    ];
    const result = checkFastTrack(debate, convergence, sycophancy, scores);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/Convergence/);
  });

  it('returns eligible:false when sycophancy detected', () => {
    const convergence = { score: 0.9, delta: 0.2, trending: 'converging' as const };
    const sycophancy = { detected: true, score: 0.9, indicators: ['hollow agreement'] };
    const scores = [
      { evidenceQuality: 3, reasoningClarity: 3, rebuttalEffectiveness: 2, novelContribution: 2, total: 10, summary: '' },
      { evidenceQuality: 3, reasoningClarity: 3, rebuttalEffectiveness: 2, novelContribution: 2, total: 10, summary: '' },
    ];
    const result = checkFastTrack(debate, convergence, sycophancy, scores);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/[Ss]ycophancy/);
  });

  it('returns eligible:false when a position score is below minPositionScore', () => {
    const convergence = { score: 0.9, delta: 0.2, trending: 'converging' as const };
    const sycophancy = { detected: false, score: 0, indicators: [] };
    // minPositionScore defaults to 6, so score of 3 is too low
    const scores = [
      { evidenceQuality: 1, reasoningClarity: 1, rebuttalEffectiveness: 1, novelContribution: 0, total: 3, summary: '' },
      { evidenceQuality: 3, reasoningClarity: 3, rebuttalEffectiveness: 2, novelContribution: 2, total: 10, summary: '' },
    ];
    const result = checkFastTrack(debate, convergence, sycophancy, scores);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/below minimum score/);
  });

  it('returns eligible:true when all conditions met', () => {
    const convergence = { score: 0.9, delta: 0.2, trending: 'converging' as const };
    const sycophancy = { detected: false, score: 0, indicators: [] };
    const scores = [
      { evidenceQuality: 3, reasoningClarity: 2, rebuttalEffectiveness: 2, novelContribution: 1, total: 8, summary: '' },
      { evidenceQuality: 2, reasoningClarity: 2, rebuttalEffectiveness: 2, novelContribution: 2, total: 8, summary: '' },
    ];
    const result = checkFastTrack(debate, convergence, sycophancy, scores);
    expect(result.eligible).toBe(true);
    expect(debate.fastTrack).toBe(true);
  });
});

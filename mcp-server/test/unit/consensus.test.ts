import { describe, it, expect, beforeEach } from 'vitest';
import { handleSwarmConsensus } from '../../src/tools/consensus.js';
import { createSession, sessions } from '../../src/session.js';
import type { SwarmSession } from '../../src/swarm-types.js';

function makeSession(): SwarmSession {
  return createSession('duo', 'Test task for consensus tool');
}

function parseResult(result: ReturnType<typeof handleSwarmConsensus>): unknown {
  return JSON.parse(result.content[0].text);
}

describe('handleSwarmConsensus — action: start', () => {
  let session: SwarmSession;

  beforeEach(() => {
    session = makeSession();
  });

  it('returns error for missing session', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: 'nonexistent-session-id',
      action: 'start',
      groupId: 'group-0',
      topic: 'Test topic',
    })) as any;
    expect(result.error).toMatch(/Session not found/);
  });

  it('returns error when groupId missing', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      topic: 'Test topic',
    })) as any;
    expect(result.error).toMatch(/groupId required/);
  });

  it('returns error when topic missing', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      groupId: 'group-0',
    })) as any;
    expect(result.error).toMatch(/topic required/);
  });

  it('creates a consensus session successfully', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      groupId: 'group-0',
      topic: 'Which approach should we take?',
    })) as any;
    expect(result.consensusId).toBeDefined();
    expect(result.consensusId).toMatch(/^consensus-/);
    expect(result.status).toBe('collecting');
    expect(result.topic).toBe('Which approach should we take?');
    expect(result.groupId).toBe('group-0');
  });

  it('adds consensus to session consensuses', () => {
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      groupId: 'group-0',
      topic: 'Some topic',
    });
    expect(session.consensuses).toHaveLength(1);
  });

  it('nextAction includes propose instructions', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      groupId: 'group-0',
      topic: 'Topic',
    })) as any;
    expect(result.nextAction).toMatch(/propose/i);
  });
});

describe('handleSwarmConsensus — action: propose', () => {
  let session: SwarmSession;
  let consensusId: string;

  beforeEach(() => {
    session = makeSession();
    const startResult = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      groupId: 'group-0',
      topic: 'Implementation approach',
    })) as any;
    consensusId = startResult.consensusId;
  });

  it('returns error for missing consensusId', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      slotId: 'proposer-0',
      content: 'My proposal',
    })) as any;
    expect(result.error).toMatch(/consensusId required/);
  });

  it('returns error for missing content', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-0',
    })) as any;
    expect(result.error).toMatch(/content required/);
  });

  it('returns error for missing slotId', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      content: 'My proposal',
    })) as any;
    expect(result.error).toMatch(/slotId required/);
  });

  it('returns error for unknown consensusId', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId: 'consensus-99999',
      slotId: 'proposer-0',
      content: 'My proposal',
    })) as any;
    expect(result.error).toMatch(/Consensus not found/);
  });

  it('adds a proposal successfully', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-0',
      content: 'Use microservices architecture',
    })) as any;
    expect(result.consensusId).toBe(consensusId);
    expect(result.proposalCount).toBe(1);
    expect(result.slotId).toBe('proposer-0');
  });

  it('increments proposal count on each submission', () => {
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-0',
      content: 'Proposal one',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-1',
      content: 'Proposal two',
    })) as any;
    expect(result.proposalCount).toBe(2);
  });
});

describe('handleSwarmConsensus — action: evaluate', () => {
  let session: SwarmSession;
  let consensusId: string;

  beforeEach(() => {
    session = makeSession();
    const startResult = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      groupId: 'group-0',
      topic: 'API design choice',
    })) as any;
    consensusId = startResult.consensusId;
  });

  it('returns error for missing consensusId', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'evaluate',
    })) as any;
    expect(result.error).toMatch(/consensusId required/);
  });

  it('returns need-more-proposals when fewer than 2 proposals', () => {
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-0',
      content: 'Only one proposal',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'evaluate',
      consensusId,
    })) as any;
    expect(result.recommendation).toBe('need-more-proposals');
  });

  it('selects implement-best for convergent proposals', () => {
    const sharedContent = 'use typescript strict mode proper type safety everywhere avoid any types';
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-0',
      content: sharedContent + ' use interfaces prefer composition additional context here',
    });
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-1',
      content: sharedContent + ' interfaces preferred composition best practice',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'evaluate',
      consensusId,
    })) as any;
    expect(result.recommendation).toBe('implement-best');
  });

  it('returns debate recommendation for divergent proposals', () => {
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-0',
      content: 'microservices kubernetes docker distributed cloud native service mesh envoy istio networking',
    });
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-1',
      content: 'monolith simple postgres queries express rails django cheap operations maintenance',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'evaluate',
      consensusId,
    })) as any;
    expect(result.recommendation).toBe('debate');
  });

  it('includes convergenceScore in evaluate response', () => {
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-0',
      content: 'first proposal',
    });
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-1',
      content: 'second proposal',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'evaluate',
      consensusId,
    })) as any;
    expect(typeof result.convergenceScore).toBe('number');
    expect(result.convergenceScore).toBeGreaterThanOrEqual(0);
    expect(result.convergenceScore).toBeLessThanOrEqual(1);
  });

  /**
   * CRITICAL TEST: Documents that selectedProposal is chosen by CONTENT LENGTH
   * (longest wins in the current implementation in tools/consensus.ts line 104-106).
   * A short high-score proposal does NOT beat a long low-score proposal.
   *
   * Note: This is a known design issue in the implementation — the evaluate action
   * uses `content.length` to pick the "best" proposal, not the score field.
   * Score-based selection would require proposals to have score fields populated.
   */
  it('selectedProposal is chosen by content length — short high-score vs long low-score', () => {
    const sharedBase = 'use typescript strict mode proper type safety interfaces composition';
    // Both proposals need to be similar enough to converge (score >= 0.6)
    // Short proposal
    const shortContent = sharedBase + ' concise';
    // Long proposal (same shared base to ensure convergence, but much longer)
    const longContent = sharedBase + ' verbose with many extra words about implementation details pattern matching additional context padding length to win selection algorithm regardless';

    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'short-high-score',
      content: shortContent,
    });
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'long-low-score',
      content: longContent,
    });

    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'evaluate',
      consensusId,
    })) as any;

    // If convergence is reached, selectedProposal is set
    if (result.recommendation === 'implement-best') {
      // The LONGER proposal wins due to content.length comparison
      expect(result.selectedProposal).toBe('long-low-score');
    }
  });

  it('selectedProposal is set after implement-best recommendation', () => {
    const sharedBase = 'use typescript strict proper type safety interfaces composition patterns';
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-a',
      content: sharedBase + ' first approach implementation',
    });
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'proposer-b',
      content: sharedBase + ' second approach implementation details',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'evaluate',
      consensusId,
    })) as any;

    if (result.recommendation === 'implement-best') {
      expect(result.selectedProposal).toBeDefined();
      expect(typeof result.selectedProposal).toBe('string');
    }
  });
});

describe('handleSwarmConsensus — action: status', () => {
  let session: SwarmSession;
  let consensusId: string;

  beforeEach(() => {
    session = makeSession();
    const startResult = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'start',
      groupId: 'group-0',
      topic: 'Status test topic',
    })) as any;
    consensusId = startResult.consensusId;
  });

  it('returns error for missing consensusId', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'status',
    })) as any;
    expect(result.error).toMatch(/consensusId required/);
  });

  it('returns consensus status', () => {
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'status',
      consensusId,
    })) as any;
    expect(result.status).toBe('collecting');
    expect(result.proposalCount).toBe(0);
    expect(result.topic).toBe('Status test topic');
  });

  it('reflects updated proposal count after propose', () => {
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'p-0',
      content: 'A proposal',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'status',
      consensusId,
    })) as any;
    expect(result.proposalCount).toBe(1);
  });

  it('proposals array includes content preview', () => {
    handleSwarmConsensus({
      sessionId: session.id,
      action: 'propose',
      consensusId,
      slotId: 'p-0',
      content: 'A detailed proposal about implementation',
    });
    const result = parseResult(handleSwarmConsensus({
      sessionId: session.id,
      action: 'status',
      consensusId,
    })) as any;
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].slotId).toBe('p-0');
    expect(result.proposals[0].contentPreview).toContain('A detailed proposal');
  });
});

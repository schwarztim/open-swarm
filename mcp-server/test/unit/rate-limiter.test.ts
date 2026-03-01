import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { TokenBucket, checkRateLimit, resolveRateLimit, RATE_PRESETS, clearRateLimiters } from '../../src/rate-limiter.js';

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('constructor sets correct capacity — starts full', () => {
    const bucket = new TokenBucket(5, 1000);
    const status = bucket.status();
    expect(status.maxTokens).toBe(5);
    expect(status.tokens).toBe(5);
    expect(status.refillRateMs).toBe(1000);
  });

  it('tryConsume returns ok:true when tokens available', () => {
    const bucket = new TokenBucket(3, 1000);
    const result = bucket.tryConsume();
    expect(result.ok).toBe(true);
    expect(result.retryAfterMs).toBe(0);
  });

  it('tryConsume decrements token count', () => {
    const bucket = new TokenBucket(3, 1000);
    bucket.tryConsume();
    expect(bucket.status().tokens).toBe(2);
  });

  it('tryConsume returns ok:false when bucket is empty', () => {
    const bucket = new TokenBucket(1, 1000);
    bucket.tryConsume(); // drain the single token
    const result = bucket.tryConsume();
    expect(result.ok).toBe(false);
  });

  it('tryConsume returns retryAfterMs > 0 when bucket empty', () => {
    const bucket = new TokenBucket(1, 1000);
    bucket.tryConsume();
    const result = bucket.tryConsume();
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(0);
  });

  it('multiple rapid consumes drain the bucket correctly', () => {
    const bucket = new TokenBucket(4, 1000);
    expect(bucket.tryConsume().ok).toBe(true);
    expect(bucket.tryConsume().ok).toBe(true);
    expect(bucket.tryConsume().ok).toBe(true);
    expect(bucket.tryConsume().ok).toBe(true);
    expect(bucket.tryConsume().ok).toBe(false);
  });

  it('cannot consume more than capacity even with many calls', () => {
    const bucket = new TokenBucket(2, 1000);
    const results = Array.from({ length: 5 }, () => bucket.tryConsume());
    const successes = results.filter(r => r.ok).length;
    expect(successes).toBe(2);
  });

  it('tokens refill over time', () => {
    const bucket = new TokenBucket(3, 1000);
    // Drain all tokens
    bucket.tryConsume();
    bucket.tryConsume();
    bucket.tryConsume();
    expect(bucket.tryConsume().ok).toBe(false);

    // Advance time by 1 refill interval (1 token refilled per interval)
    vi.advanceTimersByTime(1000);
    expect(bucket.tryConsume().ok).toBe(true);
  });

  it('tokens do not exceed maxTokens on refill', () => {
    const bucket = new TokenBucket(3, 1000);
    // Already full, advance time significantly
    vi.advanceTimersByTime(10000);
    const status = bucket.status();
    expect(status.tokens).toBeLessThanOrEqual(status.maxTokens);
    expect(status.tokens).toBe(3);
  });

  it('refills multiple tokens after multiple intervals', () => {
    const bucket = new TokenBucket(5, 1000);
    // Drain all
    for (let i = 0; i < 5; i++) bucket.tryConsume();
    expect(bucket.status().tokens).toBe(0);

    // Advance time by 3 intervals
    vi.advanceTimersByTime(3000);
    expect(bucket.status().tokens).toBe(3);
  });

  it('status() triggers a refill before reporting', () => {
    const bucket = new TokenBucket(5, 1000);
    // Drain all
    for (let i = 0; i < 5; i++) bucket.tryConsume();
    vi.advanceTimersByTime(2000);
    const status = bucket.status();
    expect(status.tokens).toBe(2);
  });
});

describe('checkRateLimit', () => {
  afterEach(() => {
    // Clear rate limiters after each test to avoid state leakage
    clearRateLimiters('test-session');
    clearRateLimiters('test-session-2');
  });

  it('returns ok:true when budget available', () => {
    const result = checkRateLimit('test-session', 'gpt-4.1');
    expect(result.ok).toBe(true);
  });

  it('returns tier string in result', () => {
    const result = checkRateLimit('test-session', 'gpt-4.1');
    expect(typeof result.tier).toBe('string');
    expect(result.tier).toBe('standard');
  });

  it('returns fast tier for fast model', () => {
    const result = checkRateLimit('test-session', 'claude-haiku-4.5');
    expect(result.tier).toBe('fast');
  });

  it('returns standard tier for unknown model', () => {
    const result = checkRateLimit('test-session-2', 'unknown-model-xyz');
    expect(result.tier).toBe('standard');
  });

  it('returns ok:false after burst limit exhausted for premium tier', () => {
    vi.useFakeTimers();
    const sessionId = 'premium-session';
    clearRateLimiters(sessionId);
    // Premium tier has burstMax=2
    checkRateLimit(sessionId, 'claude-opus-4.6');
    checkRateLimit(sessionId, 'claude-opus-4.6');
    const result = checkRateLimit(sessionId, 'claude-opus-4.6');
    expect(result.ok).toBe(false);
    vi.useRealTimers();
    clearRateLimiters(sessionId);
  });
});

describe('resolveRateLimit', () => {
  it('returns standard concurrency when called with undefined', () => {
    expect(resolveRateLimit(undefined)).toBe(RATE_PRESETS.standard.concurrency);
  });

  it('returns numeric value when passed a number', () => {
    expect(resolveRateLimit(7)).toBe(7);
  });

  it('returns concurrency for conservative preset', () => {
    expect(resolveRateLimit('conservative')).toBe(RATE_PRESETS.conservative.concurrency);
  });

  it('returns concurrency for aggressive preset', () => {
    expect(resolveRateLimit('aggressive')).toBe(RATE_PRESETS.aggressive.concurrency);
  });

  it('returns concurrency for max preset', () => {
    expect(resolveRateLimit('max')).toBe(RATE_PRESETS.max.concurrency);
  });

  it('returns standard concurrency for unknown preset string', () => {
    expect(resolveRateLimit('nonexistent' as any)).toBe(RATE_PRESETS.standard.concurrency);
  });

  it('returns 0 for unlimited preset', () => {
    expect(resolveRateLimit('unlimited')).toBe(0);
  });
});

import {describe, expect, it} from 'vitest';
import {groupByModel, groupByPeriod, totalsFor} from '../src/aggregate.js';
import {applyPricing, BUILTIN_PRICING} from '../src/pricing.js';
import type {UsageRecord} from '../src/types.js';

const base: UsageRecord = {
  timestamp: new Date('2026-07-01T12:00:00Z'),
  source: 'codex',
  model: 'gpt-5',
  sessionId: 'one',
  uncachedInputTokens: 1_000_000,
  cachedInputTokens: 1_000_000,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 1_000_000,
  reasoningTokens: 100_000
};

describe('pricing and aggregation', () => {
  it('calculates each token category at its model rate', () => {
    const record = applyPricing(base, BUILTIN_PRICING);
    expect(record.cost).toBeCloseTo(11.375);
  });

  it('groups by model and calendar periods', () => {
    const records = [
      applyPricing(base, BUILTIN_PRICING),
      applyPricing({...base, timestamp: new Date('2026-07-08T12:00:00Z'), sessionId: 'two'}, BUILTIN_PRICING)
    ];
    expect(totalsFor(records)).toMatchObject({sessions: 2, totalTokens: 6_000_000});
    expect(groupByModel(records)).toHaveLength(1);
    expect(groupByPeriod(records, 'day')).toHaveLength(2);
    expect(groupByPeriod(records, 'week')).toHaveLength(2);
    expect(groupByPeriod(records, 'month')).toHaveLength(1);
    expect(groupByPeriod(records, 'year')).toHaveLength(1);
  });

  it('uses effective-dated introductory model pricing', () => {
    const sonnet = {...base, source: 'claude' as const, model: 'claude-sonnet-5', cachedInputTokens: 0, outputTokens: 0};
    expect(applyPricing({...sonnet, timestamp: new Date('2026-07-10')}, BUILTIN_PRICING).cost).toBe(2);
    expect(applyPricing({...sonnet, timestamp: new Date('2026-09-10')}, BUILTIN_PRICING).cost).toBe(3);
  });
});

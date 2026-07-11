import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseClaude, parseCodex, parseFile, parseGrok} from '../src/parsers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);
const fallback = new Date('2026-01-01T00:00:00Z');

describe('session parsers', () => {
  it('uses cumulative deltas for Codex without double counting', async () => {
    const records = await parseCodex(fixture('codex.jsonl'), fallback);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({model: 'gpt-5', uncachedInputTokens: 80, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 2});
    expect(records[1]).toMatchObject({uncachedInputTokens: 120, cachedInputTokens: 30, outputTokens: 20, reasoningTokens: 6});
  });

  it('deduplicates streamed Claude message snapshots', async () => {
    const records = await parseClaude(fixture('claude.jsonl'), fallback);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({uncachedInputTokens: 10, cacheWriteTokens: 10, cacheWrite1hTokens: 20, cachedInputTokens: 50, outputTokens: 8});
  });

  it('keeps Grok prompt context totals as marked estimates', async () => {
    const records = await parseGrok(fixture('grok.jsonl'), fallback);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({model: 'grok-4.5', uncachedInputTokens: 150, outputTokens: 0, estimated: true});
    expect(records[1].uncachedInputTokens).toBe(200);
  });

  it('detects a known schema for an explicitly supplied JSONL file', async () => {
    const records = await parseFile({path: fixture('codex.jsonl'), source: 'generic'});
    expect(records[0].source).toBe('codex');
  });
});

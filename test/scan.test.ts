import {appendFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createUsageScanner} from '../src/scan.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

describe('incremental usage scanner', () => {
  it('reuses an unchanged result and invalidates only after a file changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'llmusage-scan-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.jsonl');
    await writeFile(path, [
      JSON.stringify({timestamp: '2026-07-10T10:00:00Z', type: 'turn_context', payload: {model: 'gpt-5', cwd: '/work/alpha'}}),
      JSON.stringify({timestamp: '2026-07-10T10:01:00Z', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 100, cached_input_tokens: 20, output_tokens: 10}}}})
    ].join('\n'));

    const scanner = createUsageScanner();
    const options = {paths: [path], since: new Date('2026-07-10T00:00:00Z')};
    const first = await scanner.scan(options);
    const unchanged = await scanner.scan(options);

    expect(unchanged).toBe(first);
    expect(first.records).toHaveLength(1);

    await appendFile(path, `\n${JSON.stringify({timestamp: '2026-07-10T10:02:00Z', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 250, cached_input_tokens: 50, output_tokens: 30}}}})}`);
    const changed = await scanner.scan(options);

    expect(changed).not.toBe(first);
    expect(changed.records).toHaveLength(2);
    expect(changed.records.reduce((sum, record) => sum + record.uncachedInputTokens + record.cachedInputTokens + record.outputTokens, 0)).toBe(280);

    scanner.clear();
    expect(await scanner.scan(options)).not.toBe(changed);
  });
});

import {appendFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {groupByModel, groupByPeriod, groupByProject, groupBySource, totalsFor} from '../src/aggregate.js';
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

  it('keeps table totals exact while rolling records up by local day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'llmusage-rollup-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'session.jsonl');
    await writeFile(path, [
      JSON.stringify({timestamp: '2026-07-10T10:00:00', type: 'turn_context', payload: {model: 'gpt-5', cwd: '/work/alpha'}}),
      JSON.stringify({timestamp: '2026-07-10T10:01:00', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 100, cached_input_tokens: 20, output_tokens: 10}}}}),
      JSON.stringify({timestamp: '2026-07-10T11:01:00', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 250, cached_input_tokens: 50, output_tokens: 30}}}}),
      JSON.stringify({timestamp: '2026-07-11T09:01:00', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 80, cached_input_tokens: 10, output_tokens: 8}}}})
    ].join('\n'));

    const detailed = await createUsageScanner().scan({paths: [path]});
    const rolled = await createUsageScanner().scan({paths: [path], rollup: 'day'});

    expect(detailed.records).toHaveLength(3);
    expect(rolled.records).toHaveLength(2);
    const {records: _detailedRecords, ...detailedTotals} = totalsFor(detailed.records);
    const {records: _rolledRecords, ...rolledTotals} = totalsFor(rolled.records);
    expect(rolledTotals).toEqual(detailedTotals);
    const comparable = (groups: ReturnType<typeof groupByModel>) => groups.map(({records: _records, cost, ...group}) => ({
      ...group,
      cost: Number(cost.toFixed(10))
    }));
    for (const groups of [groupBySource, groupByModel, groupByProject]) {
      expect(comparable(groups(rolled.records))).toEqual(comparable(groups(detailed.records)));
    }
    for (const period of ['day', 'week', 'month', 'year'] as const) {
      expect(comparable(groupByPeriod(rolled.records, period))).toEqual(comparable(groupByPeriod(detailed.records, period)));
    }
  });

  it('reuses priced rollups from unchanged files after another file grows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'llmusage-sharing-'));
    temporaryDirectories.push(directory);
    const changedPath = join(directory, 'changed.jsonl');
    const stablePath = join(directory, 'stable.jsonl');
    const session = (model: string, tokens: number) => [
      JSON.stringify({timestamp: '2026-07-10T10:00:00Z', type: 'turn_context', payload: {model, cwd: '/work/alpha'}}),
      JSON.stringify({timestamp: '2026-07-10T10:01:00Z', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: tokens, cached_input_tokens: 0, output_tokens: 10}}}})
    ].join('\n');
    await writeFile(changedPath, session('gpt-5', 100));
    await writeFile(stablePath, session('gpt-5-mini', 200));

    const scanner = createUsageScanner();
    const options = {paths: [changedPath, stablePath], rollup: 'day' as const};
    const first = await scanner.scan(options);
    const stable = first.records.find(record => record.sessionId === 'stable');
    await appendFile(changedPath, `\n${JSON.stringify({timestamp: '2026-07-10T10:02:00Z', type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: {input_tokens: 250, cached_input_tokens: 0, output_tokens: 30}}}})}`);
    const changed = await scanner.scan(options);

    expect(changed.records.find(record => record.sessionId === 'stable')).toBe(stable);
    expect(changed.records).toHaveLength(2);
  });

  it('ignores replayed Codex history while retaining new fork usage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'llmusage-codex-replay-'));
    temporaryDirectories.push(directory);
    const sessions = join(directory, '.codex', 'sessions', '2026', '07', '13');
    await mkdir(sessions, {recursive: true});
    const parentId = '11111111-1111-4111-8111-111111111111';
    const childId = '22222222-2222-4222-8222-222222222222';
    const parentPath = join(sessions, `rollout-2026-07-01T00-00-00-${parentId}.jsonl`);
    const childPath = join(sessions, `rollout-2026-07-13T10-00-00-${childId}.jsonl`);
    const token = (timestamp: string, input: number, cached: number, output: number) => JSON.stringify({
      timestamp,
      type: 'event_msg',
      payload: {type: 'token_count', info: {
        total_token_usage: {input_tokens: input, cached_input_tokens: cached, output_tokens: output},
        last_token_usage: {input_tokens: input, cached_input_tokens: cached, output_tokens: output}
      }}
    });
    const parent = [
      JSON.stringify({timestamp: '2026-07-01T00:00:00Z', type: 'session_meta', payload: {id: parentId}}),
      JSON.stringify({timestamp: '2026-07-01T00:00:01Z', type: 'turn_context', payload: {model: 'gpt-5', cwd: '/work/parent'}}),
      token('2026-07-01T00:01:00Z', 100, 20, 10),
      token('2026-07-01T00:02:00Z', 250, 50, 30)
    ];
    await writeFile(parentPath, parent.join('\n'));
    await writeFile(childPath, [
      JSON.stringify({timestamp: '2026-07-13T10:00:00Z', type: 'session_meta', payload: {
        id: childId,
        session_id: parentId,
        parent_thread_id: parentId
      }}),
      ...parent,
      token('2026-07-13T10:01:00Z', 300, 60, 40)
    ].join('\n'));

    const result = await createUsageScanner().scan({
      paths: [join(directory, '.codex', 'sessions')],
      since: new Date('2026-07-13T00:00:00Z')
    });

    expect(result.warnings).toEqual([]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      source: 'codex',
      sessionId: basename(childPath, '.jsonl'),
      uncachedInputTokens: 40,
      cachedInputTokens: 10,
      outputTokens: 10
    });
  });
});

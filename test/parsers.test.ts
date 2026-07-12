import {fileURLToPath} from 'node:url';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {discoverFiles} from '../src/discovery.js';
import {parseClaude, parseCodex, parseFile, parseGrok, parseGrokSignals} from '../src/parsers.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);
const fallback = new Date('2026-01-01T00:00:00Z');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {recursive: true, force: true})));
});

describe('session parsers', () => {
  it('uses cumulative deltas for Codex without double counting', async () => {
    const records = await parseCodex(fixture('codex.jsonl'), fallback);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({model: 'gpt-5', project: 'C:\\work\\alpha', uncachedInputTokens: 80, cachedInputTokens: 20, outputTokens: 10, reasoningTokens: 2});
    expect(records[1]).toMatchObject({uncachedInputTokens: 120, cachedInputTokens: 30, outputTokens: 20, reasoningTokens: 6});
  });

  it('deduplicates streamed Claude message snapshots', async () => {
    const records = await parseClaude(fixture('claude.jsonl'), fallback);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({project: 'C:\\work\\alpha', uncachedInputTokens: 10, cacheWriteTokens: 10, cacheWrite1hTokens: 20, cachedInputTokens: 50, outputTokens: 8});
  });

  it('discovers Claude Desktop Cowork usage and uses its selected folder as the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llmusage-Claude-local-agent-mode-sessions-'));
    temporaryDirectories.push(root);
    const sessionDirectory = join(root, 'Claude', 'local-agent-mode-sessions', 'account', 'workspace', 'local_session');
    const projectDirectory = join(sessionDirectory, '.claude', 'projects', 'encoded-project');
    const usagePath = join(projectDirectory, 'desktop-session.jsonl');
    await mkdir(projectDirectory, {recursive: true});
    await writeFile(`${sessionDirectory}.json`, JSON.stringify({
      userSelectedFolders: ['C:\\work\\desktop-project']
    }));
    await writeFile(usagePath, JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-12T10:00:00Z',
      sessionId: 'desktop-session',
      cwd: join(sessionDirectory, 'outputs'),
      message: {
        id: 'message-1',
        model: 'claude-sonnet-5',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 30,
          cache_creation: {ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 10},
          output_tokens: 8
        }
      }
    }));
    await writeFile(join(sessionDirectory, 'audit.jsonl'), JSON.stringify({type: 'assistant', message: {usage: {input_tokens: 999}}}));

    const discovered = await discoverFiles([root]);
    expect(discovered.files).toEqual([{path: usagePath, source: 'claude-desktop'}]);
    const records = await parseFile(discovered.files[0]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      source: 'claude-desktop',
      project: 'C:\\work\\desktop-project',
      model: 'claude-sonnet-5',
      uncachedInputTokens: 10,
      cachedInputTokens: 50,
      cacheWriteTokens: 10,
      cacheWrite1hTokens: 20,
      outputTokens: 8
    });

    await writeFile(`${sessionDirectory}.json`, JSON.stringify({userSelectedFolders: []}));
    expect((await parseFile(discovered.files[0]))[0].project).toBe('Claude Desktop/Cowork');
  });

  it('counts a session mirrored by Claude Code and Desktop only once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'llmusage-claude-mirror-'));
    temporaryDirectories.push(root);
    const desktopPath = join(root, 'Claude', 'local-agent-mode-sessions', 'account', 'workspace', 'local_session', '.claude', 'projects', 'desktop', 'same-session.jsonl');
    const codePath = join(root, '.claude', 'projects', 'code', 'same-session.jsonl');
    await mkdir(dirname(desktopPath), {recursive: true});
    await mkdir(dirname(codePath), {recursive: true});
    await writeFile(desktopPath, '');
    await writeFile(codePath, '');

    expect((await discoverFiles([root])).files).toEqual([{path: codePath, source: 'claude'}]);
    expect((await discoverFiles([root], ['claude-desktop'])).files).toEqual([{path: desktopPath, source: 'claude-desktop'}]);
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

  it('uses Grok signals as an estimated fallback', async () => {
    const records = await parseGrokSignals(fixture('grok-session/signals.json'), fallback);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({model: 'grok-4.5', uncachedInputTokens: 500, estimated: true});
  });
});

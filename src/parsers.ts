import {createReadStream} from 'node:fs';
import {readFile, stat} from 'node:fs/promises';
import {basename, dirname, join, normalize, sep} from 'node:path';
import {createInterface} from 'node:readline';
import type {DiscoveredFile, Source, UsageRecord} from './types.js';
import {isRecord, parseTimestamp, toNumber} from './utils.js';

type Json = Record<string, any>;

export interface CodexSessionMetadata {
  rolloutId: string;
  parentSessionId?: string;
  replay: boolean;
}

const jsonLines = async function* (path: string): AsyncGenerator<Json> {
  const input = createReadStream(path, {encoding: 'utf8'});
  const lines = createInterface({input, crlfDelay: Infinity});
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) yield value;
    } catch {
      // Session files can end with a partial line after an interrupted process.
    }
  }
};

const sessionIdFor = (path: string, source: Source): string =>
  source === 'grok' ? basename(dirname(path)) : basename(path, '.jsonl');

export const readCodexSessionMetadata = async (path: string): Promise<CodexSessionMetadata> => {
  const fallback = sessionIdFor(path, 'codex');
  for await (const item of jsonLines(path)) {
    if (item.type !== 'session_meta' || !isRecord(item.payload)) continue;
    const rolloutId = typeof item.payload.id === 'string' ? item.payload.id : fallback;
    const parentSessionId = [item.payload.session_id, item.payload.parent_thread_id, item.payload.forked_from_id]
      .find(value => typeof value === 'string' && value.length > 0 && value !== rolloutId);
    return {
      rolloutId,
      parentSessionId: typeof parentSessionId === 'string' ? parentSessionId : undefined,
      replay: typeof parentSessionId === 'string'
    };
  }
  return {rolloutId: fallback, replay: false};
};

const grokProjectFor = (path: string): string => {
  const encoded = basename(dirname(dirname(path)));
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded || '(unknown)';
  }
};

const delta = (current: Json, previous?: Json): Json => {
  if (!previous) return current;
  const result: Json = {};
  for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    const now = toNumber(current[key]);
    const before = toNumber(previous[key]);
    result[key] = now >= before ? now - before : now;
  }
  return result;
};

const codexUsageSignature = (usage: Json | undefined): string => {
  if (!usage) return '-';
  return [
    usage.input_tokens,
    usage.cached_input_tokens,
    usage.output_tokens,
    usage.reasoning_output_tokens,
    usage.total_tokens
  ].map(toNumber).join(',');
};

const codexTokenSignature = (model: string, info: Json): string => {
  const total = isRecord(info.total_token_usage) ? info.total_token_usage : undefined;
  const last = isRecord(info.last_token_usage) ? info.last_token_usage : undefined;
  return `${model}\u001e${codexUsageSignature(total)}\u001e${codexUsageSignature(last)}`;
};

export const readCodexTokenSignatures = async (path: string): Promise<string[]> => {
  const signatures: string[] = [];
  let model = 'unknown-codex';
  for await (const item of jsonLines(path)) {
    if (item.type === 'turn_context' && typeof item.payload?.model === 'string') model = item.payload.model;
    if (item.type !== 'event_msg' || item.payload?.type !== 'token_count' || !isRecord(item.payload.info)) continue;
    signatures.push(codexTokenSignature(model, item.payload.info));
  }
  return signatures;
};

export const parseCodex = async (
  path: string,
  fallbackTimestamp: Date,
  replayPrefix?: readonly string[]
): Promise<UsageRecord[]> => {
  const records: UsageRecord[] = [];
  let model = 'unknown-codex';
  let project = '(unknown)';
  let previousTotal: Json | undefined;
  let replayIndex = 0;
  let matchingReplayPrefix = Boolean(replayPrefix?.length);
  for await (const item of jsonLines(path)) {
    if (typeof item.payload?.cwd === 'string') project = item.payload.cwd;
    if (item.type === 'turn_context' && typeof item.payload?.model === 'string') model = item.payload.model;
    if (item.type !== 'event_msg' || item.payload?.type !== 'token_count' || !isRecord(item.payload.info)) continue;
    const copiedFromParent = matchingReplayPrefix && replayIndex < replayPrefix!.length &&
      codexTokenSignature(model, item.payload.info) === replayPrefix![replayIndex];
    if (copiedFromParent) replayIndex++;
    else matchingReplayPrefix = false;
    const total = isRecord(item.payload.info.total_token_usage) ? item.payload.info.total_token_usage : undefined;
    const last = isRecord(item.payload.info.last_token_usage) ? item.payload.info.last_token_usage : undefined;
    const usage = total ? delta(total, previousTotal) : last;
    if (total) previousTotal = total;
    if (!usage || copiedFromParent) continue;
    const allInput = toNumber(usage.input_tokens);
    const cached = Math.min(allInput, toNumber(usage.cached_input_tokens));
    const output = toNumber(usage.output_tokens);
    if (allInput + output === 0) continue;
    records.push({
      timestamp: parseTimestamp(item.timestamp, fallbackTimestamp),
      source: 'codex',
      model,
      project,
      sessionId: sessionIdFor(path, 'codex'),
      uncachedInputTokens: allInput - cached,
      cachedInputTokens: cached,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: output,
      reasoningTokens: Math.min(output, toNumber(usage.reasoning_output_tokens))
    });
  }
  return records;
};

const claudeDesktopProject = async (path: string): Promise<string | undefined> => {
  const normalized = normalize(path);
  const marker = `${sep}.claude${sep}projects${sep}`;
  const markerIndex = normalized.toLowerCase().indexOf(marker);
  if (markerIndex < 0) return undefined;
  const metadataPath = `${normalized.slice(0, markerIndex)}.json`;
  try {
    const value: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (!isRecord(value)) return undefined;
    const folders = value.userSelectedFolders;
    if (Array.isArray(folders)) {
      const selected = folders.find(folder => typeof folder === 'string' && folder.length > 0);
      if (typeof selected === 'string') return selected;
    }
    if (typeof folders === 'string' && folders.length > 0) return folders;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return undefined;
};

export const parseClaude = async (
  path: string,
  fallbackTimestamp: Date,
  source: 'claude' | 'claude-desktop' = 'claude'
): Promise<UsageRecord[]> => {
  const messages = new Map<string, UsageRecord>();
  let index = 0;
  const desktopProject = source === 'claude-desktop' ? await claudeDesktopProject(path) : undefined;
  let project = desktopProject ?? (source === 'claude-desktop' ? 'Claude Desktop/Cowork' : '(unknown)');
  for await (const item of jsonLines(path)) {
    index++;
    if (source === 'claude' && typeof item.cwd === 'string') project = item.cwd;
    if (item.type !== 'assistant' || !isRecord(item.message) || !isRecord(item.message.usage)) continue;
    const usage = item.message.usage;
    const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : {};
    const cacheWrite1h = toNumber(cacheCreation.ephemeral_1h_input_tokens);
    const cacheWrite5m = toNumber(cacheCreation.ephemeral_5m_input_tokens);
    const cacheWrite = cacheWrite1h + cacheWrite5m > 0
      ? cacheWrite5m
      : toNumber(usage.cache_creation_input_tokens);
    const id = String(item.message.id ?? item.uuid ?? index);
    const current: UsageRecord = {
      timestamp: parseTimestamp(item.timestamp, fallbackTimestamp),
      source,
      model: String(item.message.model ?? 'unknown-claude'),
      project,
      sessionId: String(item.sessionId ?? sessionIdFor(path, source)),
      uncachedInputTokens: toNumber(usage.input_tokens),
      cachedInputTokens: toNumber(usage.cache_read_input_tokens),
      cacheWriteTokens: cacheWrite,
      cacheWrite1hTokens: cacheWrite1h,
      outputTokens: toNumber(usage.output_tokens),
      reasoningTokens: 0
    };
    const existing = messages.get(id);
    if (!existing) messages.set(id, current);
    else {
      existing.uncachedInputTokens = Math.max(existing.uncachedInputTokens, current.uncachedInputTokens);
      existing.cachedInputTokens = Math.max(existing.cachedInputTokens, current.cachedInputTokens);
      existing.cacheWriteTokens = Math.max(existing.cacheWriteTokens, current.cacheWriteTokens);
      existing.cacheWrite1hTokens = Math.max(existing.cacheWrite1hTokens, current.cacheWrite1hTokens);
      existing.outputTokens = Math.max(existing.outputTokens, current.outputTokens);
    }
  }
  return [...messages.values()].filter(record =>
    record.uncachedInputTokens + record.cachedInputTokens + record.cacheWriteTokens + record.cacheWrite1hTokens + record.outputTokens > 0
  );
};

export const parseGrok = async (path: string, fallbackTimestamp: Date): Promise<UsageRecord[]> => {
  const prompts = new Map<string, {timestamp: Date; maxTokens: number; model: string}>();
  let model = 'unknown-grok';
  for await (const item of jsonLines(path)) {
    const update = isRecord(item.params?.update) ? item.params.update : {};
    if (typeof update.model === 'string') model = update.model;
    if (isRecord(update._meta) && typeof update._meta.modelId === 'string') model = update._meta.modelId;
    const meta = isRecord(item.params?._meta) ? item.params._meta : undefined;
    if (!meta || !meta.promptId || !toNumber(meta.totalTokens)) continue;
    const key = String(meta.promptId);
    const tokens = toNumber(meta.totalTokens);
    const existing = prompts.get(key);
    if (!existing) prompts.set(key, {timestamp: parseTimestamp(item.timestamp, fallbackTimestamp), maxTokens: tokens, model});
    else {
      existing.maxTokens = Math.max(existing.maxTokens, tokens);
      if (model !== 'unknown-grok') existing.model = model;
    }
  }
  const records: UsageRecord[] = [...prompts.values()].map(prompt => ({
    timestamp: prompt.timestamp,
    source: 'grok',
    model: prompt.model,
    project: grokProjectFor(path),
    sessionId: sessionIdFor(path, 'grok'),
    uncachedInputTokens: prompt.maxTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimated: true,
    estimationNote: 'Grok local logs expose combined per-prompt context totals; priced as uncached input.'
  }));
  return records.length ? records : parseGrokSignals(path, fallbackTimestamp);
};

export const parseGrokSignals = async (path: string, fallbackTimestamp: Date): Promise<UsageRecord[]> => {
  const signalsPath = basename(path).toLowerCase() === 'signals.json' ? path : join(dirname(path), 'signals.json');
  try {
    const value: unknown = JSON.parse(await readFile(signalsPath, 'utf8'));
    if (!isRecord(value)) return [];
    const tokens = toNumber(value.contextTokensUsed) + toNumber(value.totalTokensBeforeCompaction);
    if (!tokens) return [];
    return [{
      timestamp: fallbackTimestamp,
      source: 'grok',
      model: String(value.primaryModelId ?? (Array.isArray(value.modelsUsed) ? value.modelsUsed[0] : undefined) ?? 'unknown-grok'),
      project: grokProjectFor(signalsPath),
      sessionId: sessionIdFor(signalsPath, 'grok'),
      uncachedInputTokens: tokens,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      estimated: true,
      estimationNote: 'Grok signals expose combined context totals; priced as uncached input.'
    }];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

const genericUsage = (item: Json): Json | undefined => {
  if (isRecord(item.usage)) return item.usage;
  if (isRecord(item.message) && isRecord(item.message.usage)) return item.message.usage;
  if (isRecord(item.response) && isRecord(item.response.usage)) return item.response.usage;
  return undefined;
};

export const parseGeneric = async (path: string, fallbackTimestamp: Date): Promise<UsageRecord[]> => {
  const records: UsageRecord[] = [];
  let index = 0;
  let project = '(unknown)';
  for await (const item of jsonLines(path)) {
    index++;
    if (typeof item.cwd === 'string') project = item.cwd;
    else if (typeof item.project === 'string') project = item.project;
    const usage = genericUsage(item);
    if (!usage) continue;
    const allInput = toNumber(usage.input_tokens || usage.prompt_tokens);
    const details = isRecord(usage.input_tokens_details)
      ? usage.input_tokens_details
      : isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
    const cached = Math.min(allInput, toNumber(details.cached_tokens || usage.cached_input_tokens || usage.cache_read_input_tokens));
    const cacheWrite = toNumber(usage.cache_creation_input_tokens);
    const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : {};
    const cacheWrite1h = toNumber(cacheCreation.ephemeral_1h_input_tokens);
    const cacheWrite5m = toNumber(cacheCreation.ephemeral_5m_input_tokens);
    const output = toNumber(usage.output_tokens || usage.completion_tokens);
    const outputDetails = isRecord(usage.output_tokens_details)
      ? usage.output_tokens_details
      : isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
    if (allInput + cacheWrite + cacheWrite1h + output === 0) continue;
    records.push({
      timestamp: parseTimestamp(item.timestamp ?? item.created_at ?? item.created, fallbackTimestamp),
      source: 'generic',
      model: String(item.model ?? item.message?.model ?? item.response?.model ?? 'unknown'),
      project,
      sessionId: String(item.session_id ?? item.sessionId ?? `${sessionIdFor(path, 'generic')}:${index}`),
      uncachedInputTokens: Math.max(0, allInput - cached),
      cachedInputTokens: cached,
      cacheWriteTokens: cacheWrite1h + cacheWrite5m > 0 ? cacheWrite5m : cacheWrite,
      cacheWrite1hTokens: cacheWrite1h,
      outputTokens: output,
      reasoningTokens: Math.min(output, toNumber(outputDetails.reasoning_tokens || usage.reasoning_output_tokens))
    });
  }
  return records;
};

const detectSource = async (path: string): Promise<Source> => {
  let inspected = 0;
  for await (const item of jsonLines(path)) {
    inspected++;
    if (item.type === 'turn_context' || (item.type === 'event_msg' && item.payload?.type === 'token_count')) return 'codex';
    if (item.type === 'assistant' && isRecord(item.message?.usage)) return 'claude';
    if (item.method === 'session/update' && isRecord(item.params?._meta) && item.params._meta.totalTokens) return 'grok';
    if (inspected >= 100) break;
  }
  return 'generic';
};

export const parseFile = async (file: DiscoveredFile): Promise<UsageRecord[]> => {
  const info = await stat(file.path);
  const fallback = info.mtime;
  const source = file.source === 'generic' ? await detectSource(file.path) : file.source;
  if (source === 'codex') return parseCodex(file.path, fallback);
  if (source === 'claude' || source === 'claude-desktop') return parseClaude(file.path, fallback, source);
  if (source === 'grok') {
    return basename(file.path).toLowerCase() === 'signals.json'
      ? parseGrokSignals(file.path, fallback)
      : parseGrok(file.path, fallback);
  }
  return parseGeneric(file.path, fallback);
};

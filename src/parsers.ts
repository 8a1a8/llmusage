import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {basename, dirname} from 'node:path';
import {createInterface} from 'node:readline';
import type {DiscoveredFile, Source, UsageRecord} from './types.js';
import {isRecord, parseTimestamp, toNumber} from './utils.js';

type Json = Record<string, any>;

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

export const parseCodex = async (path: string, fallbackTimestamp: Date): Promise<UsageRecord[]> => {
  const records: UsageRecord[] = [];
  let model = 'unknown-codex';
  let previousTotal: Json | undefined;
  for await (const item of jsonLines(path)) {
    if (item.type === 'turn_context' && typeof item.payload?.model === 'string') model = item.payload.model;
    if (item.type !== 'event_msg' || item.payload?.type !== 'token_count' || !isRecord(item.payload.info)) continue;
    const total = isRecord(item.payload.info.total_token_usage) ? item.payload.info.total_token_usage : undefined;
    const last = isRecord(item.payload.info.last_token_usage) ? item.payload.info.last_token_usage : undefined;
    const usage = total ? delta(total, previousTotal) : last;
    if (total) previousTotal = total;
    if (!usage) continue;
    const allInput = toNumber(usage.input_tokens);
    const cached = Math.min(allInput, toNumber(usage.cached_input_tokens));
    const output = toNumber(usage.output_tokens);
    if (allInput + output === 0) continue;
    records.push({
      timestamp: parseTimestamp(item.timestamp, fallbackTimestamp),
      source: 'codex',
      model,
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

export const parseClaude = async (path: string, fallbackTimestamp: Date): Promise<UsageRecord[]> => {
  const messages = new Map<string, UsageRecord>();
  let index = 0;
  for await (const item of jsonLines(path)) {
    index++;
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
      source: 'claude',
      model: String(item.message.model ?? 'unknown-claude'),
      sessionId: String(item.sessionId ?? sessionIdFor(path, 'claude')),
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
  return [...prompts.values()].map(prompt => ({
    timestamp: prompt.timestamp,
    source: 'grok',
    model: prompt.model,
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
  for await (const item of jsonLines(path)) {
    index++;
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
  if (source === 'claude') return parseClaude(file.path, fallback);
  if (source === 'grok') return parseGrok(file.path, fallback);
  return parseGeneric(file.path, fallback);
};

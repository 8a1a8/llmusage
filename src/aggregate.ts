import type {CostedUsage, Period, Source, UsageGroup, UsageTotals} from './types.js';
import {periodKey} from './utils.js';

export const emptyTotals = (): UsageTotals => ({
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  cacheWrite1hTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  cost: 0,
  records: 0,
  sessions: 0,
  estimated: false
});

const add = (target: UsageTotals, record: CostedUsage): void => {
  target.uncachedInputTokens += record.uncachedInputTokens;
  target.cachedInputTokens += record.cachedInputTokens;
  target.cacheWriteTokens += record.cacheWriteTokens;
  target.cacheWrite1hTokens += record.cacheWrite1hTokens;
  target.outputTokens += record.outputTokens;
  target.reasoningTokens += record.reasoningTokens;
  target.totalTokens += record.uncachedInputTokens + record.cachedInputTokens + record.cacheWriteTokens + record.cacheWrite1hTokens + record.outputTokens;
  target.cost += record.cost;
  target.records++;
  target.estimated ||= record.pricingEstimated;
};

export const totalsFor = (records: CostedUsage[]): UsageTotals => {
  const totals = emptyTotals();
  const sessions = new Set<string>();
  for (const record of records) {
    add(totals, record);
    sessions.add(`${record.source}:${record.sessionId}`);
  }
  totals.sessions = sessions.size;
  return totals;
};

const group = (records: CostedUsage[], keyFor: (record: CostedUsage) => string): UsageGroup[] => {
  const groups = new Map<string, {group: UsageGroup; sessions: Set<string>}>();
  for (const record of records) {
    const key = keyFor(record);
    let entry = groups.get(key);
    if (!entry) {
      entry = {group: {...emptyTotals(), key}, sessions: new Set<string>()};
      groups.set(key, entry);
    }
    add(entry.group, record);
    entry.sessions.add(`${record.source}:${record.sessionId}`);
  }
  for (const entry of groups.values()) entry.group.sessions = entry.sessions.size;
  return [...groups.values()].map(entry => entry.group);
};

export const groupByPeriod = (records: CostedUsage[], period: Period): UsageGroup[] =>
  group(records, record => periodKey(record.timestamp, period)).sort((a, b) => a.key.localeCompare(b.key));

export const groupByModel = (records: CostedUsage[]): UsageGroup[] =>
  group(records, record => `${record.source}:${record.model}`)
    .map(item => {
      const separator = item.key.indexOf(':');
      return {...item, source: item.key.slice(0, separator) as Source, model: item.key.slice(separator + 1)};
    })
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

export const groupByProject = (records: CostedUsage[]): UsageGroup[] =>
  group(records, record => record.project || '(unknown)')
    .map(item => ({...item, project: item.key}))
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

export const groupBySource = (records: CostedUsage[]): UsageGroup[] =>
  group(records, record => record.source)
    .map(item => ({...item, source: item.key as Source}))
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

export const filterBySource = (records: CostedUsage[], source?: Source): CostedUsage[] =>
  source ? records.filter(record => record.source === source) : records;

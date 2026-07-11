import {groupByModel, groupByPeriod, groupByProject, groupBySource, totalsFor} from './aggregate.js';
import type {Period, ScanResult, UsageGroup} from './types.js';
import {formatProject, formatTokens, formatUsd} from './utils.js';

const cell = (value: string, width: number, right = false): string => {
  const shortened = value.length > width ? `${value.slice(0, Math.max(0, width - 1))}…` : value;
  return right ? shortened.padStart(width) : shortened.padEnd(width);
};

const table = (groups: UsageGroup[], name: 'model' | 'period' | 'project' | 'source'): string => {
  const labelWidth = name === 'project' ? 34 : name === 'model' ? 34 : 14;
  const heading = [
    cell(name.toUpperCase(), labelWidth), cell('INPUT', 10, true), cell('CACHED', 10, true),
    cell('WRITE 5M', 10, true), cell('WRITE 1H', 10, true), cell('OUTPUT', 10, true), cell('TOTAL', 10, true), cell('COST', 11, true)
  ].join('  ');
  const rows = groups.map(group => {
    const label = name === 'model'
      ? `${group.source}/${group.model}`
      : name === 'project' ? formatProject(group.project ?? group.key) : group.key;
    return [
      cell(label, labelWidth), cell(formatTokens(group.uncachedInputTokens), 10, true),
      cell(formatTokens(group.cachedInputTokens), 10, true), cell(formatTokens(group.cacheWriteTokens), 10, true),
      cell(formatTokens(group.cacheWrite1hTokens), 10, true), cell(formatTokens(group.outputTokens), 10, true), cell(formatTokens(group.totalTokens), 10, true),
      cell(`${formatUsd(group.cost)}${group.estimated ? '~' : ''}`, 11, true)
    ].join('  ');
  });
  return [heading, '-'.repeat(heading.length), ...rows].join('\n');
};

export const formatSummary = (result: ScanResult, period: Period): string => {
  const totals = totalsFor(result.records);
  const estimate = totals.estimated ? ' (includes estimates)' : '';
  return [
    `lu · ${result.files.length} files · ${totals.sessions} sessions · ${formatTokens(totals.totalTokens)} tokens · ${formatUsd(totals.cost)}${estimate}`,
    '',
    table(groupBySource(result.records), 'source'),
    '',
    table(groupByModel(result.records), 'model'),
    '',
    table(groupByProject(result.records), 'project'),
    '',
    table(groupByPeriod(result.records, period), 'period'),
    ...(result.warnings.length ? ['', `Warnings: ${result.warnings.length}`, ...result.warnings.map(item => `- ${item}`)] : [])
  ].join('\n');
};

export const jsonSummary = (result: ScanResult, period: Period): object => ({
  generatedAt: new Date().toISOString(),
  period,
  files: result.files.length,
  warnings: result.warnings,
  totals: totalsFor(result.records),
  bySource: groupBySource(result.records),
  byModel: groupByModel(result.records),
  byProject: groupByProject(result.records),
  byPeriod: groupByPeriod(result.records, period),
  records: result.records.map(record => ({...record, timestamp: record.timestamp.toISOString()}))
});

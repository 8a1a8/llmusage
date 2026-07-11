import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {filterBySource, groupByModel, groupByPeriod, totalsFor} from './aggregate.js';
import {scanUsage} from './scan.js';
import type {Period, ScanOptions, ScanResult, Source} from './types.js';
import {formatTokens, formatUsd} from './utils.js';

const periods: Period[] = ['day', 'week', 'month', 'year'];
const sources: Array<Source | undefined> = [undefined, 'codex', 'claude', 'grok', 'generic'];

interface AppProps {
  initial: ScanResult;
  options: ScanOptions;
  initialPeriod: Period;
  refreshMs: number;
}

const metricValue = (group: {cost: number; totalTokens: number}, metric: 'cost' | 'tokens'): number =>
  metric === 'cost' ? group.cost : group.totalTokens;

const BarChart = ({result, period, metric}: {result: ScanResult; period: Period; metric: 'cost' | 'tokens'}) => {
  const groups = groupByPeriod(result.records, period).slice(-14);
  const max = Math.max(1, ...groups.map(group => metricValue(group, metric)));
  const width = Math.max(12, Math.min(42, (process.stdout.columns || 100) - 34));
  if (!groups.length) return <Text dimColor>No usage found for this filter.</Text>;
  return (
    <Box flexDirection="column">
      {groups.map(group => {
        const value = metricValue(group, metric);
        const filled = value ? Math.max(1, Math.round(value / max * width)) : 0;
        const label = metric === 'cost' ? formatUsd(value) : formatTokens(value);
        return (
          <Box key={group.key}>
            <Box width={12}><Text>{group.key}</Text></Box>
            <Text color="cyan">{'█'.repeat(filled)}</Text>
            <Text dimColor>{'░'.repeat(width - filled)}</Text>
            <Text> {label}{group.estimated ? '~' : ''}</Text>
          </Box>
        );
      })}
    </Box>
  );
};

const ModelTable = ({result}: {result: ScanResult}) => {
  const models = groupByModel(result.records).slice(0, 12);
  if (!models.length) return null;
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={30}><Text bold>MODEL</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>INPUT</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>CACHED</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>WRITE</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>WRITE 1H</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>OUTPUT</Text></Box>
        <Box width={12} justifyContent="flex-end"><Text bold>COST</Text></Box>
      </Box>
      {models.map(group => {
        const name = `${group.source}/${group.model}`;
        return (
          <Box key={group.key}>
            <Box width={30}><Text wrap="truncate-end">{name}</Text></Box>
            <Box width={11} justifyContent="flex-end"><Text>{formatTokens(group.uncachedInputTokens)}</Text></Box>
            <Box width={11} justifyContent="flex-end"><Text color="blue">{formatTokens(group.cachedInputTokens)}</Text></Box>
            <Box width={11} justifyContent="flex-end"><Text color="magenta">{formatTokens(group.cacheWriteTokens)}</Text></Box>
            <Box width={11} justifyContent="flex-end"><Text color="magenta">{formatTokens(group.cacheWrite1hTokens)}</Text></Box>
            <Box width={11} justifyContent="flex-end"><Text color="green">{formatTokens(group.outputTokens)}</Text></Box>
            <Box width={12} justifyContent="flex-end"><Text color="yellow">{formatUsd(group.cost)}{group.estimated ? '~' : ''}</Text></Box>
          </Box>
        );
      })}
    </Box>
  );
};

export const App = ({initial, options, initialPeriod, refreshMs}: AppProps) => {
  const {exit} = useApp();
  const [result, setResult] = useState(initial);
  const [periodIndex, setPeriodIndex] = useState(periods.indexOf(initialPeriod));
  const [sourceIndex, setSourceIndex] = useState(0);
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const [loading, setLoading] = useState(false);
  const scanning = useRef(false);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const period = periods[Math.max(0, periodIndex)];
  const source = sources[sourceIndex];

  const refresh = async () => {
    if (scanning.current) return;
    scanning.current = true;
    setLoading(true);
    try {
      setResult(await scanUsage(options));
      setLastUpdated(new Date());
    } finally {
      scanning.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  useInput((input, key) => {
    if (input === 'q' || key.escape) exit();
    else if (key.leftArrow) setPeriodIndex(index => (index - 1 + periods.length) % periods.length);
    else if (key.rightArrow) setPeriodIndex(index => (index + 1) % periods.length);
    else if (input === 's') setSourceIndex(index => (index + 1) % sources.length);
    else if (input === 'm') setMetric(value => value === 'cost' ? 'tokens' : 'cost');
    else if (input === 'r') void refresh();
  });

  const filtered = useMemo<ScanResult>(() => ({
    ...result,
    records: filterBySource(result.records, source)
  }), [result, source]);
  const totals = totalsFor(filtered.records);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">llmusage</Text>
        <Text dimColor>{loading ? 'scanning…' : `updated ${lastUpdated.toLocaleTimeString()}`}</Text>
      </Box>
      <Text dimColor>{result.files.length} JSONL files · {totals.sessions} sessions · source {source ?? 'all'} · {period} view</Text>

      <Box marginTop={1} gap={3}>
        <Text>Cost <Text bold color="yellow">{formatUsd(totals.cost)}{totals.estimated ? '~' : ''}</Text></Text>
        <Text>Total <Text bold>{formatTokens(totals.totalTokens)}</Text></Text>
        <Text>Input <Text color="white">{formatTokens(totals.uncachedInputTokens)}</Text></Text>
        <Text>Cached <Text color="blue">{formatTokens(totals.cachedInputTokens)}</Text></Text>
        <Text>Cache write <Text color="magenta">{formatTokens(totals.cacheWriteTokens)}</Text></Text>
        <Text>1h write <Text color="magenta">{formatTokens(totals.cacheWrite1hTokens)}</Text></Text>
        <Text>Output <Text color="green">{formatTokens(totals.outputTokens)}</Text></Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>{period.toUpperCase()} · {metric.toUpperCase()}</Text>
        <BarChart result={filtered} period={period} metric={metric}/>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <ModelTable result={filtered}/>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {totals.estimated && <Text color="yellow">~ includes estimated tokens or model pricing; see README for source accuracy.</Text>}
        {result.warnings.length > 0 && <Text color="yellow">{result.warnings.length} warning(s); use --json or --no-tui to inspect.</Text>}
        <Text dimColor>←/→ period  ·  s source  ·  m cost/tokens  ·  r refresh  ·  q quit</Text>
      </Box>
    </Box>
  );
};

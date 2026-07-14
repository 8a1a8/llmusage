import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';
import {filterBySource, groupByModel, groupByPeriod, groupByProject, groupBySource, totalsFor} from './aggregate.js';
import {scanUsage} from './scan.js';
import type {Period, ScanOptions, ScanResult, Source} from './types.js';
import {formatProject, formatTokens, formatUsd} from './utils.js';

const periods: Period[] = ['day', 'week', 'month', 'year'];
const sources: Array<Source | undefined> = [undefined, 'codex', 'claude', 'claude-desktop', 'grok', 'generic'];

interface AppProps {
  initial: ScanResult;
  options: ScanOptions;
  initialPeriod: Period;
  refreshMs: number;
  scan?: (options: ScanOptions) => Promise<ScanResult>;
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

const SourceSummary = ({result, active}: {result: ScanResult; active?: Source}) => {
  const groups = groupBySource(result.records);
  if (!groups.length) return null;
  return (
    <Box gap={2}>
      <Text bold>Sources</Text>
      {groups.map(group => (
        <Text key={group.key} inverse={active === group.source}>
          {group.source} {formatTokens(group.totalTokens)} · {formatUsd(group.cost)}{group.estimated ? '~' : ''}
        </Text>
      ))}
    </Box>
  );
};

const BreakdownTable = ({result, breakdown}: {result: ScanResult; breakdown: 'model' | 'project'}) => {
  const groups = (breakdown === 'model' ? groupByModel(result.records) : groupByProject(result.records)).slice(0, 12);
  if (!groups.length) return null;
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={30}><Text bold>{breakdown.toUpperCase()}</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>INPUT</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>CACHED</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>WRITE</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>WRITE 1H</Text></Box>
        <Box width={11} justifyContent="flex-end"><Text bold>OUTPUT</Text></Box>
        <Box width={12} justifyContent="flex-end"><Text bold>COST</Text></Box>
      </Box>
      {groups.map(group => {
        const name = breakdown === 'model'
          ? `${group.source}/${group.model}`
          : formatProject(group.project ?? group.key);
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

export const App = ({initial, options, initialPeriod, refreshMs, scan = scanUsage}: AppProps) => {
  const {exit} = useApp();
  const [result, setResult] = useState(initial);
  const [periodIndex, setPeriodIndex] = useState(periods.indexOf(initialPeriod));
  const [sourceIndex, setSourceIndex] = useState(0);
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost');
  const [breakdown, setBreakdown] = useState<'model' | 'project'>('model');
  const scanning = useRef(false);
  const quitting = useRef(false);
  const resultRef = useRef(initial);
  const [lastUpdated, setLastUpdated] = useState(new Date());
  const period = periods[Math.max(0, periodIndex)];
  const source = sources[sourceIndex];
  const nextSource = sources[(sourceIndex + 1) % sources.length] ?? 'all';

  const quit = useCallback(() => {
    if (quitting.current) return;
    quitting.current = true;
    exit();
    setTimeout(() => {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(false);
      process.exit(0);
    }, 50);
  }, [exit]);

  const refresh = async () => {
    if (scanning.current) return;
    scanning.current = true;
    try {
      const next = await scan(options);
      if (next !== resultRef.current) {
        resultRef.current = next;
        setResult(next);
        setLastUpdated(new Date());
      }
    } finally {
      scanning.current = false;
    }
  };

  useEffect(() => {
    const timer = setInterval(() => void refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [refreshMs]);

  useEffect(() => {
    const onData = (data: Buffer | string) => {
      const value = data.toString();
      if (value === 'q' || value === 'Q' || value === '\u0003' || value === '\u001b') quit();
    };
    process.stdin.on('data', onData);
    return () => {
      process.stdin.off('data', onData);
    };
  }, [quit]);

  useInput((input, key) => {
    const command = input.toLowerCase();
    if (command === 'q' || key.escape || (key.ctrl && command === 'c')) quit();
    else if (key.leftArrow) setPeriodIndex(index => (index - 1 + periods.length) % periods.length);
    else if (key.rightArrow) setPeriodIndex(index => (index + 1) % periods.length);
    else if (command === 's') setSourceIndex(index => (index + 1) % sources.length);
    else if (command === 'm') setMetric(value => value === 'cost' ? 'tokens' : 'cost');
    else if (command === 'p') setBreakdown(value => value === 'model' ? 'project' : 'model');
    else if (command === 'r') void refresh();
  });

  const filtered = useMemo<ScanResult>(() => ({
    ...result,
    records: filterBySource(result.records, source)
  }), [result, source]);
  const totals = totalsFor(filtered.records);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">lu <Text dimColor>(llmusage)</Text></Text>
        <Text dimColor>updated {lastUpdated.toLocaleTimeString()}</Text>
      </Box>
      <Text dimColor>{result.files.length} usage files · {totals.sessions} sessions · filter <Text bold color="cyan">{source ?? 'all'}</Text> · {period} view</Text>

      <SourceSummary result={result} active={source}/>

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
        <BreakdownTable result={filtered} breakdown={breakdown}/>
      </Box>

      <Box marginTop={1} flexDirection="column">
        {totals.estimated && <Text color="yellow">~ includes estimated tokens or model pricing; see README for source accuracy.</Text>}
        {result.warnings.length > 0 && <Text color="yellow">{result.warnings.length} warning(s); use --json or --no-tui to inspect.</Text>}
        <Text dimColor>←/→ period  ·  s source ({source ?? 'all'} → {nextSource})  ·  m cost/tokens  ·  p model/project  ·  r refresh  ·  q/Q/Esc quit</Text>
      </Box>
    </Box>
  );
};

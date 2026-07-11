#!/usr/bin/env node
import React from 'react';
import {parseArgs} from 'node:util';
import {render} from 'ink';
import packageJson from '../package.json' with {type: 'json'};
import {scanUsage} from './scan.js';
import {formatSummary, jsonSummary} from './summary.js';
import {App} from './tui.js';
import type {Period, Source} from './types.js';

const help = `llmusage ${packageJson.version}

Inspect local Codex, Claude Code, and Grok CLI JSONL sessions.

Usage:
  lu [paths...] [options]
  llmusage [paths...] [options]

Options:
  --path <path>       Additional JSONL file or directory (repeatable)
  --source <source>   codex, claude, grok, or generic (repeatable)
  --period <period>   day, week, month, or year (default: day)
  --since <date>      Include usage on/after YYYY-MM-DD
  --until <date>      Include usage on/before YYYY-MM-DD
  --pricing <file>    Prepend custom per-million-token pricing rules
  --refresh <secs>    TUI refresh interval (default: 30)
  --json              Print machine-readable results
  --no-tui            Print tables even in an interactive terminal
  --tui               Force the interactive terminal UI
  --help              Show help
  --version           Show version

TUI keys: ←/→ period · s source · m metric · p model/project · r refresh · q/Q/Esc quit`;

const fail = (message: string): never => {
  process.stderr.write(`llmusage: ${message}\n`);
  process.exit(1);
};

const one = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.at(-1) : value;

const parseDate = (value: string | undefined, endOfDay = false): Date | undefined => {
  if (!value) return undefined;
  const suffix = endOfDay ? 'T23:59:59.999' : 'T00:00:00.000';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}${suffix}`) : new Date(value);
  if (Number.isNaN(date.valueOf())) fail(`Invalid date: ${value}`);
  return date;
};

const main = async (): Promise<void> => {
  const {values, positionals} = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      path: {type: 'string', multiple: true},
      source: {type: 'string', multiple: true},
      period: {type: 'string', default: 'day'},
      since: {type: 'string'},
      until: {type: 'string'},
      pricing: {type: 'string'},
      refresh: {type: 'string', default: '30'},
      json: {type: 'boolean', default: false},
      'no-tui': {type: 'boolean', default: false},
      tui: {type: 'boolean', default: false},
      help: {type: 'boolean', short: 'h', default: false},
      version: {type: 'boolean', short: 'v', default: false}
    }
  });

  if (values.help) return void process.stdout.write(`${help}\n`);
  if (values.version) return void process.stdout.write(`${packageJson.version}\n`);

  const validPeriods: Period[] = ['day', 'week', 'month', 'year'];
  const period = one(values.period) as Period;
  if (!validPeriods.includes(period)) fail(`Unknown period "${period}".`);

  const requestedSources = values.source as string[] | undefined;
  const validSources: Source[] = ['codex', 'claude', 'grok', 'generic'];
  if (requestedSources?.some(source => !validSources.includes(source as Source))) {
    fail('Source must be codex, claude, grok, or generic.');
  }

  const refreshSeconds = Number(one(values.refresh));
  if (!Number.isFinite(refreshSeconds) || refreshSeconds < 1) fail('Refresh must be at least 1 second.');

  const paths = [...positionals, ...((values.path as string[] | undefined) ?? [])];
  const options = {
    paths: paths.length ? paths : undefined,
    sources: requestedSources as Source[] | undefined,
    since: parseDate(one(values.since)),
    until: parseDate(one(values.until), true),
    pricingFile: one(values.pricing)
  };
  const result = await scanUsage(options);

  if (values.json) {
    process.stdout.write(`${JSON.stringify(jsonSummary(result, period), null, 2)}\n`);
    return;
  }

  const useTui = Boolean(values.tui || (process.stdout.isTTY && process.stdin.isTTY && !values['no-tui']));
  if (!useTui) {
    process.stdout.write(`${formatSummary(result, period)}\n`);
    return;
  }
  render(<App initial={result} options={options} initialPeriod={period} refreshMs={refreshSeconds * 1000}/>);
};

main().catch(error => fail(error instanceof Error ? error.message : String(error)));

import {appendFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import React from 'react';
import {render} from 'ink';
import {createUsageScanner} from '../dist/scan.js';
import {App} from '../dist/tui.js';

const iterations = Number(process.argv[2] ?? 400);
const fileCount = Number(process.argv[3] ?? 120);
const recordsPerFile = Number(process.argv[4] ?? 150);
const scannerOnly = process.argv.includes('--scanner-only');
const diagnosticGc = process.argv.includes('--diagnostic-gc');
const wait = (milliseconds) => new Promise(resolve => setTimeout(resolve, milliseconds));
const mb = value => Math.round(value / 1_048_576);
const timestamp = '2026-07-13T12:00:00Z';

const directory = await mkdtemp(join(tmpdir(), 'llmusage-tui-memory-'));
const counts = Array(fileCount).fill(recordsPerFile);
const sessionPath = index => join(directory, `session-${String(index).padStart(4, '0')}.jsonl`);
const usageLine = total => JSON.stringify({
  timestamp,
  type: 'event_msg',
  payload: {type: 'token_count', info: {total_token_usage: {
    input_tokens: total,
    cached_input_tokens: Math.floor(total / 2),
    output_tokens: Math.floor(total / 10)
  }}}
});

try {
  for (let start = 0; start < fileCount; start += 16) {
    await Promise.all(Array.from({length: Math.min(16, fileCount - start)}, async (_, offset) => {
      const index = start + offset;
      const lines = [JSON.stringify({
        timestamp,
        type: 'turn_context',
        payload: {model: 'gpt-5', cwd: `/work/project-${index % 12}`}
      })];
      for (let record = 1; record <= recordsPerFile; record++) lines.push(usageLine(record * 100));
      await writeFile(sessionPath(index), lines.join('\n'));
    }));
  }

  const scanner = createUsageScanner();
  const options = {paths: [directory], rollup: 'day'};
  const initial = await scanner.scan(options);
  let latest = initial;
  let scans = 0;
  let changedScans = 0;
  const scan = async scanOptions => {
    scans++;
    const next = await scanner.scan(scanOptions);
    if (next !== latest) changedScans++;
    latest = next;
    return next;
  };

  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.isTTY = true;
  stdout.on('data', () => {});
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const instance = scannerOnly ? undefined : render(React.createElement(App, {
      initial,
      options,
      initialPeriod: 'day',
      refreshMs: 40,
      scan
    }), {stdout, stdin, exitOnCtrlC: false, patchConsole: false});
  if (instance) await wait(100);

  const startHeap = process.memoryUsage().heapUsed;
  let peakHeap = startHeap;
  for (let iteration = 0; iteration < iterations; iteration++) {
    const index = iteration % fileCount;
    counts[index]++;
    await appendFile(sessionPath(index), `\n${usageLine(counts[index] * 100)}`);
    if (scannerOnly) await scan(options);
    else await wait(45);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  if (instance) await wait(250);
  const memory = process.memoryUsage();
  let heapAfterDiagnosticGc;
  if (diagnosticGc) {
    if (typeof global.gc !== 'function') throw new Error('Use node --expose-gc with --diagnostic-gc.');
    global.gc();
    heapAfterDiagnosticGc = process.memoryUsage().heapUsed;
  }
  instance?.unmount();
  stdin.end();
  stdout.end();

  const result = {
    forcedGc: diagnosticGc,
    mode: scannerOnly ? 'scanner' : 'tui',
    iterations,
    scans,
    changedScans,
    sourceRecords: fileCount * recordsPerFile,
    rolledRecords: latest.records.length,
    heapStartMB: mb(startHeap),
    heapPeakMB: mb(peakHeap),
    heapEndMB: mb(memory.heapUsed),
    ...(heapAfterDiagnosticGc === undefined ? {} : {heapAfterDiagnosticGcMB: mb(heapAfterDiagnosticGc)}),
    rssEndMB: mb(memory.rss)
  };
  console.log(JSON.stringify(result));
  if (changedScans < Math.min(50, Math.floor(iterations / 4))) {
    throw new Error(`Only ${changedScans} changed scans completed; the probe did not exercise enough live updates.`);
  }
  if (memory.heapUsed - startHeap > 192 * 1_048_576 || peakHeap - startHeap > 384 * 1_048_576) {
    throw new Error('Live TUI heap growth exceeded the bounded probe threshold.');
  }
} finally {
  await rm(directory, {recursive: true, force: true});
}

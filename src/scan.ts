import {stat} from 'node:fs/promises';
import {discoverFiles} from './discovery.js';
import {parseFile} from './parsers.js';
import {applyPricing, loadPricing} from './pricing.js';
import type {DiscoveredFile, ScanOptions, ScanResult, UsageRecord} from './types.js';

interface FileSnapshot extends DiscoveredFile {
  size: number;
  mtimeMs: number;
}

interface ParseCacheEntry {
  size: number;
  mtimeMs: number;
  source: DiscoveredFile['source'];
  records: UsageRecord[];
}

export interface UsageScanner {
  scan(options?: ScanOptions): Promise<ScanResult>;
  clear(): void;
}

const snapshotFiles = async (
  files: DiscoveredFile[],
  options: ScanOptions,
  warnings: string[]
): Promise<FileSnapshot[]> => {
  const output: FileSnapshot[] = [];
  const queue = [...files];
  const pruneBefore = !options.paths?.length ? options.since?.valueOf() : undefined;
  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        const info = await stat(file.path);
        if (pruneBefore !== undefined && info.mtimeMs < pruneBefore) continue;
        output.push({...file, size: info.size, mtimeMs: info.mtimeMs});
      } catch (error) {
        warnings.push(`Could not inspect ${file.path}: ${(error as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(32, files.length)}, worker));
  return output.sort((a, b) => a.path.localeCompare(b.path));
};

const pricingStamp = async (path?: string): Promise<string> => {
  if (!path) return 'builtin';
  const info = await stat(path);
  return `${path}:${info.size}:${info.mtimeMs}`;
};

const resultKey = (
  snapshots: FileSnapshot[],
  options: ScanOptions,
  pricing: string,
  warnings: string[]
): string => JSON.stringify({
  files: snapshots.map(file => [file.path, file.source, file.size, file.mtimeMs]),
  sources: options.sources,
  since: options.since?.toISOString(),
  until: options.until?.toISOString(),
  pricing,
  warnings
});

export const createUsageScanner = (): UsageScanner => {
  const parseCache = new Map<string, ParseCacheEntry>();
  let lastKey: string | undefined;
  let lastResult: ScanResult | undefined;

  const parseAll = async (snapshots: FileSnapshot[], warnings: string[]): Promise<UsageRecord[]> => {
    const output: UsageRecord[] = [];
    const queue = [...snapshots];
    const activePaths = new Set(snapshots.map(file => file.path));
    for (const path of parseCache.keys()) {
      if (!activePaths.has(path)) parseCache.delete(path);
    }

    const worker = async (): Promise<void> => {
      for (;;) {
        const file = queue.shift();
        if (!file) return;
        const cached = parseCache.get(file.path);
        if (
          cached &&
          cached.size === file.size &&
          cached.mtimeMs === file.mtimeMs &&
          cached.source === file.source
        ) {
          for (const record of cached.records) output.push(record);
          continue;
        }
        try {
          const records = await parseFile(file);
          parseCache.set(file.path, {
            size: file.size,
            mtimeMs: file.mtimeMs,
            source: file.source,
            records
          });
          for (const record of records) output.push(record);
        } catch (error) {
          parseCache.delete(file.path);
          warnings.push(`Could not parse ${file.path}: ${(error as Error).message}`);
        }
      }
    };

    await Promise.all(Array.from({length: Math.min(8, snapshots.length)}, worker));
    return output;
  };

  return {
    async scan(options: ScanOptions = {}): Promise<ScanResult> {
      const discovered = await discoverFiles(options.paths, options.paths?.length ? undefined : options.sources);
      const warnings = [...discovered.warnings];
      const [snapshots, priceStamp] = await Promise.all([
        snapshotFiles(discovered.files, options, warnings),
        pricingStamp(options.pricingFile)
      ]);
      const key = resultKey(snapshots, options, priceStamp, warnings);
      if (key === lastKey && lastResult) return lastResult;

      const [rawRecords, pricing] = await Promise.all([
        parseAll(snapshots, warnings),
        loadPricing(options.pricingFile)
      ]);
      const records = rawRecords
        .filter(record => !options.sources?.length || options.sources.includes(record.source))
        .filter(record => !options.since || record.timestamp >= options.since)
        .filter(record => !options.until || record.timestamp <= options.until)
        .map(record => applyPricing(record, pricing))
        .sort((a, b) => a.timestamp.valueOf() - b.timestamp.valueOf());
      const unknownPricing = new Set(records.filter(record => !record.pricing).map(record => `${record.source}/${record.model}`));
      for (const model of unknownPricing) warnings.push(`No pricing rule matched ${model}; cost is shown as $0 and marked estimated.`);

      const result = {records, files: snapshots.map(({size: _size, mtimeMs: _mtimeMs, ...file}) => file), warnings};
      lastKey = key;
      lastResult = result;
      return result;
    },
    clear(): void {
      parseCache.clear();
      lastKey = undefined;
      lastResult = undefined;
    }
  };
};

const defaultScanner = createUsageScanner();

export const scanUsage = (options: ScanOptions = {}): Promise<ScanResult> => defaultScanner.scan(options);

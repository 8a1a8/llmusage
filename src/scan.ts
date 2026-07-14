import {stat} from 'node:fs/promises';
import {discoverFiles} from './discovery.js';
import {parseFile} from './parsers.js';
import {applyPricing, loadPricing} from './pricing.js';
import type {CostedUsage, DiscoveredFile, PricingRule, ScanOptions, ScanResult, UsageRecord} from './types.js';

interface FileSnapshot extends DiscoveredFile {
  size: number;
  mtimeMs: number;
}

interface ParseCacheEntry {
  size: number;
  mtimeMs: number;
  source: DiscoveredFile['source'];
  selection: string;
  records: CostedUsage[];
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
  rollup: options.rollup,
  pricing,
  warnings
});

const dailyTimestamp = (timestamp: Date): Date =>
  new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate());

const rollupKey = (record: CostedUsage): string => JSON.stringify([
  record.timestamp.getFullYear(),
  record.timestamp.getMonth(),
  record.timestamp.getDate(),
  record.source,
  record.model,
  record.project,
  record.sessionId
]);

const matchesOptions = (record: UsageRecord, options: ScanOptions): boolean =>
  (!options.sources?.length || options.sources.includes(record.source)) &&
  (!options.since || record.timestamp >= options.since) &&
  (!options.until || record.timestamp <= options.until);

const priceRecords = (records: UsageRecord[], pricing: PricingRule[], options: ScanOptions): CostedUsage[] => {
  if (!options.rollup) {
    return records.filter(record => matchesOptions(record, options)).map(record => applyPricing(record, pricing));
  }
  const groups = new Map<string, CostedUsage>();
  for (const record of records) {
    if (!matchesOptions(record, options)) continue;
    const priced = applyPricing(record, pricing);
    const key = rollupKey(priced);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {...priced, timestamp: dailyTimestamp(priced.timestamp)});
      continue;
    }
    existing.uncachedInputTokens += priced.uncachedInputTokens;
    existing.cachedInputTokens += priced.cachedInputTokens;
    existing.cacheWriteTokens += priced.cacheWriteTokens;
    existing.cacheWrite1hTokens += priced.cacheWrite1hTokens;
    existing.outputTokens += priced.outputTokens;
    existing.reasoningTokens += priced.reasoningTokens;
    existing.cost += priced.cost;
    existing.estimated ||= priced.estimated;
    existing.pricingEstimated ||= priced.pricingEstimated;
    if (!existing.estimationNote && priced.estimationNote) existing.estimationNote = priced.estimationNote;
  }
  return [...groups.values()];
};

export const createUsageScanner = (): UsageScanner => {
  const parseCache = new Map<string, ParseCacheEntry>();
  let cachedPricingStamp: string | undefined;
  let lastKey: string | undefined;
  let lastResult: ScanResult | undefined;

  const parseAll = async (
    snapshots: FileSnapshot[],
    warnings: string[],
    pricing: PricingRule[],
    options: ScanOptions
  ): Promise<CostedUsage[]> => {
    const output: CostedUsage[] = [];
    const queue = [...snapshots];
    const selection = JSON.stringify({
      sources: options.sources,
      since: options.since?.toISOString(),
      until: options.until?.toISOString(),
      rollup: options.rollup
    });
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
          cached.source === file.source &&
          cached.selection === selection
        ) {
          for (const record of cached.records) output.push(record);
          continue;
        }
        try {
          const records = priceRecords(await parseFile(file), pricing, options);
          parseCache.set(file.path, {
            size: file.size,
            mtimeMs: file.mtimeMs,
            source: file.source,
            selection,
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

      if (cachedPricingStamp !== priceStamp) {
        parseCache.clear();
        cachedPricingStamp = priceStamp;
      }
      const pricing = await loadPricing(options.pricingFile);
      const records = (await parseAll(snapshots, warnings, pricing, options))
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
      cachedPricingStamp = undefined;
      lastKey = undefined;
      lastResult = undefined;
    }
  };
};

const defaultScanner = createUsageScanner();

export const scanUsage = (options: ScanOptions = {}): Promise<ScanResult> => defaultScanner.scan(options);

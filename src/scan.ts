import {discoverFiles} from './discovery.js';
import {parseFile} from './parsers.js';
import {applyPricing, loadPricing} from './pricing.js';
import type {DiscoveredFile, ScanOptions, ScanResult, UsageRecord} from './types.js';

const parseAll = async (files: DiscoveredFile[], warnings: string[]): Promise<UsageRecord[]> => {
  const output: UsageRecord[] = [];
  const queue = [...files];
  const worker = async (): Promise<void> => {
    for (;;) {
      const file = queue.shift();
      if (!file) return;
      try {
        output.push(...await parseFile(file));
      } catch (error) {
        warnings.push(`Could not parse ${file.path}: ${(error as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({length: Math.min(8, files.length)}, worker));
  return output;
};

export const scanUsage = async (options: ScanOptions = {}): Promise<ScanResult> => {
  const discovered = await discoverFiles(options.paths, options.paths?.length ? undefined : options.sources);
  const warnings = [...discovered.warnings];
  const [rawRecords, pricing] = await Promise.all([
    parseAll(discovered.files, warnings),
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
  return {records, files: discovered.files, warnings};
};

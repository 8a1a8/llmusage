import {scanUsage} from '../dist/scan.js';

const forceGc = !process.argv.includes('--no-gc');

if (forceGc && typeof global.gc !== 'function') {
  throw new Error('Run with node --expose-gc scripts/memory-probe.mjs');
}

const iterations = Number(process.argv[2] ?? 6);
const defaultSince = new Date();
defaultSince.setDate(defaultSince.getDate() - 7);
const options = {since: new Date(process.argv[3] ?? defaultSince)};

for (let scan = 1; scan <= iterations; scan++) {
  let result = await scanUsage(options);
  const before = process.memoryUsage();
  result = undefined;
  if (forceGc) global.gc();
  const after = process.memoryUsage();
  if (scan === 1 || scan === iterations || scan % 10 === 0) {
    console.log(JSON.stringify({
      scan,
      heapBeforeMB: Math.round(before.heapUsed / 1_048_576),
      heapAfterMB: Math.round(after.heapUsed / 1_048_576),
      rssMB: Math.round(after.rss / 1_048_576),
      forcedGc: forceGc
    }));
  }
}

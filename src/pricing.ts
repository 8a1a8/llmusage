import {readFile} from 'node:fs/promises';
import type {CostedUsage, PricingRule, Source, UsageRecord} from './types.js';
import {isRecord} from './utils.js';

// USD per one million tokens. Order matters: specific patterns precede aliases.
export const BUILTIN_PRICING: PricingRule[] = [
  {pattern: '^gpt-5\\.5-pro', input: 30, cachedInput: 30, cacheWrite: 30, cacheWrite1h: 30, output: 180, label: 'GPT-5.5 Pro'},
  {pattern: '^gpt-5\\.5', input: 5, cachedInput: 0.5, cacheWrite: 5, cacheWrite1h: 5, output: 30, label: 'GPT-5.5'},
  {pattern: '^gpt-5\\.4-pro', input: 30, cachedInput: 30, cacheWrite: 30, cacheWrite1h: 30, output: 180, label: 'GPT-5.4 Pro'},
  {pattern: '^gpt-5\\.4-mini', input: 0.75, cachedInput: 0.075, cacheWrite: 0.75, cacheWrite1h: 0.75, output: 4.5, label: 'GPT-5.4 mini'},
  {pattern: '^gpt-5\\.4', input: 2.5, cachedInput: 0.25, cacheWrite: 2.5, cacheWrite1h: 2.5, output: 15, label: 'GPT-5.4'},
  {pattern: '^gpt-5\\.3-codex', input: 1.75, cachedInput: 0.175, cacheWrite: 1.75, cacheWrite1h: 1.75, output: 14, label: 'GPT-5.3 Codex', estimated: true},
  {pattern: '^gpt-5\\.2', input: 1.75, cachedInput: 0.175, cacheWrite: 1.75, cacheWrite1h: 1.75, output: 14, label: 'GPT-5.2'},
  {pattern: '^gpt-5\\.1', input: 1.25, cachedInput: 0.125, cacheWrite: 1.25, cacheWrite1h: 1.25, output: 10, label: 'GPT-5.1'},
  {pattern: '^gpt-5-mini', input: 0.25, cachedInput: 0.025, cacheWrite: 0.25, cacheWrite1h: 0.25, output: 2, label: 'GPT-5 mini'},
  {pattern: '^gpt-5-nano', input: 0.05, cachedInput: 0.005, cacheWrite: 0.05, cacheWrite1h: 0.05, output: 0.4, label: 'GPT-5 nano'},
  {pattern: '^gpt-5(?:$|-codex)', input: 1.25, cachedInput: 0.125, cacheWrite: 1.25, cacheWrite1h: 1.25, output: 10, label: 'GPT-5'},
  {pattern: '^gpt-5', input: 1.25, cachedInput: 0.125, cacheWrite: 1.25, cacheWrite1h: 1.25, output: 10, label: 'GPT-5 family fallback', estimated: true},
  {pattern: '^gpt-4\\.1-mini', input: 0.4, cachedInput: 0.1, cacheWrite: 0.4, cacheWrite1h: 0.4, output: 1.6, label: 'GPT-4.1 mini'},
  {pattern: '^gpt-4\\.1', input: 2, cachedInput: 0.5, cacheWrite: 2, cacheWrite1h: 2, output: 8, label: 'GPT-4.1'},
  {pattern: '^o3', input: 2, cachedInput: 0.5, cacheWrite: 2, cacheWrite1h: 2, output: 8, label: 'o3'},
  {pattern: 'fable-5', source: 'claude', input: 10, cachedInput: 1, cacheWrite: 12.5, cacheWrite1h: 20, output: 50, label: 'Claude Fable 5'},
  {pattern: 'sonnet-5', source: 'claude', input: 2, cachedInput: 0.2, cacheWrite: 2.5, cacheWrite1h: 4, output: 10, label: 'Claude Sonnet 5 introductory', endsAt: '2026-08-31T23:59:59.999Z'},
  {pattern: 'sonnet-5', source: 'claude', input: 3, cachedInput: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15, label: 'Claude Sonnet 5', startsAt: '2026-09-01T00:00:00.000Z'},
  {pattern: 'opus-4-[5-8]', source: 'claude', input: 5, cachedInput: 0.5, cacheWrite: 6.25, cacheWrite1h: 10, output: 25, label: 'Claude Opus 4.5+'},
  {pattern: 'opus', source: 'claude', input: 15, cachedInput: 1.5, cacheWrite: 18.75, cacheWrite1h: 30, output: 75, label: 'Claude Opus (legacy)'},
  {pattern: 'haiku-4-5', source: 'claude', input: 1, cachedInput: 0.1, cacheWrite: 1.25, cacheWrite1h: 2, output: 5, label: 'Claude Haiku 4.5'},
  {pattern: 'haiku-3\\.5', source: 'claude', input: 0.8, cachedInput: 0.08, cacheWrite: 1, cacheWrite1h: 1.6, output: 4, label: 'Claude Haiku 3.5'},
  {pattern: 'haiku', source: 'claude', input: 0.25, cachedInput: 0.03, cacheWrite: 0.3, cacheWrite1h: 0.5, output: 1.25, label: 'Claude Haiku (legacy)'},
  {pattern: 'sonnet', source: 'claude', input: 3, cachedInput: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15, label: 'Claude Sonnet'},
  {pattern: '^claude-', source: 'claude', input: 3, cachedInput: 0.3, cacheWrite: 3.75, cacheWrite1h: 6, output: 15, label: 'Claude fallback', estimated: true},
  {pattern: '^grok-4\\.5', source: 'grok', input: 2, cachedInput: 2, cacheWrite: 2, cacheWrite1h: 2, output: 6, label: 'Grok 4.5'},
  {pattern: '^grok-(4\\.20|4\\.3|4|3)', source: 'grok', input: 1.25, cachedInput: 0.2, cacheWrite: 1.25, cacheWrite1h: 1.25, output: 2.5, label: 'Grok 4.3 aliases'},
  {pattern: '^grok-build-0\\.1', source: 'grok', input: 1, cachedInput: 0.2, cacheWrite: 1, cacheWrite1h: 1, output: 2, label: 'Grok Build 0.1'}
];

const validateRules = (value: unknown): PricingRule[] => {
  if (!Array.isArray(value)) throw new Error('Pricing file must contain a JSON array.');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.pattern !== 'string') {
      throw new Error(`Pricing rule ${index + 1} needs a string pattern.`);
    }
    for (const key of ['input', 'cachedInput', 'cacheWrite', 'output'] as const) {
      if (typeof item[key] !== 'number' || item[key] < 0) {
        throw new Error(`Pricing rule ${index + 1} needs a non-negative ${key}.`);
      }
    }
    if (item.cacheWrite1h === undefined) item.cacheWrite1h = item.cacheWrite;
    if (typeof item.cacheWrite1h !== 'number' || item.cacheWrite1h < 0) {
      throw new Error(`Pricing rule ${index + 1} needs a non-negative cacheWrite1h.`);
    }
    return item as unknown as PricingRule;
  });
};

export const loadPricing = async (path?: string): Promise<PricingRule[]> => {
  if (!path) return BUILTIN_PRICING;
  const custom = validateRules(JSON.parse(await readFile(path, 'utf8')));
  return [...custom, ...BUILTIN_PRICING];
};

export const findPricing = (model: string, source: Source, rules: PricingRule[], at = new Date()): PricingRule | undefined =>
  rules.find(rule =>
    (!rule.source || rule.source === source || (source === 'claude-desktop' && rule.source === 'claude')) &&
    (!rule.startsAt || at >= new Date(rule.startsAt)) &&
    (!rule.endsAt || at <= new Date(rule.endsAt)) &&
    new RegExp(rule.pattern, 'i').test(model)
  );

export const applyPricing = (record: UsageRecord, rules: PricingRule[]): CostedUsage => {
  const pricing = findPricing(record.model, record.source, rules, record.timestamp);
  if (!pricing) return {...record, cost: 0, pricingEstimated: true};
  const cost = (
    record.uncachedInputTokens * pricing.input +
    record.cachedInputTokens * pricing.cachedInput +
    record.cacheWriteTokens * pricing.cacheWrite +
    record.cacheWrite1hTokens * pricing.cacheWrite1h +
    record.outputTokens * pricing.output
  ) / 1_000_000;
  return {...record, cost, pricing, pricingEstimated: Boolean(record.estimated || pricing.estimated)};
};

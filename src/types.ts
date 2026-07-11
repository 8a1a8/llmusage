export type Source = 'codex' | 'claude' | 'grok' | 'generic';
export type Period = 'day' | 'week' | 'month' | 'year';

export interface UsageRecord {
  timestamp: Date;
  source: Source;
  model: string;
  project: string;
  sessionId: string;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  estimated?: boolean;
  estimationNote?: string;
}

export interface Pricing {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
}

export interface PricingRule extends Pricing {
  pattern: string;
  source?: Source;
  label?: string;
  estimated?: boolean;
  startsAt?: string;
  endsAt?: string;
}

export interface CostedUsage extends UsageRecord {
  cost: number;
  pricing?: PricingRule;
  pricingEstimated: boolean;
}

export interface UsageTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  records: number;
  sessions: number;
  estimated: boolean;
}

export interface UsageGroup extends UsageTotals {
  key: string;
  source?: Source;
  model?: string;
  project?: string;
}

export interface DiscoveredFile {
  path: string;
  source: Source;
}

export interface ScanOptions {
  paths?: string[];
  sources?: Source[];
  since?: Date;
  until?: Date;
  pricingFile?: string;
}

export interface ScanResult {
  records: CostedUsage[];
  files: DiscoveredFile[];
  warnings: string[];
}

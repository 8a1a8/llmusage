import {homedir} from 'node:os';
import {resolve} from 'node:path';
import type {Period} from './types.js';

export const toNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

export const parseTimestamp = (value: unknown, fallback = new Date(0)): Date => {
  if (typeof value === 'number') {
    const date = new Date(value < 10_000_000_000 ? value * 1000 : value);
    return Number.isNaN(date.valueOf()) ? fallback : date;
  }
  if (typeof value === 'string') {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? fallback : date;
  }
  return fallback;
};

export const expandHome = (path: string): string => {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
};

const pad = (value: number): string => String(value).padStart(2, '0');

export const periodKey = (date: Date, period: Period): string => {
  const local = new Date(date);
  if (period === 'day') {
    return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
  }
  if (period === 'month') {
    return `${local.getFullYear()}-${pad(local.getMonth() + 1)}`;
  }
  if (period === 'year') return String(local.getFullYear());

  const monday = new Date(local.getFullYear(), local.getMonth(), local.getDate());
  const weekday = monday.getDay() || 7;
  monday.setDate(monday.getDate() - weekday + 1);
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
};

export const formatTokens = (value: number): string => {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
};

export const formatUsd = (value: number): string =>
  value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

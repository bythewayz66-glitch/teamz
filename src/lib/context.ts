/**
 * ============================================================================
 *  Context accounting
 * ============================================================================
 *
 *  The composer shows a "Context Usage" meter, and the usage panel shows token
 *  spend per agent per day. Both need a token estimate that is honest about
 *  being an estimate: we do not ship a tokeniser, so we use the standard
 *  heuristic of ~4 characters per token for English prose, with a floor of one
 *  token per non-empty message.
 *
 *  Everything here is pure, so the numbers are unit-tested rather than eyeballed.
 */

import type { Message, UsageEntry } from '../types';

/** Rough characters-per-token ratio for mixed English prose and code. */
export const CHARS_PER_TOKEN = 4;

/** Context window assumed for the model pill, in tokens. */
export const CONTEXT_WINDOW = 128_000;

/** Estimate the token cost of a string. */
export function estimateTokens(text: string): number {
  const trimmed = text ?? '';
  if (!trimmed.trim()) return 0;
  return Math.max(1, Math.ceil(trimmed.length / CHARS_PER_TOKEN));
}

/** Estimate the token cost of a whole message list. */
export function estimateHistoryTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.text) + 4, 0);
}

export interface ContextUsage {
  /** Tokens currently occupied by the conversation. */
  used: number;
  /** The window the model is assumed to have. */
  total: number;
  /** 0..1, clamped. */
  ratio: number;
  /** `ok` under 60%, `warn` 60-85%, `full` above. */
  level: 'ok' | 'warn' | 'full';
  /** Human label, e.g. "12.4k / 128k". */
  label: string;
}

/** Compact token count: 940 → "940", 12_400 → "12.4k", 1_240_000 → "1.2M". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    // One decimal below 100k so 12.4k does not collapse to 12k; whole numbers
    // above that, where the decimal is noise.
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function contextUsage(messages: Message[], total: number = CONTEXT_WINDOW): ContextUsage {
  const used = estimateHistoryTokens(messages);
  const ratio = total > 0 ? Math.min(1, used / total) : 0;
  const level: ContextUsage['level'] = ratio >= 0.85 ? 'full' : ratio >= 0.6 ? 'warn' : 'ok';
  return { used, total, ratio, level, label: `${formatTokens(used)} / ${formatTokens(total)}` };
}

/** `YYYY-MM-DD` in local time — the key usage is bucketed by. */
export function dayKey(ts: number = Date.now()): string {
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Fold one completed run into the usage ledger.
 *
 * Returns a new array; the entry for (day, agent) is replaced, never mutated,
 * so React sees a new reference and the panel re-renders.
 */
export function recordUsage(
  ledger: UsageEntry[],
  agentId: string,
  promptTokens: number,
  completionTokens: number,
  at: number = Date.now(),
): UsageEntry[] {
  const day = dayKey(at);
  const idx = ledger.findIndex((e) => e.day === day && e.agentId === agentId);
  if (idx === -1) {
    return [...ledger, { day, agentId, promptTokens, completionTokens, runs: 1 }];
  }
  const next = ledger.slice();
  const prev = next[idx];
  next[idx] = {
    ...prev,
    promptTokens: prev.promptTokens + promptTokens,
    completionTokens: prev.completionTokens + completionTokens,
    runs: prev.runs + 1,
  };
  return next;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  runs: number;
}

export function totalsFor(ledger: UsageEntry[], agentId?: string): UsageTotals {
  const rows = agentId ? ledger.filter((e) => e.agentId === agentId) : ledger;
  const promptTokens = rows.reduce((s, e) => s + e.promptTokens, 0);
  const completionTokens = rows.reduce((s, e) => s + e.completionTokens, 0);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    runs: rows.reduce((s, e) => s + e.runs, 0),
  };
}

/**
 * The last `days` days as a dense series, oldest first, so a sparkline has one
 * point per day even when nothing ran.
 */
export function dailySeries(
  ledger: UsageEntry[],
  days = 7,
  agentId?: string,
  now: number = Date.now(),
): { day: string; label: string; tokens: number }[] {
  const out: { day: string; label: string; tokens: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const ts = now - i * 24 * 60 * 60 * 1000;
    const key = dayKey(ts);
    const rows = ledger.filter((e) => e.day === key && (!agentId || e.agentId === agentId));
    out.push({
      day: key,
      label: new Date(ts).toLocaleDateString([], { weekday: 'short' }),
      tokens: rows.reduce((s, e) => s + e.promptTokens + e.completionTokens, 0),
    });
  }
  return out;
}

/**
 * Percentage change between the last `days` and the `days` before that.
 * Returns null when there is no baseline to compare against, so the UI can say
 * "no prior data" instead of inventing a number.
 */
export function trendPercent(
  ledger: UsageEntry[],
  days = 7,
  agentId?: string,
  now: number = Date.now(),
): number | null {
  const windowMs = days * 24 * 60 * 60 * 1000;
  const recent = ledger
    .filter((e) => !agentId || e.agentId === agentId)
    .filter((e) => {
      const ts = new Date(`${e.day}T12:00:00`).getTime();
      return ts > now - windowMs;
    })
    .reduce((s, e) => s + e.promptTokens + e.completionTokens, 0);
  const prior = ledger
    .filter((e) => !agentId || e.agentId === agentId)
    .filter((e) => {
      const ts = new Date(`${e.day}T12:00:00`).getTime();
      return ts <= now - windowMs && ts > now - windowMs * 2;
    })
    .reduce((s, e) => s + e.promptTokens + e.completionTokens, 0);
  if (prior === 0) return null;
  return Math.round(((recent - prior) / prior) * 100);
}

import { normalizeUsageDay, type UsageDay } from '../lib/usageLedger';

export function usageUrl(): string {
  const host = window.location.hostname || '127.0.0.1';
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${proto}//${host}:8897/usage`;
}

/** Today's token totals from the endpoint (read-only). Null when unreachable or malformed. */
export async function fetchUsageDay(): Promise<UsageDay | null> {
  const res = await fetch(usageUrl(), { headers: { Accept: 'application/json' } });
  if (!res.ok) return null;
  return normalizeUsageDay(await res.json());
}

/** Small formatting + id helpers shared across components. */

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** "just now", "4m", "2h", "Yesterday", "12 Mar" — compact sidebar style. */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

export function formatDayLabel(ts: number): string {
  const now = new Date();
  const then = new Date(ts);
  const sameDay = now.toDateString() === then.toDateString();
  if (sameDay) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (yesterday.toDateString() === then.toDateString()) return 'Yesterday';
  return then.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

/** True when two messages are far enough apart to warrant a new day divider. */
export function isNewDay(prev: number | undefined, current: number): boolean {
  if (!prev) return true;
  return new Date(prev).toDateString() !== new Date(current).toDateString();
}

export const initialOf = (name: string) => name.trim().charAt(0).toUpperCase() || '#';

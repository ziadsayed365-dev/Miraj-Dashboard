export function egyptToday(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000 - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function firstOfMonth(dateStr: string): string {
  return dateStr.slice(0, 7) + "-01";
}

export function firstOfNextMonth(dateStr: string): string {
  const d = new Date(firstOfMonth(dateStr) + "T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

export function daysInMonth(dateStr: string): number {
  const start = new Date(firstOfMonth(dateStr) + "T00:00:00Z");
  const end = new Date(firstOfNextMonth(dateStr) + "T00:00:00Z");
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

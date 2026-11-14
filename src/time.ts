// Clock helpers shared by the scan and the screens.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seconds on a monotonic clock */
export const now = () => performance.now() / 1000;

/** "just now", "5m ago", "3h ago", "2 days ago", for a time in ms since the epoch */
export function ago(ms: number): string {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000)), h = Math.round(m / 60), d = Math.round(h / 24);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : h < 48 ? `${h}h ago` : `${d} days ago`;
}

/** "9s", "1m 05s", "1h 01m" */
export function duration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

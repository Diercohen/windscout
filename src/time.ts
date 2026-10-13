// Clock helpers shared by the scan and the screens.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Seconds on a monotonic clock */
export const now = () => performance.now() / 1000;

/** "9s", "1m 05s", "1h 01m" */
export function duration(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

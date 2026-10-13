// The installed version, and whether npm has a newer one.
import { readFileSync } from "node:fs";

export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
let latest: string | null = null; // newer version on npm, once known
let check: Promise<void> | undefined;

// numeric x.y.z compare; parseInt drops a prerelease suffix ("0-beta" → 0)
export function newer(a: string, b: string): boolean {
  const x = a.split(".").map((n) => parseInt(n)), y = b.split(".").map((n) => parseInt(n));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/** Asks npm once; later calls share that request. Best effort: offline or registry down just means no notice */
export function checkUpdate(): Promise<void> {
  check ??= fetch("https://registry.npmjs.org/windscout/latest", { signal: AbortSignal.timeout(3000) })
    .then((r) => r.json() as Promise<{ version?: string }>)
    .then(({ version }) => { if (version && newer(version, VERSION)) latest = version; })
    .catch(() => {});
  return check;
}

// run through npx: there's nothing installed to update, the next npx windscout@latest fetches it
export const viaNpx = () => process.env.npm_command === "exec";
export const UPDATE_COMMAND = "npm install -g windscout@latest";

/** "update available: …" with the command to run, once checkUpdate() found a newer version */
export function updateNotice(): string | null {
  if (!latest) return null;
  return `update available: ${VERSION} → ${latest} · run: ${viaNpx() ? "npx windscout@latest" : UPDATE_COMMAND}`;
}

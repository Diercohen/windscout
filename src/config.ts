// The picker's selection, what the last parallel scan found its containers can do, the last scan's working results, and the
// scan screen's table, remembered between runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Result } from "./probe.js";
import { ORDERS, type Order } from "./scan.js";
import { COUNTRIES, PROTOCOLS } from "./windscribe.js";

// false hides the speed test: every scan is connect-only, and a saved "on" reads as off
export const SPEED_TEST = true;

export const DEFAULT_TIMEOUT = 15;
export const MIN_TIMEOUT = 10; // seconds; shorter cuts off connections that would have worked
export const DEFAULT_HOLD = 30;
export const MIN_HOLD = 10; // seconds; shorter says little about how long a connection lasts

export const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "windscout", "config.json");
const DOCKER_FILE = join(dirname(CONFIG), "docker.json"); // what the last parallel scan found its containers can do
export const LAST_FILE = join(dirname(CONFIG), "last.json"); // the last scan's working connections
const VIEW_FILE = join(dirname(CONFIG), "view.json"); // the table the scan screen was left on

export interface Choice {
  countries: string[];
  protocols: string[];
  speed: boolean; // speed test on
  firewall: boolean; // block internet while scanning
  order: Order; // the scanning type: what the scan tries, in which order
  stopAtFirst: boolean; // stop at the first working connection that holds up
  hold: number; // seconds each working connection has to hold up, for stop at the first
  allPorts: boolean; // each protocol on every port it has, not just its default
  timeout: number; // seconds to wait for each connection
  docker: boolean; // parallel scan in docker containers
}

/** The saved choice, minus anything this version doesn't offer; null on first run or an unreadable file */
export function loadConfig(): Choice | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG, "utf8"));
    return {
      countries: (c.countries ?? []).filter((x: string) => COUNTRIES.includes(x)),
      protocols: (c.protocols ?? []).filter((x: string) => PROTOCOLS.includes(x)),
      speed: SPEED_TEST && c.speed !== false,
      firewall: c.firewall === true,
      order: ORDERS.includes(c.order) ? c.order : c.random === true ? "random" : "default", // before scanning types: random on or off
      stopAtFirst: c.stopAtFirst === true,
      hold: c.hold >= MIN_HOLD ? c.hold : DEFAULT_HOLD,
      allPorts: c.allPorts === true,
      timeout: c.timeout >= MIN_TIMEOUT ? c.timeout : DEFAULT_TIMEOUT,
      docker: c.docker === true,
    };
  } catch {
    return null;
  }
}

export function saveConfig(c: Choice): void {
  try {
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
  } catch {} // not being able to remember isn't worth failing the scan
}

/** Whether WireGuard worked in the docker containers last time (yes until a scan finds otherwise), for the picker's estimate */
export function loadDockerWireGuard(): boolean {
  try {
    return JSON.parse(readFileSync(DOCKER_FILE, "utf8")).wireguard !== false;
  } catch {
    return true;
  }
}

export function saveDockerWireGuard(wireguard: boolean): void {
  try {
    mkdirSync(dirname(DOCKER_FILE), { recursive: true });
    writeFileSync(DOCKER_FILE, JSON.stringify({ wireguard }) + "\n");
  } catch {} // not being able to remember isn't worth failing the scan
}

/** The scan screen's table: the ranking ("Working so far") or the availability grid; tab switches it */
export type View = "ranking" | "availability";

/** The table the last scan was left on; the ranking until the user switches */
export function loadView(): View {
  try {
    return JSON.parse(readFileSync(VIEW_FILE, "utf8")).view === "availability" ? "availability" : "ranking";
  } catch {
    return "ranking";
  }
}

export function saveView(view: View): void {
  try {
    mkdirSync(dirname(VIEW_FILE), { recursive: true });
    writeFileSync(VIEW_FILE, JSON.stringify({ view }) + "\n");
  } catch {} // not being able to remember isn't worth failing the scan
}

/** The last scan's working connections, best first (as the report numbers them), for the scanning types and windscout connect */
export interface Last {
  at: number; // when the scan ended, ms since the epoch
  results: Result[];
}

/** The last scan that found something; null when there's none or the file is unreadable */
export function loadLast(): Last | null {
  try {
    const l = JSON.parse(readFileSync(LAST_FILE, "utf8"));
    const results = (l.results ?? []).filter((r: Result) => r?.status === "ok" && typeof r.query === "string" && typeof r.protocol === "string");
    return results.length && typeof l.at === "number" ? { at: l.at, results } : null;
  } catch {
    return null;
  }
}

/** Saves a scan's working connections; a scan where nothing worked keeps the last one that found something (the network may
 * just be down). With tried (the "query protocol" pairs the scan tried), the saved connections it didn't try stay, after its own */
export function saveLast(results: Result[], at = Date.now(), tried?: ReadonlySet<string>): void {
  if (!results.length) return;
  if (tried) results = [...results, ...(loadLast()?.results ?? []).filter((r) => !tried.has(`${r.query} ${r.protocol}`))];
  try {
    mkdirSync(dirname(LAST_FILE), { recursive: true });
    writeFileSync(LAST_FILE, JSON.stringify({ at, results }, null, 2) + "\n");
  } catch {} // not being able to remember isn't worth failing the scan
}

/** Deletes the Windscribe username and password that 0.6.0 saved for the docker containers: they log in with this computer's session now */
export function forgetLogin(): void {
  try {
    rmSync(join(dirname(CONFIG), "login.json"), { force: true });
  } catch {} // not being able to delete it isn't worth failing the scan
}

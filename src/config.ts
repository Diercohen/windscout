// The picker's selection, remembered between runs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { COUNTRIES, PROTOCOLS } from "./windscribe.js";

export const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "windscout", "config.json");

export interface Choice {
  countries: string[];
  protocols: string[];
  speed: boolean; // speed test on
  firewall: boolean; // block internet while scanning
}

/** The saved choice, minus anything this version doesn't offer; null on first run or an unreadable file */
export function loadConfig(): Choice | null {
  try {
    const c = JSON.parse(readFileSync(CONFIG, "utf8"));
    return {
      countries: (c.countries ?? []).filter((x: string) => COUNTRIES.includes(x)),
      protocols: (c.protocols ?? []).filter((x: string) => PROTOCOLS.includes(x)),
      speed: c.speed !== false,
      firewall: c.firewall === true,
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

// The picker's selection, and the docker containers' Windscribe login if wanted, remembered between runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Credentials } from "./docker.js";
import { COUNTRIES, PROTOCOLS } from "./windscribe.js";

export const DEFAULT_TIMEOUT = 15;
export const MIN_TIMEOUT = 10; // seconds; shorter cuts off connections that would have worked

export const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "windscout", "config.json");
// ponytail: plain text that only this user can read, like git's credential store; the OS keychain if that's not enough
export const LOGIN_FILE = join(dirname(CONFIG), "login.json");
const DOCKER_FILE = join(dirname(CONFIG), "docker.json"); // what the last parallel scan found its containers can do

export interface Choice {
  countries: string[];
  protocols: string[];
  speed: boolean; // speed test on
  firewall: boolean; // block internet while scanning
  random: boolean; // scan the countries in a shuffled order
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
      speed: c.speed !== false,
      firewall: c.firewall === true,
      random: c.random === true,
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

/** The Windscribe login remembered for the docker containers; null when there's none */
export function loadLogin(): Credentials | null {
  try {
    const { username, password } = JSON.parse(readFileSync(LOGIN_FILE, "utf8"));
    return typeof username === "string" && typeof password === "string" ? { username, password } : null;
  } catch {
    return null;
  }
}

/** Remembers the login, or forgets it (null) */
export function saveLogin(c: Credentials | null): void {
  try {
    rmSync(LOGIN_FILE, { force: true }); // a new file gets the mode below; an old one would keep its own
    if (!c) return;
    mkdirSync(dirname(LOGIN_FILE), { recursive: true });
    writeFileSync(LOGIN_FILE, JSON.stringify(c) + "\n", { mode: 0o600 });
  } catch {} // not being able to remember isn't worth failing the scan
}

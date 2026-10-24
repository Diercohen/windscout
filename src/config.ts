// The picker's selection, and what the last parallel scan found its containers can do, remembered between runs.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { COUNTRIES, PROTOCOLS } from "./windscribe.js";

// false hides the speed test: every scan is connect-only, and a saved "on" reads as off
export const SPEED_TEST = true;

export const DEFAULT_TIMEOUT = 15;
export const MIN_TIMEOUT = 10; // seconds; shorter cuts off connections that would have worked

export const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "windscout", "config.json");
const DOCKER_FILE = join(dirname(CONFIG), "docker.json"); // what the last parallel scan found its containers can do

export interface Choice {
  countries: string[];
  protocols: string[];
  speed: boolean; // speed test on
  firewall: boolean; // block internet while scanning
  random: boolean; // scan the countries in a shuffled order
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
      random: c.random === true,
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

/** Deletes the Windscribe username and password that 0.6.0 saved for the docker containers: they log in with this computer's session now */
export function forgetLogin(): void {
  try {
    rmSync(join(dirname(CONFIG), "login.json"), { force: true });
  } catch {} // not being able to delete it isn't worth failing the scan
}

// The Windscribe desktop app, driven through the windscribe-cli it ships with.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sleep } from "./time.js";

export const CLI = "windscribe-cli";
export const DOWNLOAD_URL = "https://windscribe.com/download";
// the desktop app installs the CLI here and links it into /usr/bin (/usr/local/bin on macOS); use it directly if the link is missing.
// Windows doesn't put it on PATH at all, so there the fallback is the normal case
const DESKTOP_CLI = ({
  darwin: "/Applications/Windscribe.app/Contents/MacOS/windscribe-cli",
  win32: join(process.env.ProgramFiles || "C:\\Program Files", "Windscribe", "windscribe-cli.exe"),
} as Partial<Record<NodeJS.Platform, string>>)[process.platform] ?? "/opt/windscribe/windscribe-cli";
let cliBin = CLI;

// IKEv2 is offered by the macOS/Windows apps only
export const PROTOCOLS: readonly string[] = ["wireguard", ...(process.platform === "linux" ? [] : ["ikev2"]), "stealth", "wstunnel", "udp", "tcp"];
// ponytail: hardcoded because `windscribe-cli locations` returns nothing on 2.24; refresh when Windscribe adds countries
export const COUNTRIES: readonly string[] = `US CA MX BR AR CL CO PE GB IE FR DE NL BE LU CH AT IT ES PT DK NO SE FI IS
PL CZ SK HU RO BG GR CY TR RS HR SI BA MK AL MD UA EE LV LT IL AE AZ GE AM KZ IN JP KR
HK SG TW ID MY TH VN PH AU NZ ZA NG KE EG`.split(/\s+/);

// spawn, not execFile: if the app isn't running, the CLI launches it and the app inherits our stdout pipe.
// The pipe then stays open after the CLI exits, and execFile would wait for its timeout. Settle on exit instead
function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cliBin, args, { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const done = () => (clearTimeout(kill), p.stdout.destroy(), resolve(out));
    const kill = setTimeout(() => p.kill(), 90_000);
    p.on("error", (e) => (clearTimeout(kill), reject(e)));
    p.on("close", done);
    // the CLI's last output may still be in the pipe when it exits; read for a moment, then stop waiting
    p.on("exit", () => setTimeout(done, 300));
  });
}

/** Run a windscribe-cli command; resolves to its output */
export async function windscribe(...args: string[]): Promise<string> {
  let out: string;
  try {
    out = await run(args);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    if (cliBin === CLI && existsSync(DESKTOP_CLI)) {
      cliBin = DESKTOP_CLI;
      return windscribe(...args);
    }
    throw new Error(`${CLI} not found. Install the Windscribe desktop app (it includes ${CLI}): ${DOWNLOAD_URL}`);
  }
  // the CLI mixes JSON log lines into stdout
  return out.split("\n").filter((l) => !l.startsWith('{"tm"')).join("\n");
}

/** "Connected: Miami - Vice", "Connecting: …", "Disconnected", … */
export async function connectState(): Promise<string> {
  // macOS marks the line with a leading "*" once connected: "*Connect state: Connected: Miami - Vice"
  return (await windscribe("status")).match(/^\*?Connect state: (.*)$/m)?.[1].trim() ?? "";
}

/** Waits for the app to run and be logged in; resolves to its status output */
export async function waitForLogin(): Promise<string> {
  // the first CLI call launches the app if it isn't running; give it a moment to start and restore the session
  let status = await windscribe("status");
  for (let i = 0; i < 15 && !status.includes("Logged in"); i++) {
    await sleep(1000);
    status = await windscribe("status");
  }
  if (!status.includes("Logged in"))
    throw new Error("Windscribe is not logged in, or the app is not running. Open the Windscribe app and log in, then try again."
      + `\nDon't have it? ${DOWNLOAD_URL}`);
  return status;
}

/** A session as the app's settings keep it: the account's ID and the session's token, which the app logs in with when it starts */
export interface Session {
  userId: string;
  authHash: string;
}

// The app's settings (Qt's, as Windscribe/Windscribe2): this INI file on Linux, the user's defaults on macOS, the registry on Windows
export const SETTINGS = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Windscribe", "Windscribe2.conf");

/** A top-level value in the text of the INI file: Qt puts those under [General] */
export function iniValue(ini: string, key: string): string | undefined {
  let general = false;
  for (const line of ini.split(/\r?\n/)) {
    if (line.startsWith("[")) general = line.trim() === "[General]";
    else if (general && line.startsWith(`${key}=`)) return line.slice(key.length + 1);
  }
}

/** The INI file's text with the app logging in with this session when it starts. Settings another account left start over:
 * the WireGuard keys in them are registered with that account */
export function withSession(ini: string, { userId, authHash }: Session): string {
  if (userId && iniValue(ini, "userId") !== userId) ini = "";
  let general = false;
  const lines = ini.split("\n").filter((line) => {
    if (line.startsWith("[")) general = line.trim() === "[General]";
    return !(general && line.startsWith("authHash="));
  });
  const at = lines.findIndex((line) => line.trim() === "[General]");
  lines.splice(at + 1, 0, ...(at < 0 ? ["[General]"] : []), `authHash=${authHash}`);
  return lines.join("\n");
}

/** One of the app's top-level settings on this computer; "" when it isn't there, or doesn't look like an ID or a token */
function setting(key: string): string {
  const run = (cmd: string, args: string[]) =>
    execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  try {
    const value = process.platform === "darwin" ? run("defaults", ["read", "com.windscribe.Windscribe2", key])
      : process.platform === "win32" ? run("reg", ["query", "HKCU\\Software\\Windscribe\\Windscribe2", "/v", key]).match(/REG_SZ\s+(.*)/)?.[1]
      : iniValue(readFileSync(SETTINGS, "utf8"), key);
    return value?.trim().match(/^[\w:.+/=-]+$/)?.[0] ?? "";
  } catch {
    return ""; // no such setting, or no settings
  }
}

/** The session this computer's app is logged in with; null when its settings don't have one */
export function session(): Session | null {
  const authHash = setting("authHash");
  return authHash ? { userId: setting("userId"), authHash } : null;
}

export const isFirewallOn = (status: string) => /^Firewall state: On/m.test(status);

let firewallChanged = false; // blockInternet() turned the firewall on, so restoreFirewall() turns it back off

/** Turns on the app's firewall, so nothing goes online outside the VPN. False if it was on already (it then stays on) */
export async function blockInternet(): Promise<boolean> {
  if (!/^Firewall state: Off/m.test(await windscribe("status"))) return false;
  await windscribe("firewall", "on");
  return (firewallChanged = true);
}

/** Puts the firewall back the way the user had it; safe to call any time, also on a crash so the internet isn't left blocked */
export async function restoreFirewall(): Promise<void> {
  if (firewallChanged) await windscribe("firewall", "off");
}

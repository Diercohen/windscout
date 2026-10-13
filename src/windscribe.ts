// The Windscribe desktop app, driven through the windscribe-cli it ships with.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
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

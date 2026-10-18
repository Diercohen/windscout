#!/usr/bin/env node
// WindScout: find which Windscribe locations and protocols actually work from here.
// Drives the official windscribe-cli: connects to each datacenter/protocol pair,
// measures latency and download speed through the tunnel, prints a ranked table.
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { CONFIG, DEFAULT_TIMEOUT, loadConfig, MIN_TIMEOUT } from "./config.js";
import type { Result } from "./probe.js";
import { loadLocations } from "./locations.js";
import { Scan } from "./scan.js";
import { pick } from "./tui/picker.js";
import { logProgress, showProgress } from "./tui/progress.js";
import { command, report, target } from "./tui/report.js";
import { leaveScreen, out } from "./tui/terminal.js";
import { cyan, green, yellow } from "./tui/text.js";
import { now, sleep } from "./time.js";
import { canUpdate, checkUpdate, runUpdate, updateNotice, versionLines } from "./update.js";
import { blockInternet, CLI, connectState, isFirewallOn, PROTOCOLS, restoreFirewall, waitForLogin, windscribe } from "./windscribe.js";

const HELP = `Usage: windscout [options]

Find which Windscribe locations and protocols work from your network, ranked by speed.
Without -c it opens an interactive country picker (your selection is remembered).
Each selected country tests all named datacenters unless capped with -l.

Options:
  -c, --countries LIST  comma-separated ISO codes, city names or nicknames (skips the picker)
  -p, --protocols LIST  comma-separated protocols, optional :port (default: ${PROTOCOLS.join(",")})
  -t, --timeout SEC     seconds to wait for each connection, at least ${MIN_TIMEOUT} (default: saved, or ${DEFAULT_TIMEOUT})
  -l, --limit COUNT     maximum locations per country, a positive whole number (default: all)
  -a, --all             also show failed attempts in the final table
  -n, --no-speed        connect-only: skip the download test, rank by latency (faster scan)
  -f, --firewall        block internet while scanning, except through the VPN (turned back off afterwards)
  -v, --version         show the installed version (and offer to update if a newer one is out)
  -h, --help            show this help

Selection is stored in ${CONFIG}
Example: windscout -c DE,NL,TR -p stealth,tcp:443`;

// "DE, NL,,TR" → ["DE", "NL", "TR"]
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

const ask = (question: string) => new Promise<string>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: out });
  rl.on("SIGINT", () => rl.close()); // Ctrl-C / Ctrl-D: same as enter
  rl.on("close", () => resolve(""));
  rl.question(question, (a) => (resolve(a.trim()), rl.close()));
});

/** Asks which numbered connection to make, then runs its command and waits for it to connect */
async function offerConnect(choices: Result[], timeout: number): Promise<void> {
  const others = choices.length > 1 ? `, 1-${choices.length - 1} = other` : "";
  for (;;) {
    const a = await ask(`\nconnect to # (0 = best${others}, enter to quit): `);
    if (!a) return;
    const r = /^\d+$/.test(a) ? choices[Number(a)] : undefined;
    if (!r) {
      console.log(yellow(`no #${a} in the tables`));
      continue;
    }
    console.log(cyan(command(r)));
    await windscribe("connect", target(r), r.protocol);
    let state = "";
    for (const t = now(); now() - t < timeout && !(state = await connectState()).startsWith("Connected");) await sleep(1000);
    console.log(state.startsWith("Connected") ? green(state) : yellow(`${state || "not connected"} after ${timeout} s`));
    return;
  }
}

/** u in the picker: update, then run the new version in this one's place, with the same arguments */
function updateAndRestart(): void {
  const status = runUpdate();
  if (status) {
    console.error(yellow(`update failed (exit ${status})`));
    process.exitCode = status;
    return;
  }
  console.log(green("updated · restarting windscout"));
  process.exitCode = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit" }).status ?? 1;
}

async function main(): Promise<void> {
  const { values: a } = parseArgs({
    options: {
      countries: { type: "string", short: "c" },
      protocols: { type: "string", short: "p" },
      timeout: { type: "string", short: "t" },
      limit: { type: "string", short: "l" },
      all: { type: "boolean", short: "a", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      "no-speed": { type: "boolean", short: "n", default: false },
      firewall: { type: "boolean", short: "f", default: false },
    },
  });
  if (a.help) return console.log(HELP);
  checkUpdate(); // runs while the app starts and the user picks, before the VPN starts switching
  if (a.version) {
    await checkUpdate();
    console.log(versionLines().join("\n"));
    if (canUpdate() && process.stdin.isTTY && out.isTTY && /^y(es)?$/i.test(await ask("update now? (y/n) "))) process.exitCode = runUpdate();
    return;
  }
  let timeout = a.timeout ? Number(a.timeout) : undefined;
  if (timeout !== undefined && !(timeout >= MIN_TIMEOUT)) throw new Error(`--timeout must be at least ${MIN_TIMEOUT} seconds`);
  const limit = a.limit === undefined ? undefined : Number(a.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    throw new Error("--limit must be a positive whole number");

  const status = await waitForLogin();
  const locations = await loadLocations();
  const tty = Boolean(process.stdin.isTTY && out.isTTY);
  let countries = a.countries ? list(a.countries) : undefined;
  let protocols: readonly string[] | undefined = a.protocols ? list(a.protocols) : undefined;
  let speedTest = !a["no-speed"];
  let firewall = a.firewall;
  if (!countries) {
    if (!tty) throw new Error("no terminal for the picker: pass countries with -c");
    const saved = loadConfig();
    if (protocols && saved) saved.protocols = protocols.filter((p) => PROTOCOLS.includes(p));
    const choice = await pick(saved, {
      locations,
      limit,
      timeout: timeout ?? saved?.timeout ?? DEFAULT_TIMEOUT,
      speedTest: speedTest && (saved?.speed ?? false), // first run: connect-only
      // already on in the app: show it on, since the scan won't turn it off
      firewall: firewall || isFirewallOn(status) || (saved?.firewall ?? false),
    });
    if (!choice) return;
    if (choice === "update") return updateAndRestart();
    countries = choice.countries;
    protocols ??= choice.protocols;
    speedTest = choice.speed;
    firewall = choice.firewall;
    timeout = choice.timeout;
  }
  protocols ??= PROTOCOLS;
  timeout ??= DEFAULT_TIMEOUT;

  const scan = new Scan(countries, protocols, { timeout, speedTest, locations, limit });
  const blocking = firewall && (await blockInternet());
  const view = tty ? showProgress(scan, blocking) : logProgress(scan);
  await scan.run(view);
  await restoreFirewall();
  view.close();
  if (scan.stopping) console.log(yellow("interrupted, showing partial results"));
  const choices = report(scan.results, protocols, { all: a.all, speedTest });
  await checkUpdate();
  if (updateNotice()) console.error("\n" + versionLines().join("\n"));
  if (tty && choices.length) await offerConnect(choices, timeout);
}

main().catch(async (e) => {
  leaveScreen();
  console.error(`windscout: ${e.message}`);
  await restoreFirewall().catch(() => console.error(`the firewall may still be on: run '${CLI} firewall off'`));
  process.exit(1);
});

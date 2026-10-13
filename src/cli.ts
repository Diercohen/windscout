#!/usr/bin/env node
// WindScout: find which Windscribe locations and protocols actually work from here.
// Drives the official windscribe-cli: connects to each country/protocol pair,
// measures latency and download speed through the tunnel, prints a ranked table.
import { parseArgs } from "node:util";
import { CONFIG, DEFAULT_TIMEOUT, loadConfig, MIN_TIMEOUT } from "./config.js";
import { Scan } from "./scan.js";
import { pick } from "./tui/picker.js";
import { logProgress, showProgress } from "./tui/progress.js";
import { report } from "./tui/report.js";
import { leaveScreen, out } from "./tui/terminal.js";
import { yellow } from "./tui/text.js";
import { checkUpdate, updateNotice, VERSION } from "./update.js";
import { blockInternet, CLI, isFirewallOn, PROTOCOLS, restoreFirewall, waitForLogin } from "./windscribe.js";

const HELP = `Usage: windscout [options]

Find which Windscribe locations and protocols work from your network, ranked by speed.
Without -c it opens an interactive country picker (your selection is remembered).

Options:
  -c, --countries LIST  comma-separated ISO codes, city names or nicknames (skips the picker)
  -p, --protocols LIST  comma-separated protocols, optional :port (default: ${PROTOCOLS.join(",")})
  -t, --timeout SEC     seconds to wait for each connection, at least ${MIN_TIMEOUT} (default: saved, or ${DEFAULT_TIMEOUT})
  -a, --all             also show failed attempts in the final table
  -n, --no-speed        connect-only: skip the download test, rank by latency (faster scan)
  -f, --firewall        block internet while scanning, except through the VPN (turned back off afterwards)
  -v, --version         show the installed version (and whether a newer one is out)
  -h, --help            show this help

Selection is stored in ${CONFIG}
Example: windscout -c DE,NL,TR -p stealth,tcp:443`;

// "DE, NL,,TR" → ["DE", "NL", "TR"]
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

async function main(): Promise<void> {
  const { values: a } = parseArgs({
    options: {
      countries: { type: "string", short: "c" },
      protocols: { type: "string", short: "p" },
      timeout: { type: "string", short: "t" },
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
    console.log(`windscout ${VERSION}`);
    await checkUpdate();
    const notice = updateNotice();
    if (notice) console.error(yellow(notice));
    return;
  }
  let timeout = a.timeout ? Number(a.timeout) : undefined;
  if (timeout !== undefined && !(timeout >= MIN_TIMEOUT)) throw new Error(`--timeout must be at least ${MIN_TIMEOUT} seconds`);

  const status = await waitForLogin();
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
      timeout: timeout ?? saved?.timeout ?? DEFAULT_TIMEOUT,
      speedTest: speedTest && (saved?.speed ?? false), // first run: connect-only
      // already on in the app: show it on, since the scan won't turn it off
      firewall: firewall || isFirewallOn(status) || (saved?.firewall ?? false),
    });
    if (!choice) return;
    countries = choice.countries;
    protocols ??= choice.protocols;
    speedTest = choice.speed;
    firewall = choice.firewall;
    timeout = choice.timeout;
  }
  protocols ??= PROTOCOLS;
  timeout ??= DEFAULT_TIMEOUT;

  const scan = new Scan(countries, protocols, { timeout, speedTest });
  const blocking = firewall && (await blockInternet());
  const view = tty ? showProgress(scan, blocking) : logProgress(scan);
  await scan.run(view);
  await restoreFirewall();
  view.close();
  if (scan.stopping) console.log(yellow("interrupted, showing partial results"));
  report(scan.results, protocols, { all: a.all, speedTest });
  await checkUpdate();
  const notice = updateNotice();
  if (notice) console.error("\n" + yellow(notice));
}

main().catch(async (e) => {
  leaveScreen();
  console.error(`windscout: ${e.message}`);
  await restoreFirewall().catch(() => console.error(`the firewall may still be on: run '${CLI} firewall off'`));
  process.exit(1);
});

#!/usr/bin/env node
// WindScout: find which Windscribe locations and protocols actually work from here.
// Drives the official windscribe-cli: connects to each country/protocol pair,
// measures latency and download speed through the tunnel, prints a ranked table.
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { CONFIG, DEFAULT_TIMEOUT, forgetLogin, LAST_FILE, loadConfig, loadDockerWireGuard, loadLast, MIN_TIMEOUT, saveDockerWireGuard, saveLast, SPEED_TEST } from "./config.js";
import { notInContainers, stopWorkers } from "./docker.js";
import { attempt, disconnect, MIN_MBPS, probe, type Result } from "./probe.js";
import { ORDERS, plan, Scan, type Order } from "./scan.js";
import { startParallel } from "./tui/docker.js";
import { pick } from "./tui/picker.js";
import { logProgress, showProgress } from "./tui/progress.js";
import { command, report, target } from "./tui/report.js";
import { leaveScreen, out } from "./tui/terminal.js";
import { cyan, green, yellow } from "./tui/text.js";
import { duration, now } from "./time.js";
import { canUpdate, checkUpdate, runUpdate, updateNotice, versionLines } from "./update.js";
import { blockInternet, CLI, isFirewallOn, protocolPorts, PROTOCOLS, restoreFirewall, waitForLogin, windscribe, withPorts } from "./windscribe.js";
import { worker } from "./worker.js";

const HELP = `Usage: windscout [options]
       windscout connect [-t SEC]

Find which Windscribe locations and protocols work from your network, ranked by ${SPEED_TEST ? "speed" : "latency"}.
Without -c it opens an interactive country picker (your selection is remembered).
Each scan's working connections are saved: the scanning type (-o, or o in the picker) can try
them first or only them, and windscout connect connects to the best of them that still works.

Options:
  -c, --countries LIST  comma-separated ISO codes, city names or nicknames (skips the picker)
  -p, --protocols LIST  comma-separated protocols, optional :port (default: ${PROTOCOLS.join(",")})
  -P, --all-ports       try each protocol on every port Windscribe offers for it, not just its default
  -t, --timeout SEC     seconds to wait for each connection, at least ${MIN_TIMEOUT} (default: saved, or ${DEFAULT_TIMEOUT})
  -a, --all             also show failed attempts in the final table
${SPEED_TEST ? "  -n, --no-speed        connect-only: skip the download test, rank by latency (faster scan)\n" : ""}  -f, --firewall        block internet while scanning, except through the VPN (turned back off afterwards)
  -o, --order TYPE      scanning type: default (list order), random (countries shuffled), last-first (the last
                        result's working connections among them first, then the rest) or last-only (only those,
                        whatever -c and -p say; needs no -c)
  -w, --stop-at-first   stop at the first working connection that holds up: a speed test (even with -n) of at least
                        ${MIN_MBPS} Mbps, then about 10 more seconds connected, with internet through it
  -d, --docker          scan in parallel, in docker containers (one per attempt, up to 16, as docker's CPUs and memory allow)
  -v, --version         show the installed version (and offer to update if a newer one is out)
  -h, --help            show this help

Selection is stored in ${CONFIG}, the last result in ${LAST_FILE}
Examples: windscout -c DE,NL,TR -p stealth,tcp:443
          windscout -c DE -p stealth,tcp -P
          windscout connect`;

// "DE, NL,,TR" → ["DE", "NL", "TR"]
const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** The typed answer; one of instant is taken as soon as it's the whole answer, without enter */
const ask = (question: string, instant: string[] = []) => new Promise<string | null>((resolve) => {
  const rl = createInterface({ input: process.stdin, output: out });
  // runs after readline's own keypress listener, so rl.line has the key in it
  const onKey = () => instant.includes(rl.line.toLowerCase()) && (out.write("\n"), resolve(rl.line), rl.close());
  process.stdin.on("keypress", onKey);
  rl.on("SIGINT", () => rl.close()); // Ctrl-C / Ctrl-D: no answer, null
  rl.on("close", () => (process.stdin.off("keypress", onKey), resolve(null)));
  rl.question(question, (a) => (resolve(a.trim()), rl.close()));
});

/** Runs a result's connect command and checks it as the scan does: connected, on its port, with internet through it.
 * True once it is; otherwise disconnects (and waits until the app has), so the next connect isn't swallowed */
async function connectTo(r: Result, timeout: number): Promise<boolean> {
  console.log(cyan(command(r)));
  const t = now(), { status, location } = await attempt(target(r), r.protocol, { timeout, speedTest: false });
  if (status === "ok") return console.log(green(`Connected: ${location}`)), true;
  console.log(yellow(`${status} after ${duration(now() - t)}`));
  await disconnect();
  return false;
}

/** Asks which numbered connection to make (enter: the best), then runs its command and waits for it to connect.
 * 0 and q need no enter; the other numbers do, since 1 may be the start of 10 */
async function offerConnect(choices: Result[], timeout: number): Promise<void> {
  const others = choices.length > 2 ? `, 1-${choices.length - 1} = other` : choices.length > 1 ? ", 1 = other" : "";
  for (;;) {
    const a = await ask(`\nconnect to # (enter or 0 = best${others}, q = quit): `, ["0", "q"]);
    if (a === null || /^q(uit)?$/i.test(a)) return;
    const r = a === "" ? choices[0] : /^\d+$/.test(a) ? choices[Number(a)] : undefined;
    if (!r) {
      console.log(yellow(`no #${a} in the tables`));
      continue;
    }
    await connectTo(r, timeout);
    return;
  }
}

const RESCAN_HINT = "rescan them with windscout -o last-only, or start a new scan";

/** windscout connect: the last result's connections, best first, until one connects */
async function connectLast(timeout: number): Promise<void> {
  const last = loadLast();
  if (!last) {
    console.log(yellow("no saved scan yet: run windscout to scan first"));
    process.exitCode = 1;
    return;
  }
  await waitForLogin();
  await disconnect(); // a connection already up would read as the first one connecting
  for (const [i, r] of last.results.entries()) {
    console.log(`\n${i + 1}/${last.results.length} ${r.location || r.query} over ${r.protocol}`);
    if (await connectTo(r, timeout)) return;
  }
  console.log(yellow(`\nnone of the last result's ${last.results.length} connection${last.results.length === 1 ? "" : "s"} works now: ${RESCAN_HINT}`));
  process.exitCode = 1;
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
  const { values: a, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      countries: { type: "string", short: "c" },
      protocols: { type: "string", short: "p" },
      "all-ports": { type: "boolean", short: "P", default: false },
      timeout: { type: "string", short: "t" },
      all: { type: "boolean", short: "a", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
      "no-speed": { type: "boolean", short: "n", default: false },
      firewall: { type: "boolean", short: "f", default: false },
      order: { type: "string", short: "o" },
      "stop-at-first": { type: "boolean", short: "w", default: false },
      random: { type: "boolean", short: "r", default: false }, // from before scanning types: -o random
      docker: { type: "boolean", short: "d", default: false },
      worker: { type: "boolean", default: false }, // in a parallel scan's container
    },
  });
  if (a.worker) {
    await worker();
    process.exit(); // its stdin may still be open: its app didn't log in
  }
  forgetLogin();
  if (a.help) return console.log(HELP);
  const [subcommand, ...extra] = positionals;
  if (subcommand !== undefined && (subcommand !== "connect" || extra.length)) throw new Error(`unknown command '${positionals.join(" ")}': see --help`);
  if (subcommand === "connect" && Object.entries(a).some(([k, v]) => k !== "timeout" && v)) throw new Error("windscout connect takes only -t: see --help");
  checkUpdate(); // runs while the app starts and the user picks, before the VPN starts switching
  if (a.version) {
    await checkUpdate();
    console.log(versionLines().join("\n"));
    if (canUpdate() && process.stdin.isTTY && out.isTTY && /^y(es)?$/i.test((await ask("update now? (y/n) ")) ?? "")) process.exitCode = runUpdate();
    return;
  }
  let timeout = a.timeout ? Number(a.timeout) : undefined;
  if (timeout !== undefined && !(timeout >= MIN_TIMEOUT)) throw new Error(`--timeout must be at least ${MIN_TIMEOUT} seconds`);
  if (a.order !== undefined && !ORDERS.includes(a.order as Order)) throw new Error(`--order must be one of: ${ORDERS.join(", ")}`);
  if (subcommand === "connect") return connectLast(timeout ?? loadConfig()?.timeout ?? DEFAULT_TIMEOUT);

  const status = await waitForLogin();
  const tty = Boolean(process.stdin.isTTY && out.isTTY);
  let countries = a.countries ? list(a.countries) : undefined;
  let protocols: readonly string[] | undefined = a.protocols ? list(a.protocols) : undefined;
  let speedTest = SPEED_TEST && !a["no-speed"];
  let firewall = a.firewall;
  let order = (a.order ?? (a.random ? "random" : undefined)) as Order | undefined;
  let stopAtFirst = a["stop-at-first"];
  let allPorts = a["all-ports"];
  let docker = a.docker;
  const last = loadLast();
  // only the last results needs no countries: without a terminal, it goes without the picker
  if (!countries && !(order === "last-only" && !tty)) {
    if (!tty) throw new Error("no terminal for the picker: pass countries with -c");
    const saved = loadConfig();
    if (protocols && saved) saved.protocols = protocols.filter((p) => PROTOCOLS.includes(p));
    const choice = await pick(saved, {
      timeout: timeout ?? saved?.timeout ?? DEFAULT_TIMEOUT,
      speedTest: speedTest && (saved?.speed ?? false), // first run: connect-only
      // already on in the app: show it on, since the scan won't turn it off
      firewall: firewall || isFirewallOn(status) || (saved?.firewall ?? false),
      order: order ?? saved?.order ?? "default",
      stopAtFirst: stopAtFirst || (saved?.stopAtFirst ?? false),
      allPorts: allPorts || (saved?.allPorts ?? false),
      docker: docker || (saved?.docker ?? false),
      last,
    });
    if (!choice) return;
    if (choice === "update") return updateAndRestart();
    countries = choice.countries;
    protocols ??= choice.protocols;
    speedTest = choice.speed;
    firewall = choice.firewall;
    order = choice.order;
    stopAtFirst = choice.stopAtFirst;
    allPorts = choice.allPorts;
    timeout = choice.timeout;
    docker = choice.docker;
  }
  countries ??= [];
  protocols ??= PROTOCOLS;
  timeout ??= DEFAULT_TIMEOUT;
  order ??= "default";
  const byLast = order === "last-first" || order === "last-only"; // a type by the last result: it needs a saved scan
  if (byLast && !last) throw new Error(`no saved scan yet: -o ${order} needs one, so run a scan with another scanning type first`);
  const fromLast = byLast ? last : null; // the saved connections this scan uses
  // the picker asked for the ports already: waiting for that keeps windscribe-cli free for the scan.
  // The saved connections need them too, to tell a saved "tcp:443" from tcp on its default port
  const lists = allPorts || !a.countries || fromLast ? await protocolPorts() : undefined;
  if (allPorts && lists) protocols = withPorts(protocols, lists);
  const attempts = plan(order, countries, protocols, fromLast?.results, lists);
  // the tables' columns: the protocols asked for, and the saved connections' own (only those, when only they are scanned)
  const scanned = [...new Set([...(order === "last-only" ? [] : protocols), ...attempts.map((x) => x.protocol)])];

  // a parallel scan is the containers' alone: the protocols they can't run (IKEv2, WireGuard on some kernels) aren't tried
  let probers = [probe], skipped = new Set<string>();
  const inContainers = () => attempts.filter((x) => !skipped.has(x.protocol));
  const nothingLeft = () => new Error(`the docker containers can't run ${[...skipped].join(" or ")}, and nothing else is selected:`
    + " scan without --docker (d in the picker)");
  if (docker && attempts.length) {
    skipped = notInContainers(scanned, loadDockerWireGuard()); // as far as the last parallel scan knows
    if (!inContainers().length) throw nothingLeft();
    const started = await startParallel(inContainers().length);
    if (!started) return leaveScreen();
    saveDockerWireGuard(started.wireguard);
    probers = started.probers;
    skipped = notInContainers(scanned, started.wireguard); // their kernel may not run WireGuard after all, or may now
    if (!inContainers().length) {
      await stopWorkers();
      throw nothingLeft();
    }
    await windscribe("disconnect"); // a VPN connection here would carry the containers' traffic too
  }
  const scan = new Scan(countries, scanned.filter((p) => !skipped.has(p)), { timeout, speedTest, only: inContainers(), stopAtFirst }, probers);
  // not with containers: their traffic goes out through this computer, and the firewall would block it
  const blocking = firewall && !docker && (await blockInternet());
  const view = tty ? showProgress(scan, blocking) : logProgress(scan);
  await scan.run(view);
  if (docker) await stopWorkers();
  await restoreFirewall();
  view.close();
  for (const e of new Set(scan.errors)) console.error(yellow(e));
  if (skipped.size) console.error(yellow(`not tried: ${[...skipped].join(", ")}, which the docker containers can't run (a scan without --docker can)`));
  if (scan.found) console.log(green("stopped at the first connection that held up (a speed test, then staying up)"));
  else if (scan.stopping) console.log(yellow("interrupted, showing partial results"));
  const choices = report(scan.results, scan.protocols, { all: a.all, speedTest: speedTest || stopAtFirst }); // stop at the first measures speed
  // its working connections replace the saved ones it tried, so what stopped working drops out; the saved ones it didn't try
  // (other countries, or what a stopped scan didn't get to) stay, after its own; a scan where nothing worked keeps the last
  const tried = new Set(scan.results.filter((r) => r.status !== "interrupted").map((r) => `${r.query} ${r.protocol}`));
  saveLast(choices, undefined, tried);
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

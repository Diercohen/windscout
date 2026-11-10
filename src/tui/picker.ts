// Screen 1: pick countries, protocols, all ports, speed test, firewall, timeout, docker, the scanning type and stop at the
// first working connection, by keyboard or mouse.
import type { Key } from "node:readline";
import { loadDockerWireGuard, MIN_TIMEOUT, saveConfig, SPEED_TEST, type Choice, type Last } from "../config.js";
import { dockerState, loginSeconds, notInContainers, workerCount, type DockerState } from "../docker.js";
import { STEADY_SECONDS } from "../probe.js";
import { attemptSeconds, estimate, ORDERS, plan, type Order } from "../scan.js";
import { duration } from "../time.js";
import { canUpdate, checkUpdate, versionLines } from "../update.js";
import { COUNTRIES, protocolPorts, PROTOCOLS, withPorts } from "../windscribe.js";
import { countryName, flag } from "./country.js";
import { setupDocker } from "./docker.js";
import { draw, drawUntilNext, enterScreen, input, leaveScreen, out, repoLink, type Mouse } from "./terminal.js";
import { bold, cyan, dim, green, under, vw, yellow } from "./text.js";
import { box, centerIn, grid, spin } from "./widgets.js";

export interface PickerOptions {
  timeout: number; // initial state of the settings
  speedTest: boolean;
  firewall: boolean;
  order: Order;
  stopAtFirst: boolean;
  allPorts: boolean;
  docker: boolean;
  last: Last | null; // the last scan's working connections, for the scanning types that use them
}

type Button = "start" | "all" | "none" | "quit";

// where things landed on screen in the last render, for mouse clicks
interface Hits {
  protoRow: number;
  protoHits: [number, number][]; // [from, to) columns of each protocol
  portsRow: number;
  speedRow: number;
  firewallRow: number;
  timeoutRow: number;
  dockerRow: number;
  orderRow: number;
  stopRow: number;
  searchRow: number;
  firstRow: number; // first country row
  shown: number; // country rows on screen
  buttonRow: number;
  buttonHits: [Button, number, number][];
}

const ORDER_NAMES: Record<Order, string> = {
  default: "default",
  random: "by random country",
  "last-first": "by last success result first",
  "last-only": "only the last results",
};
const needsLast = (o: Order) => o === "last-first" || o === "last-only";
// only the last results: the countries, protocols and ports are greyed out, and their keys and clicks say why
const SKIPPED = "skipped with only the last results: o changes the scanning type";

const flip = <T>(set: Set<T>, value: T) => (set.has(value) ? set.delete(value) : set.add(value));

// "5m ago", "3h ago", "2 days ago"
const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000)), h = Math.round(m / 60), d = Math.round(h / 24);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : h < 48 ? `${h}h ago` : `${d} days ago`;
};

/** Resolves to the choice (also saved for next time), null when the user quits, or "update" for u */
export function pick(saved: Choice | null, { timeout, speedTest, firewall, order, stopAtFirst, allPorts, docker, last }: PickerOptions): Promise<Choice | null | "update"> {
  const selected = new Set(saved?.countries ?? []);
  const protos = new Set(saved?.protocols.length ? saved.protocols : PROTOCOLS);
  let cursor = 0, top = 0, message = "", query = "", searching = false;
  let seconds = String(timeout), editing = false; // the timeout, as typed
  let dockerAt: DockerState | null = null, inDialog = false; // docker's state once checked; a docker dialog has the screen
  let portLists: ReadonlyMap<string, number[]> | null = null; // each protocol's ports, once the app said
  let starting = -1; // once start is pressed: the start button's spinner frame, until the next screen shows
  let hit: Hits;
  const visible = () => {
    const q = query.toLowerCase();
    return q ? COUNTRIES.filter((c) => c.toLowerCase().includes(q) || countryName(c).toLowerCase().includes(q)) : COUNTRIES;
  };
  const ports = (p: string) => (allPorts && portLists?.get(p)?.length) || 1; // attempts per country for the protocol
  const perCountry = (ps: Iterable<string>) => [...ps].reduce((n, p) => n + ports(p), 0);
  // what start scans, in its order: as the CLI plans it, so the estimate counts the same attempts
  const todo = () => {
    const ps = PROTOCOLS.filter((p) => protos.has(p));
    return plan(order, COUNTRIES.filter((c) => selected.has(c)), allPorts && portLists ? withPorts(ps, portLists) : ps, last?.results, portLists ?? undefined);
  };
  const wireguard = loadDockerWireGuard(); // in docker containers, as the last parallel scan found
  enterScreen();

  return new Promise((resolve) => {
    const render = () => {
      if (inDialog) return;
      const rows = out.rows || 24;
      const version = versionLines(true);
      const matches = visible();
      const height = Math.max(3, rows - 24 - version.length);
      cursor = Math.max(0, Math.min(cursor, matches.length - 1));
      if (cursor < top) top = cursor;
      if (cursor >= top + height) top = cursor - height + 1;
      top = Math.max(0, Math.min(top, matches.length - height));

      const off = order === "last-only"; // only the saved connections: the countries, protocols and ports are skipped
      const missing = needsLast(order) && !last; // a type by the last result, and no saved scan: start is off
      timeout = Number(seconds);
      const list = todo(), n = list.length;
      const base = (p: string) => p.split(":")[0]; // "wireguard:443" → "wireguard"
      const scanned = new Set(list.map((a) => base(a.protocol)));
      const here = PROTOCOLS.filter((p) => docker && scanned.has(p) && notInContainers(PROTOCOLS, wireguard).has(p)); // after the containers
      const inContainers = list.filter((a) => !here.includes(base(a.protocol))).length;
      const parallel = docker && dockerAt === "ready" && inContainers > 0;
      const slots = parallel ? workerCount(inContainers) : 1;
      const login = parallel ? loginSeconds(slots) : 0; // the containers log in before the scan starts

      const protoLine = PROTOCOLS.map((p, i) =>
        `${dim(under(String(i + 1)))} ${protos.has(p) ? (off ? dim : green)("● " + p) : dim("○ " + p)}`).join("   ");
      const listed = portLists && [...portLists.values()].some((l) => l.length), each = perCountry(protos);
      const portsLine = `${dim(under("p"))} ${allPorts ? (off ? dim : green)("● all ports") : dim("○ all ports")}  ${dim(off
        ? "not used: each saved connection on its own protocol and port"
        : !allPorts
        ? "off: each protocol on its default port"
        : !portLists ? "checking the ports…"
        : !listed ? "this Windscribe app can't list its ports: 2.22 and newer can"
        : `every port of each protocol: ${each} attempt${each === 1 ? "" : "s"} per country${each > protos.size ? `, not ${protos.size}` : ""}`)}`;
      const speedLine = `${dim(under("s"))} ${speedTest ? green("● speed test") : dim("○ speed test")}  ${dim(speedTest
        ? "ranks by download speed · adds ~15s per working connection"
        : stopAtFirst ? "off · stop at the first still runs it on each connection"
        : "off: connect-only, ranks by latency")}`;
      const fwLabel = "block internet while scanning (firewall)";
      const fwLine = `${dim(under("f"))} ${firewall ? green("● " + fwLabel) : dim("○ " + fwLabel)}  ${dim(docker
        ? "not used with docker"
        : firewall ? "only VPN traffic gets through" : "off: apps may leak in between")}`;
      const short = timeout < MIN_TIMEOUT;
      const timeoutLine = `${dim(under("t"))} timeout ${editing ? bold(seconds) + cyan("▏") : (short ? yellow : bold)(seconds || "?")} s  ${dim(`per connection · at least ${MIN_TIMEOUT}`)}`;
      const dockerLabel = "parallel scan in docker containers";
      const dockerLine = `${dim(under("d"))} ${docker ? green("● " + dockerLabel) : dim("○ " + dockerLabel)}  ${dim(!docker
        ? "off: one attempt at a time"
        : dockerAt === "ready" ? `${slots} at a time${here.length ? ` · ${here.join(" and ")} here, after them` : ""}`
        : dockerAt ? "docker isn't ready: start sets it up" : "checking docker…")}`;
      const saves = last ? plan("last-only", [], [], last.results, portLists ?? undefined).length : 0; // the saved connections, each once
      const firsts = list.filter((a) => a.saved).length; // those this scan tries first
      const orderLine = `${dim(under("o"))} scanning type ${bold(ORDER_NAMES[order])}  ${dim(missing
        ? "no saved scan yet"
        : order === "default" ? "countries in list order"
        : order === "random" ? "countries shuffled, a new order each run"
        : order === "last-first" ? `${firsts} of ${saves} saved selected · ${ago(last!.at)}`
        : `${saves} saved working connection${saves === 1 ? "" : "s"} · ${ago(last!.at)}`)}`;
      const stopLabel = "stop at the first working connection";
      // the best saved connection goes first (unless it waits for the containers): when it still holds up, the scan ends there
      const lead = list[0]?.saved && !here.includes(base(list[0].protocol)) ? list[0] : null;
      const stopLine = `${dim(under("w"))} ${stopAtFirst ? green("● " + stopLabel) : dim("○ " + stopLabel)}  ${dim(!stopAtFirst
        ? "off: tries every attempt"
        : lead ? `≈ ${duration(login + STEADY_SECONDS)} if ${lead.country} ${lead.protocol} still holds up`
        : "after a speed and stability check")}`;
      const search = off
        ? yellow("countries skipped: only the last results are scanned")
        : searching ? `${cyan("🔍")} ${bold(query)}${cyan("▏")}`
        : query ? `🔍 ${query}` : dim("🔍 press / to search");
      const shown = matches.slice(top, top + height);
      const range = matches.length > height ? `${top + 1}–${top + shown.length} of ${matches.length}` : `${matches.length} countries`;
      const body = shown.map((code, j) => {
        const current = !off && top + j === cursor;
        const mark = selected.has(code) ? (off ? dim : green)("●") : dim("○");
        const name = `${flag(code)} ${countryName(code)}`;
        return [`${current ? cyan("❯") : " "} ${mark}`, current ? bold(code) : dim(code), current ? bold(cyan(name)) : off ? dim(name) : name];
      });
      if (!body.length) body.push(["   ", "", dim("no country matches")]);
      const buttons: [Button, string][] = [
        ["start", starting < 0 ? "▶ Start" : `${spin(starting++)} Starting…`],
        ["all", under("A") + (query ? "ll shown" : "ll")],
        ["none", under("N") + (query ? "one shown" : "one")],
        ["quit", under("Q") + "uit"],
      ];
      const buttonLine = buttons.map(([id, label]) => (id === "start" && n && !missing ? bold(cyan(`[ ${label} ]`)) : dim(`[ ${label} ]`))).join("  ");

      const settings = [protoLine, portsLine, ...(SPEED_TEST ? [speedLine] : []), fwLine, timeoutLine, dockerLine, orderLine, stopLine];
      const table = grid([{ title: "" }, { title: "Code" }, { title: "Country" }], body,
        { caption: search, captionRight: dim(range), minWidth: Math.max(...settings.map(vw)) + 4 });
      const width = vw(table[0]);
      const head = box(settings, {
        title: bold(cyan("WindScout")),
        right: `${(off ? dim : bold)(String(selected.size))}${dim(`/${COUNTRIES.length} selected`)}`,
        width: width - 4,
      });
      const total = login + estimate(inContainers, timeout, slots) + estimate(n - inContainers, timeout);
      const costs = dim(`(~${attemptSeconds(timeout)}s each${slots > 1 ? `, ${slots} at a time` : ""}${login ? `, + ~${duration(login)} login` : ""})`);
      const lines = [
        ...head,
        ...table,
        "",
        centerIn(buttonLine, width),
        "",
        centerIn(missing
          ? yellow("no saved scan yet, so start is off: press o for another scanning type")
          : !n ? yellow(`select at least one country and one protocol${last ? ", or o for only the last results" : ""}`)
          : stopAtFirst // it can end at any attempt: this is when none holds up
          ? `up to ${bold(String(n))} attempts · at most ${bold("≈ " + duration(total))} ${costs}`
          : `${bold(String(n))} attempts · estimated ${bold("≈ " + duration(total))} ${costs}`, width),
        centerIn(dim(editing
          ? "type the seconds to wait for each connection · enter/esc done"
          : searching
          ? "type to filter · ↑↓ move · enter/esc done"
          : `↑↓ move · space select · a/n ${query ? "all/none shown · esc clear" : "all/none · / search"} · enter start · q quit`), width),
        centerIn(dim(searching || editing ? "" : `1-${PROTOCOLS.length} protocols · p ports${SPEED_TEST ? " · s speed" : ""} · f firewall · t timeout · d docker · o type · w first`), width),
      ];
      if (message) lines.push(centerIn(yellow(message), width));
      lines.push("", ...version.map((l) => centerIn(l, width)), centerIn(dim(repoLink), width));
      const at = draw(lines);

      // click map, in screen coordinates
      const row = (line: string) => at.top + 1 + settings.indexOf(line); // a settings line, under the box's top border
      let px = at.left + 2; // "│ " before the protocol line
      const protoHits = PROTOCOLS.map((p, i) => {
        const len = vw(`${i + 1} ● ${p}`);
        const range: [number, number] = [px, px + len];
        px += len + 3;
        return range;
      });
      let bx = at.left + Math.floor((width - vw(buttonLine)) / 2);
      const buttonHits = buttons.map(([id, label]) => {
        const len = vw(`[ ${label} ]`);
        const range: [Button, number, number] = [id, bx, bx + len];
        bx += len + 2;
        return range;
      });
      hit = {
        protoRow: row(protoLine), protoHits, portsRow: row(portsLine), speedRow: SPEED_TEST ? row(speedLine) : -1,
        firewallRow: row(fwLine), timeoutRow: row(timeoutLine), dockerRow: row(dockerLine), orderRow: row(orderLine), stopRow: row(stopLine),
        searchRow: at.top + head.length + 1,
        firstRow: at.top + head.length + 5, shown: shown.length,
        buttonRow: at.top + head.length + table.length + 1, buttonHits,
      };
    };

    let closed = false;
    checkUpdate().then(() => !closed && render()); // the check usually lands after the first draw
    if (docker) dockerState().then((s) => ((dockerAt = s), !closed && render()));
    protocolPorts().then((l) => ((portLists = l), !closed && render()));
    const finish = (value: Choice | null | "update") => {
      closed = true;
      out.off("resize", render);
      input.removeAllListeners("keypress");
      input.removeAllListeners("mouse");
      if (!value || value === "update") leaveScreen();
      resolve(value);
    };

    const start = (): boolean => {
      if (needsLast(order) && !last) return false; // start is off: the warning under the table says why
      if (!todo().length) {
        message = "nothing to scan yet";
        return false;
      }
      if (!(timeout >= MIN_TIMEOUT)) {
        message = `the timeout must be at least ${MIN_TIMEOUT} seconds`;
        return false;
      }
      // keep the user's order of preference stable: list order
      const choice: Choice = {
        countries: COUNTRIES.filter((c) => selected.has(c)),
        protocols: PROTOCOLS.filter((p) => protos.has(p)),
        speed: speedTest,
        firewall,
        order,
        stopAtFirst,
        allPorts,
        timeout,
        docker,
      };
      saveConfig(choice);
      finish(choice);
      // the scan can take a moment to show (the firewall, docker): the button spins until its screen, or a docker one, draws
      starting = 0;
      drawUntilNext(render);
      return true;
    };

    const cycleOrder = () => (order = ORDERS[(ORDERS.indexOf(order) + 1) % ORDERS.length]); // o: the next scanning type

    // turning it on gets docker going first: installs or starts it (after asking), unless it answers already
    const toggleDocker = async () => {
      if (!docker && (dockerAt = await dockerState()) !== "ready") {
        inDialog = true;
        input.off("keypress", onKey);
        input.off("mouse", onMouse);
        const ok = await setupDocker();
        input.on("keypress", onKey);
        input.on("mouse", onMouse);
        inDialog = false;
        dockerAt = await dockerState();
        if (!ok) return render();
      }
      docker = !docker;
      render();
    };

    const onMouse = (m: Mouse) => {
      if (!m.press) return;
      message = "";
      const matches = visible(), off = order === "last-only";
      const { x, y } = m;
      const button = y === hit.buttonRow ? hit.buttonHits.find(([, a, b]) => x >= a && x < b)?.[0] : undefined;
      const onCountries = y === hit.searchRow || (y >= hit.firstRow && y < hit.firstRow + hit.shown) || button === "all" || button === "none";
      if (off && (m.button === 64 || m.button === 65)) return; // the skipped countries don't scroll
      if (m.button === 64) cursor = Math.max(0, cursor - 3); // wheel up
      else if (m.button === 65) cursor = Math.min(matches.length - 1, cursor + 3); // wheel down
      else if (m.button !== 0) return; // left button only
      else if (off && (onCountries || y === hit.protoRow || y === hit.portsRow)) message = SKIPPED;
      else if (y === hit.searchRow) searching = true, editing = false;
      else if (y === hit.timeoutRow) editing = true, searching = false;
      else {
        searching = editing = false; // clicking anywhere else ends typing, like leaving a text field
        if (y >= hit.firstRow && y < hit.firstRow + hit.shown) {
          cursor = top + (y - hit.firstRow);
          const c = matches[cursor];
          if (c) flip(selected, c);
        } else if (y === hit.protoRow) {
          const i = hit.protoHits.findIndex(([a, b]) => x >= a && x < b);
          if (i >= 0) flip(protos, PROTOCOLS[i]);
        } else if (y === hit.portsRow) allPorts = !allPorts;
        else if (y === hit.speedRow) speedTest = !speedTest;
        else if (y === hit.firewallRow) firewall = !firewall;
        else if (y === hit.dockerRow) return void toggleDocker();
        else if (y === hit.orderRow) cycleOrder();
        else if (y === hit.stopRow) stopAtFirst = !stopAtFirst;
        else if (y === hit.buttonRow) {
          if (button === "start" && start()) return;
          if (button === "quit") return finish(null);
          if (button === "all") matches.forEach((c) => selected.add(c));
          if (button === "none") matches.forEach((c) => selected.delete(c));
        }
      }
      render();
    };
    input.on("mouse", onMouse);

    out.on("resize", render);
    const onKey = (str: string | undefined, key: Key = {}) => {
      message = "";
      const k = key.name;
      const matches = visible();
      const toggle = () => {
        const c = matches[cursor];
        if (!c) return;
        flip(selected, c);
        cursor = Math.min(matches.length - 1, cursor + 1);
      };
      // only the last results: the keys for the countries, protocols and ports change nothing
      const skipped = order === "last-only" && !editing && !searching
        && (["up", "down", "pageup", "pagedown", "home", "end", "j", "k", "space", "a", "n", "p"].includes(k ?? "") || str === "/" || /^[1-9]$/.test(str ?? ""));

      if (key.ctrl && k === "c") return finish(null);
      if (skipped) message = SKIPPED;
      else if (k === "up") cursor = Math.max(0, cursor - 1);
      else if (k === "down") cursor = Math.min(matches.length - 1, cursor + 1);
      else if (k === "pageup") cursor = Math.max(0, cursor - 10);
      else if (k === "pagedown") cursor = Math.min(matches.length - 1, cursor + 10);
      else if (editing) {
        if (k === "return" || k === "escape") editing = false;
        else if (k === "backspace") seconds = seconds.slice(0, -1);
        else if (/^[0-9]$/.test(str ?? "") && seconds.length < 4) seconds = seconds === "0" ? str! : seconds + str;
      } else if (searching) {
        // typing goes into the search box; letters are not shortcuts here
        if (k === "return" || k === "escape") searching = false;
        else if (k === "backspace") query = query.slice(0, -1), cursor = 0;
        else if (k === "space" && !query) toggle();
        else if (str && !key.ctrl && !key.meta && str >= " ") query += str, cursor = 0;
      } else if (k === "home") cursor = 0;
      else if (k === "end") cursor = matches.length - 1;
      else if (k === "k") cursor = Math.max(0, cursor - 1);
      else if (k === "j") cursor = Math.min(matches.length - 1, cursor + 1);
      else if (str === "/") searching = true;
      else if (k === "space") toggle();
      else if (k === "a") matches.forEach((c) => selected.add(c));
      else if (k === "n") matches.forEach((c) => selected.delete(c));
      else if (k === "p") allPorts = !allPorts;
      else if (k === "s" && SPEED_TEST) speedTest = !speedTest;
      else if (k === "f") firewall = !firewall;
      else if (k === "t") editing = true, seconds = "";
      else if (k === "d") return void toggleDocker();
      else if (k === "o") cycleOrder();
      else if (k === "w") stopAtFirst = !stopAtFirst;
      else if (k === "u" && canUpdate()) return finish("update");
      else if (/^[1-9]$/.test(str ?? "") && PROTOCOLS[Number(str) - 1]) flip(protos, PROTOCOLS[Number(str) - 1]);
      else if (k === "escape" && query) query = "", cursor = 0;
      else if (k === "return") {
        if (start()) return;
      } else if (k === "q" || k === "escape") return finish(null);
      render();
    };
    input.on("keypress", onKey);
    render();
  });
}

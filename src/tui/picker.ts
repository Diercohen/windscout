// Screen 1: pick countries, protocols, all ports, speed test (while not hidden), firewall, random order, timeout and docker,
// by keyboard or mouse.
import type { Key } from "node:readline";
import { loadDockerWireGuard, MIN_TIMEOUT, saveConfig, SPEED_TEST, type Choice } from "../config.js";
import { dockerState, loginSeconds, notInContainers, workerCount, type DockerState } from "../docker.js";
import { attemptSeconds, estimate } from "../scan.js";
import { duration } from "../time.js";
import { canUpdate, checkUpdate, versionLines } from "../update.js";
import { COUNTRIES, protocolPorts, PROTOCOLS } from "../windscribe.js";
import { countryName, flag } from "./country.js";
import { setupDocker } from "./docker.js";
import { draw, enterScreen, input, leaveScreen, out, repoLink, type Mouse } from "./terminal.js";
import { bold, cyan, dim, green, under, vw, yellow } from "./text.js";
import { box, centerIn, grid } from "./widgets.js";

export interface PickerOptions {
  timeout: number; // initial state of the settings
  speedTest: boolean;
  firewall: boolean;
  random: boolean;
  allPorts: boolean;
  docker: boolean;
}

type Button = "start" | "all" | "none" | "quit";

// where things landed on screen in the last render, for mouse clicks
interface Hits {
  protoRow: number;
  protoHits: [number, number][]; // [from, to) columns of each protocol
  portsRow: number;
  speedRow: number;
  firewallRow: number;
  randomRow: number;
  timeoutRow: number;
  dockerRow: number;
  searchRow: number;
  firstRow: number; // first country row
  shown: number; // country rows on screen
  buttonRow: number;
  buttonHits: [Button, number, number][];
}

const flip = <T>(set: Set<T>, value: T) => (set.has(value) ? set.delete(value) : set.add(value));

/** Resolves to the choice (also saved for next time), null when the user quits, or "update" for u */
export function pick(saved: Choice | null, { timeout, speedTest, firewall, random, allPorts, docker }: PickerOptions): Promise<Choice | null | "update"> {
  const selected = new Set(saved?.countries ?? []);
  const protos = new Set(saved?.protocols.length ? saved.protocols : PROTOCOLS);
  let cursor = 0, top = 0, message = "", query = "", searching = false;
  let seconds = String(timeout), editing = false; // the timeout, as typed
  let dockerAt: DockerState | null = null, inDialog = false; // docker's state once checked; a docker dialog has the screen
  let portLists: ReadonlyMap<string, number[]> | null = null; // each protocol's ports, once the app said
  let hit: Hits;
  const visible = () => {
    const q = query.toLowerCase();
    return q ? COUNTRIES.filter((c) => c.toLowerCase().includes(q) || countryName(c).toLowerCase().includes(q)) : COUNTRIES;
  };
  const ports = (p: string) => (allPorts && portLists?.get(p)?.length) || 1; // attempts per country for the protocol
  const perCountry = (ps: Iterable<string>) => [...ps].reduce((n, p) => n + ports(p), 0);
  const attempts = () => selected.size * perCountry(protos);
  const wireguard = loadDockerWireGuard(); // in docker containers, as the last parallel scan found
  enterScreen();

  return new Promise((resolve) => {
    const render = () => {
      if (inDialog) return;
      const rows = out.rows || 24;
      const version = versionLines(true);
      const matches = visible();
      const height = Math.max(3, rows - 23 - version.length);
      cursor = Math.max(0, Math.min(cursor, matches.length - 1));
      if (cursor < top) top = cursor;
      if (cursor >= top + height) top = cursor - height + 1;
      top = Math.max(0, Math.min(top, matches.length - height));

      const protoLine = PROTOCOLS.map((p, i) =>
        `${dim(under(String(i + 1)))} ${protos.has(p) ? green("● " + p) : dim("○ " + p)}`).join("   ");
      const listed = portLists && [...portLists.values()].some((l) => l.length), each = perCountry(protos);
      const portsLine = `${dim(under("p"))} ${allPorts ? green("● all ports") : dim("○ all ports")}  ${dim(!allPorts
        ? "off: each protocol on its default port"
        : !portLists ? "checking the ports…"
        : !listed ? "this Windscribe app can't list its ports: 2.22 and newer can"
        : `every port of each protocol: ${each} attempt${each === 1 ? "" : "s"} per country${each > protos.size ? `, not ${protos.size}` : ""}`)}`;
      const speedLine = `${dim(under("s"))} ${speedTest ? green("● speed test") : dim("○ speed test")}  ${dim(speedTest
        ? "ranks by download speed · adds ~15s per working connection"
        : "off: connect-only, ranks by latency")}`;
      const fwLabel = "block internet while scanning (firewall)";
      const fwLine = `${dim(under("f"))} ${firewall ? green("● " + fwLabel) : dim("○ " + fwLabel)}  ${dim(docker
        ? "not used with docker"
        : firewall ? "only VPN traffic gets through" : "off: apps may leak in between")}`;
      const randomLine = `${dim(under("r"))} ${random ? green("● random order") : dim("○ random order")}  ${dim(random
        ? "scans the countries shuffled, a new order each run"
        : "off: scans in list order")}`;
      timeout = Number(seconds);
      const short = timeout < MIN_TIMEOUT;
      const timeoutLine = `${dim(under("t"))} timeout ${editing ? bold(seconds) + cyan("▏") : (short ? yellow : bold)(seconds || "?")} s  ${dim(`per connection · at least ${MIN_TIMEOUT}`)}`;
      const n = attempts();
      const here = PROTOCOLS.filter((p) => docker && protos.has(p) && notInContainers(PROTOCOLS, wireguard).has(p)); // after the containers
      const inContainers = selected.size * perCountry([...protos].filter((p) => !here.includes(p)));
      const parallel = docker && dockerAt === "ready" && inContainers > 0;
      const slots = parallel ? workerCount(inContainers) : 1;
      const login = parallel ? loginSeconds(slots) : 0; // the containers log in before the scan starts
      const dockerLabel = "parallel scan in docker containers";
      const dockerLine = `${dim(under("d"))} ${docker ? green("● " + dockerLabel) : dim("○ " + dockerLabel)}  ${dim(!docker
        ? "off: one attempt at a time"
        : dockerAt === "ready" ? `${slots} at a time${here.length ? ` · ${here.join(" and ")} here, after them` : ""}`
        : dockerAt ? "docker isn't ready: start sets it up" : "checking docker…")}`;
      const search = searching
        ? `${cyan("🔍")} ${bold(query)}${cyan("▏")}`
        : query ? `🔍 ${query}` : dim("🔍 press / to search");
      const shown = matches.slice(top, top + height);
      const range = matches.length > height ? `${top + 1}–${top + shown.length} of ${matches.length}` : `${matches.length} countries`;
      const body = shown.map((code, j) => {
        const here = top + j === cursor;
        const mark = selected.has(code) ? green("●") : dim("○");
        const name = `${flag(code)} ${countryName(code)}`;
        return [`${here ? cyan("❯") : " "} ${mark}`, here ? bold(code) : dim(code), here ? bold(cyan(name)) : name];
      });
      if (!body.length) body.push(["   ", "", dim("no country matches")]);
      const buttons: [Button, string][] = [
        ["start", "▶ Start"],
        ["all", under("A") + (query ? "ll shown" : "ll")],
        ["none", under("N") + (query ? "one shown" : "one")],
        ["quit", under("Q") + "uit"],
      ];
      const buttonLine = buttons.map(([id, label]) => (id === "start" ? bold(cyan(`[ ${label} ]`)) : dim(`[ ${label} ]`))).join("  ");

      const settings = [protoLine, portsLine, ...(SPEED_TEST ? [speedLine] : []), fwLine, randomLine, timeoutLine, dockerLine];
      const table = grid([{ title: "" }, { title: "Code" }, { title: "Country" }], body,
        { caption: search, captionRight: dim(range), minWidth: Math.max(...settings.map(vw)) + 4 });
      const width = vw(table[0]);
      const head = box(settings, {
        title: bold(cyan("WindScout")),
        right: `${bold(String(selected.size))}${dim(`/${COUNTRIES.length} selected`)}`,
        width: width - 4,
      });
      const lines = [
        ...head,
        ...table,
        "",
        centerIn(buttonLine, width),
        "",
        centerIn(n
          ? `${bold(String(n))} attempts · estimated ${bold("≈ " + duration(login + estimate(inContainers, timeout, slots) + estimate(n - inContainers, timeout)))} ${dim(`(~${attemptSeconds(timeout)}s each${slots > 1 ? `, ${slots} at a time` : ""}${login ? `, + ~${duration(login)} login` : ""})`)}`
          : yellow("select at least one country and one protocol"), width),
        centerIn(dim(editing
          ? "type the seconds to wait for each connection · enter/esc done"
          : searching
          ? "type to filter · ↑↓ move · enter/esc done"
          // both lines fit 80 columns
          : `↑↓ move · space select · a/n ${query ? "all/none shown · esc clear" : "all/none · / search"} · enter start · q quit`), width),
        centerIn(dim(searching || editing ? "" : `1-${PROTOCOLS.length} protocols · p ports${SPEED_TEST ? " · s speed" : ""} · f firewall · r random · t timeout · d docker`), width),
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
        firewallRow: row(fwLine), randomRow: row(randomLine), timeoutRow: row(timeoutLine), dockerRow: row(dockerLine),
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
      if (!attempts()) {
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
        random,
        allPorts,
        timeout,
        docker,
      };
      saveConfig(choice);
      finish(choice);
      return true;
    };

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
      const matches = visible();
      const { x, y } = m;
      if (m.button === 64) cursor = Math.max(0, cursor - 3); // wheel up
      else if (m.button === 65) cursor = Math.min(matches.length - 1, cursor + 3); // wheel down
      else if (m.button !== 0) return; // left button only
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
        else if (y === hit.randomRow) random = !random;
        else if (y === hit.dockerRow) return void toggleDocker();
        else if (y === hit.buttonRow) {
          const id = hit.buttonHits.find(([, a, b]) => x >= a && x < b)?.[0];
          if (id === "start" && start()) return;
          if (id === "quit") return finish(null);
          if (id === "all") matches.forEach((c) => selected.add(c));
          if (id === "none") matches.forEach((c) => selected.delete(c));
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

      if (key.ctrl && k === "c") return finish(null);
      if (k === "up") cursor = Math.max(0, cursor - 1);
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
      else if (k === "r") random = !random;
      else if (k === "t") editing = true, seconds = "";
      else if (k === "d") return void toggleDocker();
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

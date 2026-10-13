// Screen 1: pick countries, protocols, speed test and firewall, by keyboard or mouse.
import type { Key } from "node:readline";
import { saveConfig, type Choice } from "../config.js";
import { attemptSeconds, estimate } from "../scan.js";
import { duration } from "../time.js";
import { checkUpdate, updateNotice } from "../update.js";
import { COUNTRIES, PROTOCOLS } from "../windscribe.js";
import { countryName, flag } from "./country.js";
import { draw, enterScreen, input, leaveScreen, out, repoLink, type Mouse } from "./terminal.js";
import { bold, cyan, dim, green, under, vw, yellow } from "./text.js";
import { box, centerIn, grid } from "./widgets.js";

export interface PickerOptions {
  timeout: number; // for the time estimate
  speedTest: boolean; // initial state of the toggles
  firewall: boolean;
}

type Button = "start" | "all" | "none" | "quit";

// where things landed on screen in the last render, for mouse clicks
interface Hits {
  protoRow: number;
  protoHits: [number, number][]; // [from, to) columns of each protocol
  speedRow: number;
  firewallRow: number;
  searchRow: number;
  firstRow: number; // first country row
  shown: number; // country rows on screen
  buttonRow: number;
  buttonHits: [Button, number, number][];
}

const flip = <T>(set: Set<T>, value: T) => (set.has(value) ? set.delete(value) : set.add(value));

/** Resolves to the choice (also saved for next time), or null when the user quits */
export function pick(saved: Choice | null, { timeout, speedTest, firewall }: PickerOptions): Promise<Choice | null> {
  const selected = new Set(saved?.countries ?? []);
  const protos = new Set(saved?.protocols.length ? saved.protocols : PROTOCOLS);
  let cursor = 0, top = 0, message = "", query = "", searching = false;
  let hit: Hits;
  const visible = () => {
    const q = query.toLowerCase();
    return q ? COUNTRIES.filter((c) => c.toLowerCase().includes(q) || countryName(c).toLowerCase().includes(q)) : COUNTRIES;
  };
  enterScreen();

  return new Promise((resolve) => {
    const render = () => {
      const rows = out.rows || 24;
      const notice = updateNotice();
      const matches = visible();
      const height = Math.max(3, rows - 20 - (notice ? 1 : 0));
      cursor = Math.max(0, Math.min(cursor, matches.length - 1));
      if (cursor < top) top = cursor;
      if (cursor >= top + height) top = cursor - height + 1;
      top = Math.max(0, Math.min(top, matches.length - height));

      const protoLine = PROTOCOLS.map((p, i) =>
        `${dim(under(String(i + 1)))} ${protos.has(p) ? green("● " + p) : dim("○ " + p)}`).join("   ");
      const speedLine = `${dim(under("s"))} ${speedTest ? green("● speed test") : dim("○ speed test")}  ${dim(speedTest
        ? "ranks by download speed · adds ~15s per working connection"
        : "off: connect-only, ranks by latency")}`;
      const fwLabel = "block internet while scanning (firewall)";
      const fwLine = `${dim(under("f"))} ${firewall ? green("● " + fwLabel) : dim("○ " + fwLabel)}  ${dim(firewall
        ? "only VPN traffic gets through"
        : "off: apps may leak in between")}`;
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

      const table = grid([{ title: "" }, { title: "Code" }, { title: "Country" }], body,
        { caption: search, captionRight: dim(range), minWidth: Math.max(vw(protoLine), vw(speedLine), vw(fwLine)) + 4 });
      const width = vw(table[0]);
      const head = box([protoLine, speedLine, fwLine], {
        title: bold(cyan("WindScout")),
        right: `${bold(String(selected.size))}${dim(`/${COUNTRIES.length} selected`)}`,
        width: width - 4,
      });
      const n = selected.size * protos.size;
      const lines = [
        ...head,
        ...table,
        "",
        centerIn(buttonLine, width),
        "",
        centerIn(n
          ? `${bold(String(n))} attempts · estimated ${bold("≈ " + duration(estimate(selected.size, protos.size, timeout)))} ${dim(`(~${attemptSeconds(timeout)}s each)`)}`
          : yellow("select at least one country and one protocol"), width),
        centerIn(dim(searching
          ? "type to filter · ↑↓ move · enter/esc done"
          : `↑↓ move · space select · a/n ${query ? "all/none shown" : "all/none"} · / search`), width),
        centerIn(dim(searching ? "" : `1-${PROTOCOLS.length} protocols · s speed test · f firewall · enter start · ${query ? "esc clear · " : ""}q quit`), width),
      ];
      if (message) lines.push(centerIn(yellow(message), width));
      lines.push("", centerIn(dim(repoLink), width));
      if (notice) lines.push(centerIn(yellow(notice), width));
      const at = draw(lines);

      // click map, in screen coordinates
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
        protoRow: at.top + 1, protoHits, speedRow: at.top + 2, firewallRow: at.top + 3,
        searchRow: at.top + head.length + 1,
        firstRow: at.top + head.length + 5, shown: shown.length,
        buttonRow: at.top + head.length + table.length + 1, buttonHits,
      };
    };

    let closed = false;
    checkUpdate().then(() => updateNotice() && !closed && render()); // the check usually lands after the first draw
    const finish = (value: Choice | null) => {
      closed = true;
      out.off("resize", render);
      input.removeAllListeners("keypress");
      input.removeAllListeners("mouse");
      if (!value) leaveScreen();
      resolve(value);
    };

    const start = (): boolean => {
      if (!selected.size || !protos.size) {
        message = "nothing to scan yet";
        return false;
      }
      // keep the user's order of preference stable: list order
      const choice: Choice = {
        countries: COUNTRIES.filter((c) => selected.has(c)),
        protocols: PROTOCOLS.filter((p) => protos.has(p)),
        speed: speedTest,
        firewall,
      };
      saveConfig(choice);
      finish(choice);
      return true;
    };

    input.on("mouse", (m: Mouse) => {
      if (!m.press) return;
      message = "";
      const matches = visible();
      const { x, y } = m;
      if (m.button === 64) cursor = Math.max(0, cursor - 3); // wheel up
      else if (m.button === 65) cursor = Math.min(matches.length - 1, cursor + 3); // wheel down
      else if (m.button !== 0) return; // left button only
      else if (y === hit.searchRow) searching = true;
      else {
        searching = false; // clicking anywhere else ends typing, like leaving a text field
        if (y >= hit.firstRow && y < hit.firstRow + hit.shown) {
          cursor = top + (y - hit.firstRow);
          const c = matches[cursor];
          if (c) flip(selected, c);
        } else if (y === hit.protoRow) {
          const i = hit.protoHits.findIndex(([a, b]) => x >= a && x < b);
          if (i >= 0) flip(protos, PROTOCOLS[i]);
        } else if (y === hit.speedRow) speedTest = !speedTest;
        else if (y === hit.firewallRow) firewall = !firewall;
        else if (y === hit.buttonRow) {
          const id = hit.buttonHits.find(([, a, b]) => x >= a && x < b)?.[0];
          if (id === "start" && start()) return;
          if (id === "quit") return finish(null);
          if (id === "all") matches.forEach((c) => selected.add(c));
          if (id === "none") matches.forEach((c) => selected.delete(c));
        }
      }
      render();
    });

    out.on("resize", render);
    input.on("keypress", (str: string | undefined, key: Key = {}) => {
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
      else if (searching) {
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
      else if (k === "s") speedTest = !speedTest;
      else if (k === "f") firewall = !firewall;
      else if (/^[1-9]$/.test(str ?? "") && PROTOCOLS[Number(str) - 1]) flip(protos, PROTOCOLS[Number(str) - 1]);
      else if (k === "escape" && query) query = "", cursor = 0;
      else if (k === "return") {
        if (start()) return;
      } else if (k === "q" || k === "escape") return finish(null);
      render();
    });
    render();
  });
}

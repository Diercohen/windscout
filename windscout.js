#!/usr/bin/env node
// WindScout: find which Windscribe locations and protocols actually work from here.
// Drives the official windscribe-cli: connects to each country/protocol pair,
// measures latency and download speed through the tunnel, prints a ranked table.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { PassThrough } from "node:stream";
import { parseArgs } from "node:util";

const CLI = "windscribe-cli";
// the desktop app installs the CLI here and links it into /usr/bin (/usr/local/bin on macOS); use it directly if the link is missing.
// Windows doesn't put it on PATH at all, so there the fallback is the normal case
const DESKTOP_CLI = {
  darwin: "/Applications/Windscribe.app/Contents/MacOS/windscribe-cli",
  win32: join(process.env.ProgramFiles || "C:\\Program Files", "Windscribe", "windscribe-cli.exe"),
}[process.platform] ?? "/opt/windscribe/windscribe-cli";
const DOWNLOAD_URL = "https://windscribe.com/download";
let cliBin = CLI;
// IKEv2 is offered by the macOS/Windows apps only
const PROTOCOLS = ["wireguard", ...(process.platform === "linux" ? [] : ["ikev2"]), "stealth", "wstunnel", "udp", "tcp"];
// ponytail: hardcoded because `windscribe-cli locations` returns nothing on 2.24; refresh when Windscribe adds countries
const COUNTRIES = `US CA MX BR AR CL CO PE GB IE FR DE NL BE LU CH AT IT ES PT DK NO SE FI IS
PL CZ SK HU RO BG GR CY TR RS HR SI BA MK AL MD UA EE LV LT IL AE AZ GE AM KZ IN JP KR
HK SG TW ID MY TH VN PH AU NZ ZA NG KE EG`.split(/\s+/);

const LATENCY_URL = "https://www.gstatic.com/generate_204";
const SPEED_URL = "https://speed.cloudflare.com/__down?bytes=10000000";
const SPEED_SECONDS = 15;
const CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "windscout", "config.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now() / 1000;
const regionName = new Intl.DisplayNames(["en"], { type: "region" });
const countryName = (code) => {
  try { return regionName.of(code); } catch { return code; } // city names / nicknames aren't region codes
};
// two regional-indicator letters render as the country's flag emoji (Windows has no flag glyphs: it would show
// two boxed letters of unpredictable width and break the table borders, so leave the slot blank there)
const flag = (code) => process.platform !== "win32" && /^[A-Z]{2}$/.test(code) ? String.fromCodePoint(...[...code].map((c) => 0x1f1a5 + c.charCodeAt(0))) : "  ";
let stop = 0;
let speedTest = true; // false = connect-only mode: skip the download test, rank by latency

// ---------- windscribe + measurements ----------

// spawn, not execFile: if the app isn't running, the CLI launches it and the app inherits our stdout pipe.
// The pipe then stays open after the CLI exits, and execFile would wait for its timeout. Settle on exit instead
function run(args) {
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

async function cli(...args) {
  let out;
  try {
    out = await run(args);
  } catch (e) {
    if (e.code === "ENOENT") {
      if (cliBin === CLI && existsSync(DESKTOP_CLI)) return (cliBin = DESKTOP_CLI), cli(...args);
      throw new Error(`${CLI} not found. Install the Windscribe desktop app (it includes ${CLI}): ${DOWNLOAD_URL}`);
    }
    throw e;
  }
  // the CLI mixes JSON log lines into stdout
  return out.split("\n").filter((l) => !l.startsWith('{"tm"')).join("\n");
}

async function state() {
  // macOS marks the line with a leading "*" once connected: "*Connect state: Connected: Miami - Vice"
  return (await cli("status")).match(/^\*?Connect state: (.*)$/m)?.[1].trim() ?? "";
}

async function latencyMs(tries = 3) {
  let best = null;
  for (let i = 0; i < tries; i++) {
    const t = now();
    try {
      await (await fetch(LATENCY_URL, { signal: AbortSignal.timeout(5000) })).arrayBuffer();
    } catch {
      continue;
    }
    const ms = (now() - t) * 1000;
    best = best === null ? ms : Math.min(best, ms);
  }
  return best;
}

async function speedMbps() {
  const t = now();
  let n = 0;
  try {
    const res = await fetch(SPEED_URL, {
      headers: { "User-Agent": "curl/8" }, // Cloudflare 403s unknown clients
      signal: AbortSignal.timeout(SPEED_SECONDS * 1000),
    });
    if (!res.ok) return null;
    for await (const chunk of res.body) n += chunk.length;
  } catch {
    if (!n) return null; // timeout mid-download is fine: we measured what arrived
  }
  return (n * 8) / (now() - t) / 1e6;
}

// onStep(text) reports what the probe is doing, for the live view
async function probe(query, protocol, timeout, onStep = () => {}) {
  const r = { query, protocol, location: "", connectS: null, latencyMs: null, speedMbps: null, status: "" };
  onStep("connecting");
  await cli("connect", "-n", query, protocol);
  const t = now();
  try {
    for (;;) {
      if (stop) return (r.status = "interrupted"), r;
      if (now() - t >= timeout) return (r.status = "timeout"), r;
      const s = await state();
      if (s.startsWith("Connecting:")) r.location = s.split(":").slice(1).join(":").trim();
      else if (s.startsWith("Connected")) {
        if (s.includes(":")) r.location = s.split(":").slice(1).join(":").trim();
        r.connectS = now() - t;
        break;
      } else if (s.includes("does not exist")) return (r.status = "no such location"), r;
      else if (s === "Disconnected" && now() - t > 3) return (r.status = "failed"), r;
      onStep(`connecting ${r.location}`.trim());
      await sleep(1000);
    }
    onStep(`measuring latency · ${r.location}`);
    r.latencyMs = await latencyMs();
    if (r.latencyMs === null) return (r.status = "no internet"), r;
    if (speedTest) {
      onStep(`measuring speed · ${r.location}`);
      r.speedMbps = await speedMbps();
    }
    r.status = "ok";
    return r;
  } finally {
    onStep("disconnecting");
    await cli("disconnect");
  }
}

// ---------- formatting ----------

const color = (code, s) => (process.env.NO_COLOR || !process.stdout.isTTY ? s : `\x1b[${code}m${s}\x1b[0m`);
const bold = (s) => color(1, s), dim = (s) => color(2, s), green = (s) => color(32, s);
const cyan = (s) => color(36, s), yellow = (s) => color(33, s), red = (s) => color(31, s);
const fmt = (v, digits) => (v === null || v === undefined ? "-" : v.toFixed(digits));
const list = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);

function duration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

// ponytail: rough per-attempt cost: a failure burns the timeout, a success ~connect+speed test; refine from real runs
const attemptSeconds = (timeout) => timeout + 5;
const estimate = (nCountries, nProtocols, timeout) => nCountries * nProtocols * attemptSeconds(timeout);

// ---------- boxes (rounded box-drawing) ----------

// visible width: ANSI codes take no space; flags and emoji (🔍) take 2 columns. text symbols like ▶ ★ stay 1
const vw = (s) =>
  [...s.replace(/\x1b\[[0-9;]*m/g, "").replace(/[\u{1F1E6}-\u{1F1FF}]{2}|[\u{1F300}-\u{1FAFF}]/gu, "xx")].length;
// align: falsy = left, true = right, "center"
const pad = (s, n, align = false) => {
  const gap = Math.max(0, n - vw(s));
  if (align === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return align ? " ".repeat(gap) + s : s + " ".repeat(gap);
};
const line = (s) => dim(s);

// box around content lines; null in lines draws a ├──┤ divider. title/right sit in the top border
function box(lines, { title = "", right = "", width = 0 } = {}) {
  const inner = Math.max(width, ...lines.map((l) => (l === null ? 0 : vw(l))), vw(title) + vw(right) + 6);
  const left = title ? line("─ ") + title + " " : "";
  const tail = right ? " " + right + line(" ─") : "";
  const fill = inner + 2 - vw(left) - vw(tail);
  return [
    line("╭") + left + line("─".repeat(fill)) + tail + line("╮"),
    ...lines.map((l) => (l === null ? line("├" + "─".repeat(inner + 2) + "┤") : line("│") + " " + pad(l, inner) + " " + line("│"))),
    line("╰" + "─".repeat(inner + 2) + "╯"),
  ];
}

// bordered table; optional caption row (spanning all columns) sits on top inside the same border
// cols: { title, align }; stretch = index of the column that absorbs extra width
function grid(cols, rows, { caption, captionRight = "", minWidth = 0, stretch = cols.length - 1 } = {}) {
  const w = cols.map((c, i) => Math.max(vw(c.title), ...rows.map((r) => vw(r[i]))));
  const total = () => w.reduce((a, n) => a + n + 3, 1);
  if (caption !== undefined) w[stretch] += Math.max(0, vw(caption) + vw(captionRight) + 5 - total());
  w[stretch] += Math.max(0, minWidth - total());
  const rule = (l, m, r) => line(l + w.map((n) => "─".repeat(n + 2)).join(m) + r);
  const row = (cells) => line("│") + cells.map((c, i) => " " + pad(c, w[i], cols[i].align) + " ").join(line("│")) + line("│");
  const out = [];
  if (caption !== undefined) {
    const inner = total() - 4;
    out.push(line("╭" + "─".repeat(total() - 2) + "╮"),
      line("│") + " " + pad(caption, inner - vw(captionRight)) + captionRight + " " + line("│"),
      rule("├", "┬", "┤"));
  } else out.push(rule("╭", "┬", "╮"));
  out.push(row(cols.map((c) => bold(c.title))), rule("├", "┼", "┤"), ...rows.map(row), rule("╰", "┴", "╯"));
  return out;
}

const centerIn = (s, width) => " ".repeat(Math.max(0, Math.floor((width - vw(s)) / 2))) + s;

const sortOk = (results) =>
  results.filter((r) => r.status === "ok")
    .sort((x, y) => (y.speedMbps ?? 0) - (x.speedMbps ?? 0) || x.latencyMs - y.latencyMs);

const ALL_RESULT_COLS = [
  { title: "#", align: true }, { title: "Country" }, { title: "Location" }, { title: "Protocol" },
  { title: "Connect", align: true }, { title: "Latency", align: true }, { title: "Speed", align: true }, { title: "Status" },
];
const SPEED_COL = 6;
const resultCols = () => ALL_RESULT_COLS.filter((_, i) => speedTest || i !== SPEED_COL);
const resultRow = (r, i) => [
  dim(String(i + 1)),
  `${flag(r.query)} ${countryName(r.query)}`,
  r.location || "-",
  r.protocol,
  r.connectS === null ? "-" : `${fmt(r.connectS, 1)} s`,
  r.latencyMs === null ? "-" : `${fmt(r.latencyMs, 0)} ms`,
  r.speedMbps === null ? "-" : bold(`${fmt(r.speedMbps, 1)} Mbps`),
  r.status === "ok" ? green("✓ ok") : red(r.status),
].filter((_, i) => speedTest || i !== SPEED_COL);

// availability grid: one row per country, ✓/✗ per protocol (· = not tried yet)
function matrix(results, protocols, { minWidth = 0, limit = Infinity } = {}) {
  const byCountry = new Map();
  for (const r of results) {
    if (r.status === "no such location" || r.status === "interrupted") continue;
    if (!byCountry.has(r.query)) byCountry.set(r.query, []);
    byCountry.get(r.query).push(r);
  }
  const ranked = [...byCountry].map(([q, rs]) => ({ q, rs, good: rs.filter((r) => r.status === "ok").length }))
    .sort((a, b) => b.good - a.good); // stable: ties keep scan order
  const reachable = ranked.filter((c) => c.good).length;
  const rows = ranked.slice(0, limit).map(({ q, rs }) => {
    const seen = rs.find((r) => r.status === "ok") ?? rs.find((r) => r.location);
    return [
      `${flag(q)} ${countryName(q)}`,
      seen?.location?.split(" - ")[0] || dim("-"),
      ...protocols.map((p) => {
        const r = rs.find((x) => x.protocol === p);
        return !r ? dim("·") : r.status === "ok" ? green("✓") : red("✗");
      }),
    ];
  });
  return grid(
    [{ title: "Country" }, { title: "City" }, ...protocols.map((p) => ({ title: p, align: "center" }))],
    rows,
    {
      caption: bold("Availability"),
      captionRight: dim(`${reachable}/${ranked.length} countries reachable${ranked.length > limit ? ` · top ${limit}` : ""}`),
      minWidth,
      stretch: 1,
    },
  );
}

// ---------- config ----------

function loadConfig() {
  try {
    const c = JSON.parse(readFileSync(CONFIG, "utf8"));
    return {
      countries: (c.countries ?? []).filter((x) => COUNTRIES.includes(x)),
      protocols: (c.protocols ?? []).filter((x) => PROTOCOLS.includes(x)),
      speed: c.speed !== false,
    };
  } catch {
    return null; // first run or unreadable file
  }
}

function saveConfig(c) {
  try {
    mkdirSync(join(CONFIG, ".."), { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(c, null, 2) + "\n");
  } catch {} // not being able to remember isn't worth failing the scan
}

// ---------- terminal ----------

const out = process.stdout;
// stdin minus mouse reports: readline would split those into stray keypresses ("0", ";", "M"…)
const input = new PassThrough();
readline.emitKeypressEvents(input);
// SGR mouse report: ESC [ < button ; col ; row (M = press, m = release); 64/65 = wheel up/down
// ponytail: assumes a report never straddles two reads, true for terminals in practice
const onData = (buf) => {
  const rest = buf.toString().replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, b, x, y, kind) => {
    input.emit("mouse", { button: Number(b), x: Number(x) - 1, y: Number(y) - 1, press: kind === "M" });
    return "";
  });
  if (rest) input.write(rest);
};

let fullscreen = false;
function enterScreen() {
  fullscreen = true;
  out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h"); // alternate screen, hide cursor, mouse on
  process.stdin.setRawMode(true);
  process.stdin.on("data", onData);
  process.stdin.resume();
}
function leaveScreen() {
  if (!fullscreen) return;
  fullscreen = false;
  process.stdin.setRawMode(false);
  process.stdin.off("data", onData);
  process.stdin.pause();
  input.removeAllListeners("keypress");
  input.removeAllListeners("mouse");
  out.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l");
}
process.on("exit", leaveScreen);

// redraw in place, centered: home, each line cleared to its end, then clear below (no flicker)
function draw(lines) {
  const cols = out.columns || 80, rows = out.rows || 24;
  const w = Math.max(...lines.map(vw));
  const left = " ".repeat(Math.max(0, Math.floor((cols - w) / 2)));
  const top = Math.max(0, Math.floor((rows - lines.length) / 2));
  const screen = [...Array(top).fill(""), ...lines.map((l) => left + l)].slice(0, rows);
  out.write("\x1b[H" + screen.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
  return { left: left.length, top };
}

// gradient bar (cyan → green) with eighth-block precision on the leading edge
function bar(fraction, width) {
  const parts = " ▏▎▍▌▋▊▉";
  const cells = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(cells);
  const palette = [45, 44, 43, 42, 41, 47, 48, 49, 83, 82];
  const shade = (i) => palette[Math.floor((i / width) * palette.length)];
  let s = "";
  for (let i = 0; i < full; i++) s += color(`38;5;${shade(i)}`, "█");
  if (full < width) {
    const p = parts[Math.floor((cells - full) * 8)];
    s += p === " " ? dim("░") : color(`38;5;${shade(full)}`, p);
    s += dim("░".repeat(width - full - 1));
  }
  return s;
}

// ---------- screen 1: picker ----------

function pick(saved, timeout) {
  const selected = new Set(saved?.countries ?? []);
  const protos = new Set(saved?.protocols?.length ? saved.protocols : PROTOCOLS);
  let cursor = 0, top = 0, message = "", query = "", searching = false;
  let hit = {}; // where things landed on screen last render, for mouse clicks
  const visible = () => {
    const q = query.toLowerCase();
    return q ? COUNTRIES.filter((c) => c.toLowerCase().includes(q) || countryName(c).toLowerCase().includes(q)) : COUNTRIES;
  };
  enterScreen();

  return new Promise((resolve) => {
    const render = () => {
      const rows = out.rows || 24;
      const list = visible();
      const height = Math.max(3, rows - 17);
      cursor = Math.max(0, Math.min(cursor, list.length - 1));
      if (cursor < top) top = cursor;
      if (cursor >= top + height) top = cursor - height + 1;
      top = Math.max(0, Math.min(top, list.length - height));

      const protoLine = PROTOCOLS.map((p, i) =>
        `${dim(String(i + 1))} ${protos.has(p) ? green("● " + p) : dim("○ " + p)}`).join("   ");
      const speedLine = `${dim("s")} ${speedTest ? green("● speed test") : dim("○ speed test")}  ${dim(speedTest
        ? "ranks by download speed · adds ~15s per working connection"
        : "off: connect-only, ranks by latency")}`;
      const search = searching
        ? `${cyan("🔍")} ${bold(query)}${cyan("▏")}`
        : query ? `🔍 ${query}` : dim("🔍 press / to search");
      const shown = list.slice(top, top + height);
      const range = list.length > height ? `${top + 1}–${top + shown.length} of ${list.length}` : `${list.length} countries`;
      const body = shown.map((code, j) => {
        const here = top + j === cursor;
        const mark = selected.has(code) ? green("●") : dim("○");
        const name = `${flag(code)} ${countryName(code)}`;
        return [`${here ? cyan("❯") : " "} ${mark}`, here ? bold(code) : dim(code), here ? bold(cyan(name)) : name];
      });
      if (!body.length) body.push(["   ", "", dim("no country matches")]);
      const buttons = [["start", "▶ Start"], ["all", query ? "All shown" : "All"], ["none", query ? "None shown" : "None"], ["quit", "Quit"]];
      const buttonLine = buttons.map(([id, label]) => (id === "start" ? bold(cyan(`[ ${label} ]`)) : dim(`[ ${label} ]`))).join("  ");

      const table = grid([{ title: "" }, { title: "Code" }, { title: "Country" }], body,
        { caption: search, captionRight: dim(range), minWidth: Math.max(vw(protoLine), vw(speedLine)) + 4 });
      const width = vw(table[0]);
      const head = box([protoLine, speedLine], {
        title: bold(cyan("WindScout")),
        right: `${bold(String(selected.size))}${dim(`/${COUNTRIES.length} selected`)}`,
        width: width - 4,
      });
      const n = selected.size * protos.size;
      const lines = [
        ...head,
        ...table,
        "",
        centerIn(n
          ? `${bold(String(n))} attempts · estimated ${bold("≈ " + duration(estimate(selected.size, protos.size, timeout)))} ${dim(`(~${attemptSeconds(timeout)}s each)`)}`
          : yellow("select at least one country and one protocol"), width),
        centerIn(dim(searching
          ? "type to filter · ↑↓ move · enter/esc done"
          : `↑↓ move · space select · a/n ${query ? "all/none shown" : "all/none"} · / search`), width),
        centerIn(dim(searching ? "" : `1-${PROTOCOLS.length} protocols · s speed test · enter start · ${query ? "esc clear · " : ""}q quit`), width),
      ];
      lines.splice(head.length + table.length + 1, 0, centerIn(buttonLine, width), "");
      if (message) lines.push(centerIn(yellow(message), width));
      const at = draw(lines);

      // click map, in screen coordinates
      const x0 = at.left, y0 = at.top;
      let px = x0 + 2; // "│ " before the protocol line
      const protoHits = PROTOCOLS.map((p, i) => {
        const len = vw(`${i + 1} ● ${p}`);
        const range = [px, px + len];
        px += len + 3;
        return range;
      });
      let bx = x0 + Math.floor((width - vw(buttonLine)) / 2);
      const buttonHits = buttons.map(([id, label]) => {
        const len = vw(`[ ${label} ]`);
        const range = [id, bx, bx + len];
        bx += len + 2;
        return range;
      });
      hit = {
        protoRow: y0 + 1, speedRow: y0 + 2, protoHits,
        searchRow: y0 + head.length + 1,
        firstRow: y0 + head.length + 5, shown: shown.length,
        buttonRow: y0 + head.length + table.length + 1, buttonHits,
      };
    };

    const finish = (value) => {
      out.off("resize", render);
      input.removeAllListeners("keypress");
      input.removeAllListeners("mouse");
      if (!value) leaveScreen();
      resolve(value);
    };

    const start = () => {
      if (!selected.size || !protos.size) return void (message = "nothing to scan yet");
      // keep the user's order of preference stable: list order
      const choice = {
        countries: COUNTRIES.filter((c) => selected.has(c)),
        protocols: PROTOCOLS.filter((p) => protos.has(p)),
        speed: speedTest,
      };
      saveConfig(choice);
      finish(choice);
      return true;
    };

    input.on("mouse", (m) => {
      if (!m.press) return;
      message = "";
      const list = visible();
      const { x, y } = m;
      if (m.button === 64) cursor = Math.max(0, cursor - 3); // wheel up
      else if (m.button === 65) cursor = Math.min(list.length - 1, cursor + 3); // wheel down
      else if (m.button !== 0) return; // left button only
      else if (y === hit.searchRow) searching = true;
      else {
        searching = false; // clicking anywhere else ends typing, like leaving a text field
        if (y >= hit.firstRow && y < hit.firstRow + hit.shown) {
          cursor = top + (y - hit.firstRow);
          const c = list[cursor];
          if (c) selected.has(c) ? selected.delete(c) : selected.add(c);
        } else if (y === hit.protoRow) {
          const i = hit.protoHits.findIndex(([a, b]) => x >= a && x < b);
          if (i >= 0) protos.has(PROTOCOLS[i]) ? protos.delete(PROTOCOLS[i]) : protos.add(PROTOCOLS[i]);
        } else if (y === hit.speedRow) speedTest = !speedTest;
        else if (y === hit.buttonRow) {
          const id = hit.buttonHits.find(([, a, b]) => x >= a && x < b)?.[0];
          if (id === "start" && start()) return;
          if (id === "quit") return finish(null);
          if (id === "all") list.forEach((c) => selected.add(c));
          if (id === "none") list.forEach((c) => selected.delete(c));
        }
      }
      render();
    });

    out.on("resize", render);
    input.on("keypress", (str, key = {}) => {
      message = "";
      const k = key.name;
      const list = visible();
      const toggle = () => {
        const c = list[cursor];
        if (!c) return;
        selected.has(c) ? selected.delete(c) : selected.add(c);
        cursor = Math.min(list.length - 1, cursor + 1);
      };

      if (key.ctrl && k === "c") return finish(null);
      if (k === "up") cursor = Math.max(0, cursor - 1);
      else if (k === "down") cursor = Math.min(list.length - 1, cursor + 1);
      else if (k === "pageup") cursor = Math.max(0, cursor - 10);
      else if (k === "pagedown") cursor = Math.min(list.length - 1, cursor + 10);
      else if (searching) {
        // typing goes into the search box; letters are not shortcuts here
        if (k === "return" || k === "escape") searching = false;
        else if (k === "backspace") query = query.slice(0, -1), cursor = 0;
        else if (k === "space" && !query) toggle();
        else if (str && !key.ctrl && !key.meta && str >= " ") query += str, cursor = 0;
      } else if (k === "home") cursor = 0;
      else if (k === "end") cursor = list.length - 1;
      else if (k === "k") cursor = Math.max(0, cursor - 1);
      else if (k === "j") cursor = Math.min(list.length - 1, cursor + 1);
      else if (str === "/") searching = true;
      else if (k === "space") toggle();
      else if (k === "a") list.forEach((c) => selected.add(c));
      else if (k === "n") list.forEach((c) => selected.delete(c));
      else if (k === "s") speedTest = !speedTest;
      else if (/^[1-9]$/.test(str ?? "") && PROTOCOLS[Number(str) - 1]) {
        const p = PROTOCOLS[Number(str) - 1];
        protos.has(p) ? protos.delete(p) : protos.add(p);
      } else if (k === "escape" && query) query = "", cursor = 0;
      else if (k === "return") {
        if (start()) return;
      } else if (k === "q" || k === "escape") return finish(null);
      render();
    });
    render();
  });
}

// ---------- screen 2: scan ----------

async function scan(countries, protocols, timeout, tty) {
  const results = [];
  const total = countries.length * protocols.length;
  const started = now();
  let done = 0, attemptStart = now(), current = "", step = "", frame = 0, finishedCountries = [];
  let view = speedTest ? "ranking" : "availability"; // tab switches

  const render = () => {
    const rows = out.rows || 24;
    const elapsed = now() - started;
    // smooth bar: count the running attempt as partially done
    const partial = Math.min(0.95, (now() - attemptStart) / attemptSeconds(timeout));
    const fraction = (done + (done < total ? partial : 0)) / total;
    const eta = (total - done) * (done ? elapsed / done : attemptSeconds(timeout));
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame++ % 10];
    const ok = sortOk(results);
    const failed = finishedCountries.filter((c) => !results.some((r) => r.query === c && r.status === "ok"));

    const pct = bold(`${String(Math.floor(fraction * 100)).padStart(3)}%`);
    const stats = [
      `${dim("elapsed")} ${duration(elapsed)}`,
      `${dim("remaining")} ${done < total ? "≈ " + duration(eta) : "-"}`,
      `${green("✓")} ${ok.length} ${dim("working")}`,
      `${red("✗")} ${failed.length} ${dim("blocked")}`,
    ].join(dim("   │   "));
    const minW = Math.max(64, vw(stats) + 6); // panel and table share one width
    // results table gets whatever height the status panel and footer leave
    const room = Math.max(1, rows - 20);
    const tried = results.some((r) => !["no such location", "interrupted"].includes(r.status));
    const table = view === "availability"
      ? (tried ? matrix(results, protocols, { minWidth: minW, limit: room }) : [])
      : ok.length
        ? grid(resultCols(), ok.slice(0, room).map(resultRow), {
          caption: bold("Working so far"),
          captionRight: dim(ok.length > room ? `top ${room} of ${ok.length}` : `${ok.length} found`),
          minWidth: minW,
        })
        : [];
    const width = Math.max(minW, table.length ? vw(table[0]) : 0);
    const inner = width - 4;

    const panel = box([
      "",
      ` ${bar(fraction, inner - 8)}  ${pct}`,
      "",
      stop
        ? yellow(" stopping after the current attempt…")
        : ` ${cyan(spinner)} ${bold(current)}`,
      stop ? "" : `   ${dim(step)} ${dim("·")} ${duration(now() - attemptStart)}`,
      null,
      centerIn(stats, inner),
    ], {
      title: bold(cyan("WindScout")),
      right: `${bold(String(done))}${dim(`/${total} attempts`)}`,
      width: inner,
    });

    const lines = [...panel];
    if (table.length) lines.push(...table);
    else lines.push("", centerIn(dim(finishedCountries.length ? "nothing has connected yet" : "results appear here after each country"), width));
    if (failed.length) {
      let txt = `${red("✗")} ${dim("no connection:")} ${failed.map((c) => `${flag(c)} ${c}`).join(" ")}`;
      while (vw(txt) > width && failed.length) txt = txt.slice(0, -8) + "…"; // ponytail: crude trim, fine for a status line
      lines.push("", centerIn(txt, width));
    }
    lines.push("", centerIn(dim(`tab ${view === "ranking" ? "availability" : "ranking"} view · q stop · q twice force quit`), width));
    draw(lines);
  };

  let timer;
  if (tty) {
    if (!fullscreen) enterScreen();
    input.on("keypress", (str, key = {}) => {
      if (key.name === "tab") {
        view = view === "ranking" ? "availability" : "ranking";
        render();
      } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
        if (stop++) { // second press: bail out now
          leaveScreen();
          console.error(`stopped. the VPN may still be connecting: run '${CLI} disconnect'`);
          process.exit(130);
        }
        render();
      }
    });
    out.on("resize", render);
    timer = setInterval(render, 120);
  } else {
    process.on("SIGINT", () => { if (stop++) process.exit(130); });
  }

  outer: for (const loc of countries) {
    for (const proto of protocols) {
      if (stop) break outer;
      current = `${flag(loc)} ${countryName(loc)} ${dim("·")} ${proto}`;
      attemptStart = now();
      if (!tty) process.stdout.write(`[${done + 1}/${total}] ${loc} ${proto} ... `);
      const r = await probe(loc, proto, timeout, (s) => (step = s));
      results.push(r);
      done++;
      if (!tty) console.log([r.status, r.location, r.speedMbps ? `${r.speedMbps.toFixed(1)} Mbps` : ""].join(" ").trim());
      if (r.status === "no such location") { done += protocols.length - protocols.indexOf(proto) - 1; break; }
    }
    finishedCountries.push(loc); // table/failed list refresh per finished country
  }

  if (tty) {
    clearInterval(timer);
    out.off("resize", render);
    leaveScreen();
  }
  return results;
}

// ---------- final report (normal screen, stays in scrollback) ----------

function report(results, protocols, all) {
  const ok = sortOk(results);
  const rows = [...ok, ...(all ? results.filter((r) => r.status !== "ok") : [])];
  const tried = results.some((r) => !["no such location", "interrupted"].includes(r.status));
  // render once to learn the widest table, then again so every box lines up
  const build = (minWidth) => ({
    avail: tried ? matrix(results, protocols, { minWidth }) : [],
    main: rows.length
      ? grid(resultCols(), rows.map(resultRow), { caption: bold("Results"), captionRight: dim(`${ok.length} working`), minWidth })
      : [],
  });
  const first = build(0);
  const width = Math.max(64, ...[first.avail[0], first.main[0]].filter(Boolean).map(vw));
  const { avail, main } = build(width);

  console.log();
  if (avail.length) console.log(avail.join("\n"));
  if (!ok.length) {
    console.log(box([yellow("Nothing connected."),
      dim("Try other countries, ports (e.g. -p stealth:443,tcp:443) or a longer --timeout.")],
    { title: bold(cyan("WindScout")), width: width - 4 }).join("\n"));
    return;
  }
  console.log(main.join("\n"));

  const stats = protocols.map((p) => {
    const tried = results.filter((r) => r.protocol === p && r.status !== "no such location");
    const good = tried.filter((r) => r.status === "ok");
    return { p, good: good.length, tried: tried.length, best: sortOk(good)[0] };
  }).sort((x, y) => y.good - x.good || (y.best?.speedMbps ?? 0) - (x.best?.speedMbps ?? 0) || (x.best?.latencyMs ?? 1e9) - (y.best?.latencyMs ?? 1e9));
  const bestValue = (r) => (speedTest ? `${fmt(r.speedMbps, 1)} Mbps` : `${fmt(r.latencyMs, 0)} ms`);
  console.log(grid(
    [{ title: "Protocol" }, { title: "Worked", align: true }, { title: speedTest ? "Best speed" : "Best latency", align: true }, { title: "Best location" }],
    stats.map((s) => [s.p, `${s.good}/${s.tried}`, s.best ? bestValue(s.best) : "-", s.best ? `${flag(s.best.query)} ${s.best.location}` : "-"]),
    { caption: bold("Per protocol"), minWidth: width },
  ).join("\n"));
  const b = ok[0];
  const target = b.location.split(" - ").at(-1) || b.query; // nickname pins the exact datacenter
  const facts = [speedTest && `${fmt(b.speedMbps, 1)} Mbps`, `${fmt(b.latencyMs, 0)} ms`].filter(Boolean).join(" · ");
  console.log(box([
    `${flag(b.query)} ${bold(b.location)} over ${bold(b.protocol)} ${dim("· " + facts)}`,
    cyan(`${CLI} connect "${target}" ${b.protocol}`),
  ], { title: green(speedTest ? "★ Best" : "★ Best (lowest latency)"), width: width - 4 }).join("\n"));
}

// ---------- main ----------

const HELP = `Usage: windscout [options]

Find which Windscribe locations and protocols work from your network, ranked by speed.
Without -c it opens an interactive country picker (your selection is remembered).

Options:
  -c, --countries LIST  comma-separated ISO codes, city names or nicknames (skips the picker)
  -p, --protocols LIST  comma-separated protocols, optional :port (default: ${PROTOCOLS.join(",")})
  -t, --timeout SEC     seconds to wait for each connection (default: 20)
  -a, --all             also show failed attempts in the final table
  -n, --no-speed        connect-only: skip the download test, rank by latency (faster scan)
  -h, --help            show this help

Selection is stored in ${CONFIG}
Example: windscout -c DE,NL,TR -p stealth,tcp:443`;

async function main() {
  const { values: a } = parseArgs({
    options: {
      countries: { type: "string", short: "c" },
      protocols: { type: "string", short: "p" },
      timeout: { type: "string", short: "t", default: "20" },
      all: { type: "boolean", short: "a", default: false },
      help: { type: "boolean", short: "h", default: false },
      "no-speed": { type: "boolean", short: "n", default: false },
    },
  });
  if (a.help) return console.log(HELP);
  const timeout = Number(a.timeout);
  if (!(timeout > 0)) throw new Error("--timeout must be a positive number");

  // the first CLI call launches the app if it isn't running; give it a moment to start and restore the session
  let status = await cli("status");
  for (let i = 0; i < 15 && !status.includes("Logged in"); i++) await sleep(1000), status = await cli("status");
  if (!status.includes("Logged in"))
    throw new Error("Windscribe is not logged in, or the app is not running. Open the Windscribe app and log in, then try again."
      + `\nDon't have it? ${DOWNLOAD_URL}`);

  const tty = Boolean(process.stdin.isTTY && out.isTTY);
  let countries = a.countries && list(a.countries);
  let protocols = a.protocols && list(a.protocols);
  if (!countries) {
    if (!tty) throw new Error("no terminal for the picker: pass countries with -c");
    const saved = loadConfig();
    if (protocols && saved) saved.protocols = protocols.filter((p) => PROTOCOLS.includes(p));
    speedTest = !a["no-speed"] && (saved?.speed ?? true);
    const choice = await pick(saved, timeout);
    if (!choice) return;
    countries = choice.countries;
    protocols = protocols ?? choice.protocols;
  }
  protocols ??= PROTOCOLS;
  if (a.countries) speedTest = !a["no-speed"];

  const results = await scan(countries, protocols, timeout, tty);
  if (stop) console.log(yellow("interrupted, showing partial results"));
  report(results, protocols, a.all);
}

main().catch((e) => {
  leaveScreen();
  console.error(`windscout: ${e.message}`);
  process.exit(1);
});

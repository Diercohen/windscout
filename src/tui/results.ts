// Screen 3: the results, full screen until you quit. Connect to one (the screen shows where you're connected, live), disconnect,
// test them all again and rank them by what that finds, and watch the connection: when it drops, windscout connects you to the
// next best. While watching, docker containers can check the list in the background. Quitting leaves the VPN as it is.
import type { Key } from "node:readline";
import { loadSettings, saveConfig, saveLast } from "../config.js";
import { dockerState } from "../docker.js";
import { SPEED_MB, SPEED_SECONDS } from "../measure.js";
import { target, type Entry } from "../probe.js";
import { ago, duration, now } from "../time.js";
import { versionLines } from "../update.js";
import { appIo, CHECK_EVERY, Keeper, label, WATCH_GAP, WATCH_MISSES, type Checker } from "../watch.js";
import { CLI, place } from "../windscribe.js";
import { countryName, flag } from "./country.js";
import { setupDocker } from "./docker.js";
import { printList } from "./report.js";
import { draw, enterScreen, input, leaveScreen, out, repoLink, type Mouse } from "./terminal.js";
import { bold, color, cut, cyan, dim, fmt, green, red, under, vw, wrap, yellow } from "./text.js";
import { bar, box, centerIn, grid, spin, type Column } from "./widgets.js";

export interface ResultsOptions {
  entries: Entry[]; // best first
  at: number; // when the scan ended, or the saved list was saved: ms since the epoch
  timeout: number; // seconds to wait for each connection
  saved?: boolean; // the saved list (windscout connect), not a scan's
  note?: string; // above the list, in yellow: why it's this list
  connect?: boolean; // connect to the best right away (windscout connect)
  checker: () => Checker; // makes the background checks, the first time they're turned on
}

type Button = "connect" | "disconnect" | "speed" | "latency" | "watch" | "scan" | "quit";
const CONFIRM: Partial<Record<Button, string>> = { speed: "s", latency: "l", scan: "n" }; // asked first: their key again starts them

// where things landed on screen in the last render, for mouse clicks
interface Hits {
  firstRow: number; // the first shown entry's row
  shown: number;
  buttons: [Button, number, number, number][]; // each button's row, and [from, to) columns
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);
// what an attempt says it's doing, short: "connecting Frankfurt - Castle" → "connecting", "measuring speed · …" → "measuring speed"
const brief = (step: string) => step.replace(/^(connecting|reconnecting) .*/, "$1").split(" · ")[0];
const badge = (code: string, text: string) => color(code, ` ${text} `);
const where = (e: Entry) => `${flag(e.query)} ${bold(e.location || countryName(e.query))} ${dim("over")} ${bold(e.protocol)}`;

/** The last round trips as a bar each, taller for slower; a red dot for one that didn't get through */
function sparkline(trips: (number | null)[]): string {
  const got = trips.filter((t): t is number => t !== null);
  if (trips.length < 2 || !got.length) return "";
  const lo = Math.min(...got), hi = Math.max(...got), bars = "▁▂▃▄▅▆▇█";
  return trips.map((t) => (t === null ? red("·") : dim(bars[hi > lo ? Math.round(((t - lo) / (hi - lo)) * 7) : 0]))).join("");
}

/** Shows the results until q (resolves to "quit") or n (resolves to "scan": the picker, for a new scan) */
export function showResults(o: ResultsOptions): Promise<"scan" | "quit"> {
  const settings = loadSettings();
  const seen = new Set<string>(); // each datacenter and protocol once, as you'd connect to it
  const entries = o.entries.filter((e) => !seen.has(`${target(e)} ${e.protocol}`) && !!seen.add(`${target(e)} ${e.protocol}`)).map((e) => ({ ...e }));
  // saved as it changes, for windscout connect and the scanning types; the saved ones of other countries stay
  const save = (list: Entry[]) => saveLast(list, Date.now(), new Set(list.map((e) => `${e.query} ${e.protocol}`)));
  const k = new Keeper(entries, entries.some((e) => e.speedMbps !== null) ? "speed" : "latency", settings.watch, appIo(o.timeout, save));
  let background = settings.background;
  let selected: Entry | null = k.ranked()[0] ?? null;
  let top = 0, frame = 0, lastClick = 0, title = "";
  let widest = 0; // the screen only grows while it's open, so it doesn't jump about as the statuses change; a resize starts over
  let message = "", confirm: { key: string; run: () => void } | null = null;
  let inDialog = false, leaving = false;
  let hit: Hits = { firstRow: -1, shown: 0, buttons: [] };
  let timer: ReturnType<typeof setInterval> | undefined;
  let checker: Checker | null = null, checking = false; // checking: the background loop is on

  const busy = () => k.queued !== null || ["connecting", "reconnecting", "testing"].includes(k.phase) || (k.phase === "none" && k.watch);

  // the connection, in two lines: what it is, then how it's doing
  const connection = (): string[] => {
    const s = cyan(spin(frame)), q = k.queued, t = k.trying;
    if (q) {
      return q.kind === "connect" ? [`${s} ${bold("CONNECTING")}  ${where(q.entry)}`, dim("  stopping what's running first")]
        : q.kind === "disconnect" ? [`${s} ${bold("DISCONNECTING")}`, ""]
        : [`${s} ${bold(q.speed ? "SPEED TEST" : "LATENCY TEST")}`, dim("  starting")];
    }
    switch (k.phase) {
      case "connected": {
        const e = k.current!;
        const health = k.misses ? yellow(`no answer ${k.misses}/${WATCH_MISSES}`) : k.ms === null ? dim("checking") : `${Math.round(k.ms)} ms`;
        return [`${badge("1;30;42", "● CONNECTED")}  ${where(e)}`,
          `${dim("up")} ${duration(now() - k.since)} ${dim("·")} ${health}${sparkline(k.trips) && ` ${sparkline(k.trips)}`}${k.app.ip ? ` ${dim("· IP")} ${k.app.ip}` : ""}${
            k.drops ? dim(` · connected again ${k.drops}×`) : ""}`];
      }
      case "down":
        return [`${badge("1;30;43", "▲ NO INTERNET")}  ${where(k.current!)}`,
          dim(`no answer through it for ${duration(k.misses * WATCH_GAP)} · the watch is off: w connects you to the next best when it drops`)];
      case "connecting":
      case "reconnecting": {
        const lost = k.phase === "reconnecting" ? k.lost : null;
        const head = lost && `${badge("1;30;43", "▲ CONNECTION LOST")}  ${dim(`${label(lost.entry)}: ${lost.why} · it lasted ${duration(lost.lasted)}`)}`;
        if (!t) return [head || `${s} ${bold("CONNECTING")}`, ""];
        const detail = `${dim(brief(t.step))} ${dim("·")} ${duration(now() - t.start)} ${dim(`of ${o.timeout}s`)}${t.of > 1 ? dim(` · ${t.n} of ${t.of}`) : ""}`;
        return head ? [head, `${s} ${where(t.entry)} ${dim("·")} ${detail}`] : [`${s} ${bold("CONNECTING")}  ${where(t.entry)}`, `  ${detail}`];
      }
      case "none":
        return [badge("1;37;41", "✗ NONE CONNECT NOW"), k.watch && k.retryAt > now()
          ? `trying them all again in ${duration(k.retryAt - now())} ${dim("· enter tries the selected one now · esc stops")}`
          : dim("enter tries the selected one again · s tests them all · n starts a new scan")];
      case "testing": {
        const test = k.test!;
        const left = (test.total - test.done) * (test.done ? (now() - test.start) / test.done : test.speed ? 8 + SPEED_SECONDS : 8);
        return [`${s} ${bold(test.speed ? "SPEED TEST" : "LATENCY TEST")}  ${test.entry ? `${where(test.entry)} ${dim(`· ${brief(test.step)}`)}` : ""}`,
          `${bar(test.done / Math.max(1, test.total), 24)} ${bold(`${test.done}/${test.total}`)} ${dim(`· ≈ ${duration(left)} left${
            test.had ? ` · then back on ${label(test.had)}` : ""} · esc stops`)}`];
      }
      default: {
        const state = k.app.state;
        if (state.startsWith("Connected")) {
          return [`${badge("1;30;42", "● CONNECTED IN THE APP")}  ${bold(place(state) || "somewhere")}`,
            dim("not one windscout connected, so it doesn't watch it · enter switches to the selected one")];
        }
        if (state.startsWith("Connecting")) return [`${s} ${bold("THE APP IS CONNECTING")}  ${place(state)}`, dim("enter switches to the selected one")];
        return [`${dim("○")} ${bold("NOT CONNECTED")}${k.app.ip ? dim(` · your IP ${k.app.ip}, without a VPN`) : ""}`,
          dim(k.entries.length ? "enter connects to the selected one · #1 is the best" : "nothing to connect to: n starts a new scan")];
      }
    }
  };

  const watchLine = (tiny: boolean) => k.watch
    ? `${green("◉")} ${bold("watch on")} ${dim(tiny ? "· when the connection drops, it connects you to the next best"
      : k.current ? "· when this connection drops, windscout connects you to the next best"
      : "· it watches the connection you make here, and connects you to the next best when it drops")}`
    : `${dim("○")} watch off ${dim("· w: when the connection drops, connect to the next best")}`;

  const backgroundLine = (tiny: boolean) => {
    if (!background) {
      return `${dim("○")} background checks off ${dim(`· b: ${tiny ? "" : "while watching, "}docker checks the list every ${duration(CHECK_EVERY)}${tiny ? "" : ", latency only"}`)}`;
    }
    if (!k.watch) return `${dim("◌")} background checks ${dim("· they run while watching")}`;
    const last = k.lastCheck, status = k.checker?.status;
    const next = k.test ? "after the test" : `next in ${duration(Math.max(0, k.checkAt - now()))}`;
    const text = status || `${last ? `${last.worked} of ${last.of} worked ${ago(last.at)} · ` : ""}${next}`;
    return `${green("◉")} background checks ${dim(`· ${text}`)}`;
  };

  const status = (e: Entry) => {
    const step = k.trying?.entry === e ? k.trying.step : k.test?.entry === e ? k.test.step : null;
    if (step !== null) return cyan(`${spin(frame)} ${clip(brief(step), 20)}`);
    if (e === k.current) return k.phase === "down" || k.misses ? yellow("● no answer") : bold(green("● connected"));
    if (e.failed) return `${red(`✗ ${e.failed}`)} ${dim(`· ${ago(e.failedAt ?? Date.now())}`)}`;
    return dim(`✓ ${ago(e.checked ?? o.at)}`);
  };

  // narrow: no country column, the flag goes by the location; tiny: no units (the titles say them); statusWidth: the status cut to fit
  const row = (e: Entry, i: number, sel: boolean, speeds: boolean, narrow: boolean, tiny: boolean, statusWidth: number): string[] => {
    const cur = e === k.current, shade = (s: string) => (e.failed && !sel ? dim(s) : s);
    const place = narrow ? `${flag(e.query)} ${e.location || countryName(e.query)}` : e.location || "-";
    return [
      `${sel ? cyan("❯") : " "} ${sel ? bold(String(i + 1)) : dim(String(i + 1))}`,
      ...(narrow ? [] : [shade(`${flag(e.query)} ${countryName(e.query)}`)]),
      sel ? bold(cyan(place)) : cur ? bold(green(place)) : shade(place),
      shade(e.protocol),
      shade(e.latencyMs === null ? "-" : `${fmt(e.latencyMs, 0)}${tiny ? "" : " ms"}`),
      ...(speeds ? [shade(e.speedMbps === null ? "-" : bold(`${fmt(e.speedMbps, 1)}${tiny ? "" : " Mbps"}`))] : []),
      cut(status(e), statusWidth),
    ];
  };

  const BUTTONS: [Button, (tiny: boolean) => string][] = [["connect", () => "▶ Connect"], ["disconnect", () => `${under("D")}isconnect`],
    ["speed", (tiny) => `${under("S")}peed test${tiny ? "" : " all"}`], ["latency", (tiny) => `${under("L")}atency test${tiny ? "" : " all"}`],
    ["watch", () => `${under("W")}atch: ${k.watch ? "on" : "off"}`], ["scan", () => `${under("N")}ew scan`], ["quit", () => `${under("Q")}uit`]];

  const render = () => {
    if (inDialog || (leaving && !message)) return;
    const cols = out.columns || 80, rows = out.rows || 24, room = Math.max(40, cols - 2); // room: the widest a line may be
    // a tall terminal shows what happened last, and the version; a short one goes without blank lines; a narrow one without the
    // country column, and with shorter hints
    const tall = rows >= 34, short = rows < 30, narrow = cols < 120, tiny = cols < 100;
    const list = k.ranked();
    if (!selected || !list.includes(selected)) selected = list[0] ?? null;
    const cursor = selected ? list.indexOf(selected) : -1, speeds = list.some((e) => e.speedMbps !== null);

    const gap = short ? [] : [""];
    const events = tall ? k.events.slice(-2).map((e) => ` ${dim(e.at.toTimeString().slice(0, 8))} ${e.text}`) : [];
    const panel = [...gap, ...connection().map((l) => `  ${l}`), ...gap, null, ` ${watchLine(narrow)}`, ` ${backgroundLine(narrow)}`,
      ...(events.length ? [null, ...events] : [])].map((l) => (l === null ? null : cut(l, room - 4)));

    // the buttons, in as many rows as the width takes
    const buttonRows: [Button, string][][] = [[]];
    for (const [b, text] of BUTTONS.map(([b, t]) => [b, `[ ${t(tiny)} ]`] as [Button, string])) {
      const line = buttonRows.at(-1)!;
      if (line.length && vw(line.map(([, t]) => t).join("  ")) + 2 + vw(text) > room) buttonRows.push([[b, text]]);
      else line.push([b, text]);
    }
    const paint = (line: [Button, string][]) => line.map(([b, t]) => (b === "connect" && selected ? bold(cyan(t)) : dim(t))).join("  ");
    const stop = busy() ? "esc stops what's running · " : "";
    const hints = tiny
      ? [`↑↓ move · enter connect · d disconnect · ${stop}q quit`, "s/l test all · o sort · w watch · b background · n new scan"]
      : [`↑↓ move · enter connect · d disconnect · ${stop}q quit`, "s speed test all · l latency test all · o sort · w watch · b background checks · n new scan"];
    const said = message ? wrap(message, room).map(yellow) : [""];
    const version = tall ? [...versionLines(), dim(repoLink)] : [];
    const footer = gap.length + buttonRows.length + gap.length + hints.length + said.length + (version.length ? version.length + 1 : 0);
    const height = Math.max(3, rows - (panel.length + 2) - (o.note ? 1 : 0) - 6 - footer);
    if (cursor >= 0) top = Math.min(Math.max(top, cursor - height + 1), cursor);
    top = Math.max(0, Math.min(top, list.length - height));
    const shown = list.slice(top, top + height);

    const columns: Column[] = [{ title: "#", align: "right" }, ...(narrow ? [] : [{ title: "Country" }]), { title: "Location" },
      { title: "Protocol" }, { title: tiny ? "ms" : "Latency", align: "right" }, ...(speeds ? [{ title: tiny ? "Mbps" : "Speed", align: "right" } as Column] : []),
      { title: "Status" }];
    const working = list.filter((e) => !e.failed).length;
    const table = (statusWidth: number) => {
      const body = shown.map((e, j) => row(e, top + j, top + j === cursor, speeds, narrow, tiny, statusWidth));
      if (!body.length) body.push(columns.map((_, i) => (i === (narrow ? 1 : 2) ? dim("no working connections: n starts a new scan") : "")));
      return grid(columns, body, {
        caption: bold(o.saved ? "Saved connections" : "Working connections"),
        captionRight: dim(`${list.length > height ? `${top + 1}–${top + shown.length} of ${list.length} · ` : ""}by ${k.sort}${tiny ? "" : ` · o: by ${k.sort === "speed" ? "latency" : "speed"}`}`),
        minWidth: Math.min(room, Math.max(64, widest, ...panel.map((l) => (l === null ? 0 : vw(l) + 4)))),
        stretch: narrow ? 1 : 2,
      });
    };
    const statuses = Math.max(6, ...shown.map((e) => vw(status(e))));
    let lines = table(statuses);
    if (vw(lines[0]) > room) lines = table(Math.max(8, statuses - (vw(lines[0]) - room))); // the statuses give way first
    const width = (widest = vw(lines[0]));
    const head = box(panel, {
      title: bold(cyan("WindScout")),
      right: `${bold(String(working))}${dim(` working · ${o.saved ? "saved" : "scanned"} ${ago(o.at)}`)}`,
      width: width - 4,
    });

    const screen = [
      ...head,
      ...(o.note ? [centerIn(yellow(cut(o.note, room)), width)] : []),
      ...lines,
      ...gap,
      ...buttonRows.map((line) => centerIn(paint(line), width)),
      ...gap,
      ...hints.map((h) => centerIn(dim(h), width)),
      ...said.map((l) => centerIn(l, width)),
      ...(version.length ? ["", ...version.map((l) => centerIn(l, width))] : []),
    ];
    const at = draw(screen);

    // where things landed, for clicks: the rows under the table's caption and header; each button's columns
    const tableTop = at.top + head.length + (o.note ? 1 : 0), buttonsTop = tableTop + lines.length + gap.length;
    hit = {
      firstRow: tableTop + 5, shown: shown.length,
      buttons: buttonRows.flatMap((line, r) => {
        let x = at.left + Math.max(0, Math.floor((width - vw(paint(line))) / 2));
        return line.map(([b, t]): [Button, number, number, number] => {
          const range: [Button, number, number, number] = [b, buttonsTop + r, x, x + vw(t)];
          x += vw(t) + 2;
          return range;
        });
      }),
    };
    // the window's title says it too, for when the terminal is behind another window
    const windowTitle = k.phase === "connected" && k.current ? `windscout · connected: ${label(k.current)}`
      : k.phase === "reconnecting" ? "windscout · connecting again…" : k.phase === "testing" ? "windscout · testing…" : "windscout";
    if (windowTitle !== title) out.write(`\x1b]2;${(title = windowTitle)}\x07`);
  };

  const askTest = (speed: boolean) => {
    const n = k.entries.length;
    if (!n) return void (message = "nothing to test: n starts a new scan");
    const each = speed ? 8 + SPEED_SECONDS : 8; // ponytail: seconds per working connection, connecting and disconnecting included
    message = `${speed ? "speed" : "latency"} test all ${n}: ≈ ${duration(n * each)}${speed ? `, up to ${n * SPEED_MB} MB of downloads` : ""}${
      k.current ? ", switching your VPN as it goes, then back" : ""} · press ${speed ? "s" : "l"} again to start`;
    confirm = { key: speed ? "s" : "l", run: () => k.retest(speed) };
  };

  const askScan = () => {
    if (!k.current && !busy()) return void leave("scan");
    message = `a new scan ${k.current ? "switches your VPN as it goes" : "stops what's running here"} · press n again to start it`;
    confirm = { key: "n", run: () => void leave("scan") };
  };

  // while watching, and only then: they keep the list fresh for when the connection drops. The first check is due once the
  // oldest news in the list is CHECK_EVERY old: right after a scan, in a few minutes; for an old saved list, now
  const syncBackground = () => {
    const want = background && k.watch && !leaving;
    if (want === checking) return;
    checking = want;
    if (!want) return void k.stopBackground();
    const oldest = Math.min(Date.now(), ...k.entries.map((e) => e.failedAt ?? e.checked ?? o.at));
    void k.background((checker ??= o.checker()), Math.min(CHECK_EVERY, Math.max(0, CHECK_EVERY - (Date.now() - oldest) / 1000))).catch(() => {});
  };

  // turning them on gets docker going first (installs or starts it, after asking), unless it answers already
  let toggling = false; // asking docker: another b waits for that
  const toggleBackground = async () => {
    if (toggling) return;
    toggling = true;
    try {
      if (!background && (await dockerState()) !== "ready") {
        inDialog = true;
        input.off("keypress", onKey);
        input.off("mouse", onMouse);
        const ok = await setupDocker().catch((e) => ((message = (e as Error).message), false));
        input.on("keypress", onKey);
        input.on("mouse", onMouse);
        inDialog = false;
        if (!ok) return render();
      }
      if (leaving) return;
      background = !background;
      saveConfig({ background });
      syncBackground();
      render();
    } finally {
      toggling = false;
    }
  };

  const press = (b: Button) => {
    if (b === "connect") {
      if (!selected) message = "nothing to connect to: n starts a new scan";
      else if (selected === k.current && k.phase === "connected") message = "you're connected to it · d disconnects";
      else k.connect(selected);
    } else if (b === "disconnect") {
      if (k.current || busy() || /^Connect/.test(k.app.state)) k.disconnect();
      else message = "not connected";
    } else if (b === "speed" || b === "latency") askTest(b === "speed");
    else if (b === "watch") {
      k.setWatch(!k.watch);
      saveConfig({ watch: k.watch });
      syncBackground();
    } else if (b === "scan") askScan();
    else void leave("quit");
  };

  const onKey = (_: string | undefined, key: Key = {}) => {
    const name = key.name;
    if (leaving) return void ((name === "q" || name === "escape" || (key.ctrl && name === "c")) && leave("quit"));
    if (key.ctrl && name === "c") return void leave("quit");
    const asked = confirm;
    confirm = null;
    message = "";
    if (asked && name === asked.key) return asked.run(), render();
    const list = k.ranked(), i = selected ? list.indexOf(selected) : 0;
    const move = (to: number) => (selected = list[Math.max(0, Math.min(list.length - 1, to))] ?? null);
    if (name === "up" || name === "k") move(i - 1);
    else if (name === "down" || name === "j") move(i + 1);
    else if (name === "pageup") move(i - 10);
    else if (name === "pagedown") move(i + 10);
    else if (name === "home") move(0);
    else if (name === "end") move(list.length - 1);
    else if (name === "return") press("connect");
    else if (name === "d") press("disconnect");
    else if (name === "s") press("speed");
    else if (name === "l") press("latency");
    else if (name === "w") press("watch");
    else if (name === "n") press("scan");
    else if (name === "o") k.sort = k.sort === "speed" ? "latency" : "speed";
    else if (name === "b") return void toggleBackground();
    else if (name === "q") return void leave("quit");
    else if (name === "escape") {
      if (!busy()) return void leave("quit");
      k.cancel();
      message = "stopping…";
    }
    render();
  };

  const onMouse = (m: Mouse) => {
    if (!m.press || leaving) return;
    const list = k.ranked(), i = selected ? list.indexOf(selected) : 0;
    if (m.button === 64 || m.button === 65) { // wheel
      selected = list[Math.max(0, Math.min(list.length - 1, i + (m.button === 64 ? -3 : 3)))] ?? null;
      return render();
    }
    if (m.button !== 0) return;
    const asked = confirm;
    confirm = null;
    message = "";
    if (m.y >= hit.firstRow && m.y < hit.firstRow + hit.shown) {
      const e = list[top + m.y - hit.firstRow];
      const twice = e === selected && Date.now() - lastClick < 500; // a double click connects
      selected = e ?? selected;
      lastClick = Date.now();
      if (twice) press("connect");
    } else {
      const b = hit.buttons.find(([, y, from, to]) => m.y === y && m.x >= from && m.x < to)?.[0];
      if (b && asked && asked.key === CONFIRM[b]) asked.run();
      else if (b) press(b);
    }
    render();
  };

  let running: Promise<void> = Promise.resolve();
  let settle: (to: "scan" | "quit") => void = () => {};

  const onResize = () => ((widest = 0), render());

  const finish = (to: "scan" | "quit") => {
    clearInterval(timer);
    out.off("resize", onResize);
    out.write("\x1b]2;\x07\x1b[23;2t\x1b[?7h"); // the window title as it was; wrapping back on
    leaveScreen();
    if (to === "quit") {
      if (k.changed) printList(k.ranked());
      const e = k.current;
      if (e && (k.phase === "connected" || k.phase === "down")) {
        console.log(`\n${green("●")} connected to ${flag(e.query)} ${bold(e.location || e.query)} over ${bold(e.protocol)} ${dim(`· it stays connected: ${CLI} disconnect ends it`)}`);
      } else if (/^Connected/.test(k.app.state)) console.log(`\n${green("●")} connected in the app: ${place(k.app.state)}`);
      else console.log(`\n${dim("○ not connected")}${k.entries.length ? dim(" · windscout connect connects you to the best of the list") : ""}`);
    }
    settle(to);
  };

  /** Ends what's running and the containers. Quitting lets a connection you asked for finish, and a test put back the one
   * you had: you stay connected. A new scan stops everything right away (an attempt gives up within a second or two). A second
   * q doesn't wait */
  const leave = async (to: "scan" | "quit") => {
    if (leaving) {
      leaveScreen();
      process.exit(130); // the exit handlers remove the containers and the route
    }
    const back = k.test?.had, making = k.phase === "connecting" && !k.test ? k.trying?.entry : null;
    leaving = true;
    message = `${to === "scan" ? "stopping, for the new scan" : back ? `quitting once you're back on ${label(back)}`
      : making ? `quitting once ${label(making)} connects (or doesn't)` : "quitting"}… (q again: right now)`;
    syncBackground();
    render();
    k.close(to === "quit");
    await running;
    await k.stopBackground();
    finish(to);
  };

  return new Promise((resolve, reject) => {
    settle = resolve;
    enterScreen();
    out.write("\x1b[22;2t\x1b[?7l"); // keep the window title to put back; no wrapping: a line wider than the terminal is cut
    input.on("keypress", onKey);
    input.on("mouse", onMouse);
    out.on("resize", onResize);
    timer = setInterval(() => (frame++, render()), 150);
    if (o.connect && selected) k.connect(selected);
    running = k.run().catch((e) => {
      finish("quit");
      reject(e);
    });
    syncBackground();
    render();
  });
}

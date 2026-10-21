// Screen 2: a running scan, live on the full screen, or as plain lines when there is no terminal.
import type { Key } from "node:readline";
import { sortOk } from "../probe.js";
import { attemptSeconds, type Scan, type ScanHooks, type Slot } from "../scan.js";
import { duration, now } from "../time.js";
import { versionLines } from "../update.js";
import { CLI, restoreFirewall } from "../windscribe.js";
import { countryName, flag } from "./country.js";
import { matrix, resultTable } from "./tables.js";
import { draw, enterScreen, input, leaveScreen, out, repoLink } from "./terminal.js";
import { bold, cyan, dim, green, red, vw, yellow } from "./text.js";
import { bar, box, centerIn } from "./widgets.js";

/** Shows a scan while it runs; close() once it's over */
export interface ScanView extends ScanHooks {
  close(): void;
}

/** Progress bar, current attempt, results so far. tab switches the table, p pauses, q stops (twice: quits).
 * blocking: we turned the firewall on for the scan */
export function showProgress(scan: Scan, blocking: boolean): ScanView {
  const { protocols, options: { timeout, speedTest } } = scan;
  let view: "ranking" | "availability" = speedTest ? "ranking" : "availability"; // tab switches
  let frame = 0;

  const render = () => {
    const rows = out.rows || 24;
    const { done, total, waiting, paused, stopping, results, finished, slots } = scan;
    const elapsed = scan.elapsed();
    // smooth bar: count the running attempts as partially done
    const partial = slots.reduce((sum, s) => sum + (s.current ? Math.min(0.95, (now() - s.attemptStart) / attemptSeconds(timeout)) : 0), 0);
    const fraction = (done + (done < total ? partial : 0)) / total;
    const eta = (total - done) * (done ? elapsed / done : attemptSeconds(timeout) / slots.length);
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame++ % 10];
    const ok = sortOk(results);
    // blocked: nothing worked, and something was really tried (a key limit tries nothing)
    const failed = finished.filter((c) => !results.some((r) => r.query === c && r.status === "ok")
      && results.some((r) => r.query === c && r.status !== "key limit"));
    const attempt = ({ current: c }: Slot) => (c ? `${flag(c.country)} ${countryName(c.country)} ${dim("·")} ${c.protocol}` : "");
    const many = slots.length > 1; // a parallel scan: a line per container

    const pct = bold(`${String(Math.floor(fraction * 100)).padStart(3)}%`);
    const stats = [
      `${dim("elapsed")} ${duration(elapsed)}`,
      `${dim("remaining")} ${done < total ? "≈ " + duration(eta) : "-"}`,
      `${green("✓")} ${ok.length} ${dim("working")}`,
      `${red("✗")} ${failed.length} ${dim("blocked")}`,
    ].join(dim("   │   "));
    const minW = Math.max(64, vw(stats) + 6); // panel and table share one width
    // results table gets whatever height the status panel and footer leave
    const version = versionLines();
    const room = Math.max(1, rows - 20 - (many ? slots.length + 1 : 2) - version.length);
    const table = view === "availability"
      ? matrix(results, protocols, { minWidth: minW, limit: room })
      : ok.length
        ? resultTable(ok.slice(0, room), speedTest, {
          caption: bold("Working so far"),
          captionRight: dim(ok.length > room ? `top ${room} of ${ok.length}` : `${ok.length} found`),
          minWidth: minW,
        })
        : [];
    const width = Math.max(minW, table.length ? vw(table[0]) : 0);
    const inner = width - 4;

    const status = stopping ? yellow(` stopping after the current attempt${many ? "s" : ""}…`)
      : waiting ? yellow(` paused · VPN disconnected${blocking ? " · firewall blocking internet" : ""} · press p to resume`)
      : "";
    const pausing = paused && !waiting && frame % 8 < 5;
    const slotLine = (s: Slot) => {
      if (!s.current) return s.step ? ` ${red("✗")} ${dim(clip(s.step, inner - 3))}` : dim(s.name ? ` · ${s.name}: after the containers` : " · idle");
      const head = ` ${cyan(spinner)} ${s.name ? dim(`${s.name}: `) : ""}${bold(attempt(s))} `, time = ` · ${duration(now() - s.attemptStart)}`;
      return head + dim(clip(s.step, inner - vw(head) - time.length) + time);
    };
    const panel = box([
      "",
      ` ${bar(fraction, inner - 8)}  ${pct}`,
      "",
      ...(many
        ? [...slots.map(slotLine), status || (pausing ? yellow(" pausing after these attempts") : "")]
        : status ? [status, ""]
        : [` ${cyan(spinner)} ${bold(attempt(slots[0]))}`,
          `   ${dim(slots[0].step)} ${dim("·")} ${duration(now() - slots[0].attemptStart)}${pausing ? yellow(" · pausing after this attempt") : ""}`]),
      null,
      centerIn(stats, inner),
    ], {
      title: bold(cyan("WindScout")),
      right: `${bold(String(done))}${dim(`/${total} attempts`)}`,
      width: inner,
    });

    const lines = [...panel];
    if (table.length) lines.push(...table);
    else lines.push("", centerIn(dim(finished.length ? "nothing has connected yet" : "results appear here after each country"), width));
    if (failed.length) {
      let txt = `${red("✗")} ${dim("no connection:")} ${failed.map((c) => `${flag(c)} ${c}`).join(" ")}`;
      while (vw(txt) > width && failed.length) txt = txt.slice(0, -8) + "…"; // ponytail: crude trim, fine for a status line
      lines.push("", centerIn(txt, width));
    }
    lines.push("", centerIn(dim(`tab ${view === "ranking" ? "availability" : "ranking"} view · p ${paused ? "resume" : "pause"} · q stop · q twice force quit`), width), "",
      ...version.map((l) => centerIn(l, width)), centerIn(dim(repoLink), width));
    draw(lines);
  };

  enterScreen();
  input.on("keypress", async (_str: string | undefined, key: Key = {}) => {
    if (key.name === "tab") {
      view = view === "ranking" ? "availability" : "ranking";
      render();
    } else if (key.name === "p" || key.name === "space") {
      scan.togglePause();
      render();
    } else if (key.name === "q" || key.name === "escape" || (key.ctrl && key.name === "c")) {
      if (scan.stopping) { // second press: bail out now
        leaveScreen();
        console.error(`stopped. the VPN may still be connecting: run '${CLI} disconnect'`);
        await restoreFirewall();
        process.exit(130);
      }
      scan.stop();
      render();
    }
  });
  out.on("resize", render);
  const timer = setInterval(render, 120);
  return {
    close() {
      clearInterval(timer);
      out.off("resize", render);
      leaveScreen();
    },
  };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s);

/** A line per attempt. Ctrl-C stops after the current attempt, a second one quits */
export function logProgress(scan: Scan): ScanView {
  const many = scan.slots.length > 1; // attempts overlap: a whole line once each is done
  process.on("SIGINT", async () => {
    if (scan.stopping) {
      await restoreFirewall();
      process.exit(130);
    }
    scan.stop();
  });
  return {
    attempt: (country, protocol) => many || process.stdout.write(`[${scan.done + 1}/${scan.total}] ${country} ${protocol} ... `),
    result: (r) => console.log([many ? `[${scan.done}/${scan.total}] ${r.query} ${r.protocol} ...` : "", r.status, r.location,
      r.speedMbps ? `${r.speedMbps.toFixed(1)} Mbps` : ""].join(" ").trim()),
    close() {},
  };
}

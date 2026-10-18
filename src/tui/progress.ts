// Screen 2: a running scan, live on the full screen, or as plain lines when there is no terminal.
import type { Key } from "node:readline";
import { sortOk } from "../probe.js";
import { attemptSeconds, type Scan, type ScanHooks } from "../scan.js";
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
    const { done, total, waiting, paused, stopping, results, finished } = scan;
    const elapsed = scan.elapsed();
    // smooth bar: count the running attempt as partially done
    const partial = waiting ? 0 : Math.min(0.95, (now() - scan.attemptStart) / attemptSeconds(timeout));
    const fraction = (done + (done < total ? partial : 0)) / total;
    const eta = (total - done) * (done ? elapsed / done : attemptSeconds(timeout));
    const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame++ % 10];
    const ok = sortOk(results);
    const failed = finished.filter((c) => !results.some((r) => r.query === c && r.status === "ok"));
    const current = scan.current ? `${flag(scan.current.country)} ${countryName(scan.current.country)}${scan.current.location ? ` · ${scan.current.location}` : ""} ${dim("·")} ${scan.current.protocol}` : "";

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
    const room = Math.max(1, rows - 22 - version.length);
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

    const panel = box([
      "",
      ` ${bar(fraction, inner - 8)}  ${pct}`,
      "",
      stopping
        ? yellow(" stopping after the current attempt…")
        : waiting ? yellow(` paused · VPN disconnected${blocking ? " · firewall blocking internet" : ""} · press p to resume`)
        : ` ${cyan(spinner)} ${bold(current)}`,
      stopping || waiting ? "" : `   ${dim(scan.step)} ${dim("·")} ${duration(now() - scan.attemptStart)}${paused && frame % 8 < 5 ? yellow(" · pausing after this attempt") : ""}`,
      null,
      centerIn(stats, inner),
    ], {
      title: bold(cyan("WindScout")),
      right: `${bold(String(done))}${dim(`/${total} attempts`)}`,
      width: inner,
    });

    const lines = [...panel];
    if (table.length) lines.push(...table);
    else lines.push("", centerIn(dim(finished.length ? "nothing has connected yet" : "results appear here after each location"), width));
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

/** A line per attempt. Ctrl-C stops after the current attempt, a second one quits */
export function logProgress(scan: Scan): ScanView {
  process.on("SIGINT", async () => {
    if (scan.stopping) {
      await restoreFirewall();
      process.exit(130);
    }
    scan.stop();
  });
  return {
    attempt: (country, protocol, location) => process.stdout.write(`[${scan.done + 1}/${scan.total}] ${country}${location ? ` · ${location}` : ""} ${protocol} ... `),
    result: (r) => console.log([r.status, r.location, r.speedMbps ? `${r.speedMbps.toFixed(1)} Mbps` : ""].join(" ").trim()),
    close() {},
  };
}

// The final report, printed to the normal screen so it stays in the scrollback.
import { sortOk, type Result } from "../probe.js";
import { CLI } from "../windscribe.js";
import { flag } from "./country.js";
import { matrix, resultTable } from "./tables.js";
import { bold, cyan, dim, fmt, green, vw, yellow } from "./text.js";
import { box, grid } from "./widgets.js";

export interface ReportOptions {
  all: boolean; // also list the attempts that failed
  speedTest: boolean; // the scan measured speed; without it, results rank by latency
}

// nickname pins the exact datacenter
export const target = (r: Result) => r.location.split(" - ").at(-1) || r.query;
export const command = (r: Result) => `${CLI} connect "${target(r)}" ${r.protocol}`;

/** Prints the report; returns the connections it numbered: the best (#0), then the others (#1…) */
export function report(results: Result[], protocols: readonly string[], { all, speedTest }: ReportOptions): Result[] {
  const ok = sortOk(results);
  const rows = [...ok, ...(all ? results.filter((r) => r.status !== "ok") : [])];
  const others = ok.slice(1).sort((x, y) => (x.latencyMs ?? Infinity) - (y.latencyMs ?? Infinity));
  // render once to learn the widest table, then again so every box lines up
  const build = (minWidth: number) => ({
    avail: matrix(results, protocols, { minWidth }),
    main: rows.length
      ? resultTable(rows, speedTest, { caption: bold("Results"), captionRight: dim(`${ok.length} working`), minWidth })
      : [],
    others: others.length
      ? grid([{ title: "#", align: "right" }, { title: "Location" }, { title: "Protocol" }, { title: "Latency", align: "right" }, { title: "Connect with" }],
        others.map((r, i) => [dim(String(i + 1)), `${flag(r.query)} ${r.location}`, r.protocol,
          r.latencyMs === null ? "-" : `${fmt(r.latencyMs, 0)} ms`, cyan(command(r))]),
        { caption: bold("Other working locations"), captionRight: dim("by latency"), minWidth })
      : [],
  });
  const first = build(0);
  const width = Math.max(64, ...[first.avail[0], first.main[0], first.others[0]].filter(Boolean).map(vw));
  const { avail, main, others: rest } = build(width);

  console.log();
  if (avail.length) console.log(avail.join("\n"));
  if (!ok.length) {
    console.log(box([yellow("Nothing connected."),
      dim("Try other countries, ports (e.g. -p stealth:443,tcp:443) or a longer --timeout.")],
    { title: bold(cyan("WindScout")), width: width - 4 }).join("\n"));
    return [];
  }
  console.log(main.join("\n"));

  const stats = protocols.map((p) => {
    const tried = results.filter((r) => r.protocol === p && r.status !== "no such location");
    const good = tried.filter((r) => r.status === "ok");
    return { p, good: good.length, tried: tried.length, best: sortOk(good).at(0) };
  }).sort((x, y) => y.good - x.good || (y.best?.speedMbps ?? 0) - (x.best?.speedMbps ?? 0) || (x.best?.latencyMs ?? 1e9) - (y.best?.latencyMs ?? 1e9));
  const bestValue = (r: Result) => (speedTest ? `${fmt(r.speedMbps, 1)} Mbps` : `${fmt(r.latencyMs, 0)} ms`);
  console.log(grid(
    [{ title: "Protocol" }, { title: "Worked", align: "right" }, { title: speedTest ? "Best speed" : "Best latency", align: "right" }, { title: "Best location" }],
    stats.map((s) => [s.p, `${s.good}/${s.tried}`, s.best ? bestValue(s.best) : "-", s.best ? `${flag(s.best.query)} ${s.best.location}` : "-"]),
    { caption: bold("Per protocol"), minWidth: width },
  ).join("\n"));
  const b = ok[0];
  const facts = [speedTest && `${fmt(b.speedMbps, 1)} Mbps`, `${fmt(b.latencyMs, 0)} ms`].filter(Boolean).join(" · ");
  console.log(box([
    `${flag(b.query)} ${bold(b.location)} over ${bold(b.protocol)} ${dim("· " + facts)}`,
    cyan(command(b)),
  ], { title: green(speedTest ? "★ Best" : "★ Best (lowest latency)"), width: width - 4 }).join("\n"));
  if (rest.length) console.log(rest.join("\n"));
  return [b, ...others];
}

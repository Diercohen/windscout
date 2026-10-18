// Result tables: the ranked attempts, and the availability grid (country × protocol).
import type { Result } from "../probe.js";
import { countryName, flag } from "./country.js";
import { bold, dim, fmt, green, red } from "./text.js";
import { grid, type Column, type GridOptions } from "./widgets.js";

const RESULT_COLS: Column[] = [
  { title: "#", align: "right" }, { title: "Country" }, { title: "Location" }, { title: "Protocol" },
  { title: "Connect", align: "right" }, { title: "Latency", align: "right" }, { title: "Speed", align: "right" }, { title: "Status" },
];
const SPEED_COL = 6;

const resultRow = (r: Result, i: number) => [
  dim(String(i + 1)),
  `${flag(r.country ?? r.query)} ${countryName(r.country ?? r.query)}`,
  r.location || "-",
  r.protocol,
  r.connectS === null ? "-" : `${fmt(r.connectS, 1)} s`,
  r.latencyMs === null ? "-" : `${fmt(r.latencyMs, 0)} ms`,
  r.speedMbps === null ? "-" : bold(`${fmt(r.speedMbps, 1)} Mbps`),
  r.status === "ok" ? green("✓ ok") : red(r.status),
];

/** Numbered attempts, in the given order; the Speed column only when the speed test ran */
export function resultTable(results: Result[], speedTest: boolean, options: GridOptions): string[] {
  const keep = (_: unknown, i: number) => speedTest || i !== SPEED_COL;
  return grid(RESULT_COLS.filter(keep), results.map((r, i) => resultRow(r, i).filter(keep)), options);
}

/** One row per country, ✓/✗ per protocol (· = not tried yet); no lines until something was tried */
export function matrix(results: Result[], protocols: readonly string[], { minWidth = 0, limit = Infinity } = {}): string[] {
  const byCountry = new Map<string, Result[]>();
  for (const r of results) {
    if (r.status === "no such location" || r.status === "interrupted") continue;
    const country = r.country ?? r.query;
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(r);
  }
  if (!byCountry.size) return [];
  const ranked = [...byCountry].map(([q, rs]) => ({ q, rs, good: rs.filter((r) => r.status === "ok").length }))
    .sort((a, b) => b.good - a.good); // stable: ties keep scan order
  const reachable = ranked.filter((c) => c.good).length;
  const rows = ranked.slice(0, limit).flatMap(({ q, rs }) => {
    // Each datacenter gets its own protocol cells, so a failed server cannot hide a working one.
    const places = [...new Set(rs.map((r) => r.location || r.query))];
    return places.map((place, i) => [
      i === 0 ? `${flag(q)} ${countryName(q)}` : "",
      place,
      ...protocols.map((p) => {
        const attempts = rs.filter((r) => (r.location || r.query) === place && r.protocol === p);
        return !attempts.length ? dim("·") : attempts.some((r) => r.status === "ok") ? green("✓") : red("✗");
      }),
    ]);
  }).slice(0, limit);
  return grid(
    [{ title: "Country" }, { title: "Location(s)" }, ...protocols.map((p): Column => ({ title: p, align: "center" }))],
    rows,
    {
      caption: bold("Availability"),
      captionRight: dim(`${reachable}/${ranked.length} countries reachable${ranked.length > limit ? ` · top ${limit}` : ""}`),
      minWidth,
      stretch: 1,
    },
  );
}

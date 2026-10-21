// Result tables: the ranked attempts, and the availability grid (country × protocol).
import type { Result } from "../probe.js";
import { countryName, flag } from "./country.js";
import { bold, dim, fmt, green, red, yellow } from "./text.js";
import { grid, type Column, type GridOptions } from "./widgets.js";

const RESULT_COLS: Column[] = [
  { title: "#", align: "right" }, { title: "Country" }, { title: "Location" }, { title: "Protocol" },
  { title: "Connect", align: "right" }, { title: "Latency", align: "right" }, { title: "Speed", align: "right" }, { title: "Status" },
];
const SPEED_COL = 6;

const resultRow = (r: Result, i: number) => [
  dim(String(i + 1)),
  `${flag(r.query)} ${countryName(r.query)}`,
  r.location || "-",
  r.protocol,
  r.connectS === null ? "-" : `${fmt(r.connectS, 1)} s`,
  r.latencyMs === null ? "-" : `${fmt(r.latencyMs, 0)} ms`,
  r.speedMbps === null ? "-" : bold(`${fmt(r.speedMbps, 1)} Mbps`),
  r.status === "ok" ? green("✓ ok") : r.status === "key limit" ? yellow(r.status) : red(r.status),
];

/** Numbered attempts, in the given order; the Speed column only when the speed test ran */
export function resultTable(results: Result[], speedTest: boolean, options: GridOptions): string[] {
  const keep = (_: unknown, i: number) => speedTest || i !== SPEED_COL;
  return grid(RESULT_COLS.filter(keep), results.map((r, i) => resultRow(r, i).filter(keep)), options);
}

/** One row per country, ✓/✗ per protocol (· = not tried yet, key limit = couldn't try WireGuard); no lines until something was tried */
export function matrix(results: Result[], protocols: readonly string[], { minWidth = 0, limit = Infinity } = {}): string[] {
  const byCountry = new Map<string, Result[]>();
  for (const r of results) {
    if (r.status === "no such location" || r.status === "interrupted") continue;
    if (!byCountry.has(r.query)) byCountry.set(r.query, []);
    byCountry.get(r.query)!.push(r);
  }
  if (!byCountry.size) return [];
  const ranked = [...byCountry].map(([q, rs]) => ({ q, rs, good: rs.filter((r) => r.status === "ok").length }))
    .sort((a, b) => b.good - a.good); // stable: ties keep scan order
  const reachable = ranked.filter((c) => c.good).length;
  const rows = ranked.slice(0, limit).flatMap(({ q, rs }) => {
    const seen = rs.find((r) => r.status === "ok") ?? rs.find((r) => r.location);
    // protocols can land on different datacenters (even cities), so list each one that connected, one per line
    const places = [...new Set(rs.filter((r) => r.status === "ok").map((r) => r.location).filter(Boolean))];
    const [first = seen?.location.split(" - ")[0] || dim("-"), ...more] = places;
    return [
      [
        `${flag(q)} ${countryName(q)}`,
        first,
        ...protocols.map((p) => {
          const r = rs.find((x) => x.protocol === p);
          return !r ? dim("·") : r.status === "ok" ? green("✓") : r.status === "key limit" ? yellow("key limit") : red("✗");
        }),
      ],
      ...more.map((place) => ["", place, ...protocols.map(() => "")]),
    ];
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

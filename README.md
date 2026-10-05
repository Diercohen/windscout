# WindScout

Find which Windscribe locations and protocols actually work from your network, ranked by speed. Runs on Linux, macOS and Windows.

WindScout drives the official `windscribe-cli`: it connects to each country × protocol pair, measures latency and download speed through the tunnel, disconnects, and prints a ranked table.

> Unofficial tool, not affiliated with Windscribe.

## Requirements

- Linux, macOS or Windows 10/11
- Node.js 20+
- The [Windscribe desktop app](https://windscribe.com/download) installed, running and logged in. It includes `windscribe-cli`, which WindScout uses to control the app. Check with `windscribe-cli status`, which should show `Logged in`. On Windows the app doesn't put the CLI on `PATH`, so run `"C:\Program Files\Windscribe\windscribe-cli.exe" status` instead. WindScout finds it there on its own.

## Install

```sh
npm install -g windscout   # or run once with: npx windscout
```

On startup, WindScout checks npm for a newer version. If there is one, it shows the command to update, both in the picker and after the final report.

## Usage

Run `windscout` with no arguments to open the interactive picker:

```
╭─ WindScout ──────────────────────────────────── 2/68 selected ─╮
│ 1 ● wireguard   2 ● stealth   3 ○ wstunnel   4 ● udp   5 ● tcp │
╰────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────────╮
│ 🔍 an▏                                              1–16 of 18 │
├─────┬──────┬───────────────────────────────────────────────────┤
│     │ Code │ Country                                           │
├─────┼──────┼───────────────────────────────────────────────────┤
│ ❯ ● │ CA   │ 🇨🇦 Canada                                         │
│   ○ │ IE   │ 🇮🇪 Ireland                                        │
│   ● │ DE   │ 🇩🇪 Germany                                        │
╰─────┴──────┴───────────────────────────────────────────────────╯
              8 attempts · estimated ≈ 3m 20s (~25s each)
```

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k`, PgUp/PgDn, Home/End | move |
| `space` | select / unselect the country |
| `/` | search by country name or code (enter/esc to finish, esc again to clear) |
| `a` / `n` | select all / unselect all (only the matching countries while a search is active) |
| `1`–`6` | toggle a protocol (`1`–`5` on Linux, which has no IKEv2) |
| `s` | toggle the speed test (off = connect-only mode) |
| `enter` | start scanning |
| `q` | quit (during a scan: stop and show partial results; press again to force quit) |

**Mouse:** click a country to select or unselect it, click a protocol or the speed-test line to toggle it, click the search box to start typing (click anywhere else to leave it), and scroll the list with the wheel. The `[ ▶ Start ]  [ All ]  [ None ]  [ Quit ]` buttons under the table do the same as their keys. This needs a terminal with mouse support, which most have. On Windows, use Windows Terminal; if clicks do nothing there, the keyboard does everything.

Your selection is saved to `~/.config/windscout/config.json` (`%USERPROFILE%\.config\windscout\config.json` on Windows) and preselected next time.

While scanning, WindScout shows a progress bar, elapsed time and remaining time. It also shows what it's doing right now (connecting, measuring latency or measuring speed). The table of working locations refreshes after each country. When the scan finishes, the final report is printed to your normal terminal.

### Non-interactive

Pass `-c` to skip the picker, for scripts or when there is no terminal:

```sh
windscout -c DE,NL,TR -p stealth,tcp:443    # chosen countries and protocols (port optional)
windscout -c Frankfurt,Wurstchen            # cities or datacenter nicknames work too
windscout -t 40 -a                          # longer connect timeout, also list failed attempts
```

| Option | Meaning | Default |
|---|---|---|
| `-c, --countries` | comma-separated ISO country codes, city names or nicknames | open the picker |
| `-p, --protocols` | comma-separated: `wireguard`, `ikev2` (macOS and Windows), `stealth`, `wstunnel`, `udp`, `tcp`, optionally `:port` | saved, or all |
| `-t, --timeout` | seconds to wait for each connection | 20 |
| `-a, --all` | include failed attempts in the final table | off |
| `-n, --no-speed` | connect-only mode: skip the download test, rank by latency | saved, or off |
| `-v, --version` | print the installed version, and the update command if a newer one is on npm | |

## Connect-only mode

Often you only need to know **what connects**, not how fast it is. Turn the speed test off with `s` in the picker or with `--no-speed`. Each working connection is then checked with a quick latency test only. That saves about 15 s per working connection, and results are ranked by latency. The choice is remembered.

Both modes show an **availability grid**: one row per country, and ✓ / ✗ for each protocol (`·` = not tried yet):

```
╭────────────────────────────────────────────────────────────────────────╮
│ Availability                                   2/3 countries reachable │
├─────────────────────────┬──────────────────┬─────────┬───────────┬─────┤
│ Country                 │ City             │ stealth │ wireguard │ tcp │
├─────────────────────────┼──────────────────┼─────────┼───────────┼─────┤
│ 🇩🇪 Germany              │ Frankfurt        │    ✓    │     ✓     │  ✓  │
│ 🇳🇱 Netherlands          │ Amsterdam        │    ✓    │     ✓     │  ·  │
│ 🇦🇪 United Arab Emirates │ Dubai            │    ✗    │     ✗     │  ✗  │
╰─────────────────────────┴──────────────────┴─────────┴───────────┴─────╯
```

While scanning, press `tab` to switch between the availability grid and the speed or latency ranking. In connect-only mode the scan starts on the availability grid.

## Output

While scanning:

```
╭─ WindScout ─────────────────────────────────────────── 4/6 attempts ─╮
│                                                                      │
│  ██████████████████████████████████████████▌░░░░░░░░░░░░░░░░   72%   │
│                                                                      │
│  ⠏ 🇳🇱 Netherlands · stealth                                          │
│    measuring speed · Amsterdam - Tulip · 3s                          │
├──────────────────────────────────────────────────────────────────────┤
│  elapsed 25s   │   remaining ≈ 13s   │   ✓ 2 working   │   ✗ 1 blocked │
╰──────────────────────────────────────────────────────────────────────╯
╭──────────────────────────────────────────────────────────────────────╮
│ Working so far                                               2 found │
├───┬────────────┬───────────────────────┬───────────┬───────────┬─────┤
│ # │ Country    │ Location              │ Protocol  │     Speed │ ... │
```

At the end, the results, a per-protocol summary and the best pick are printed to your normal terminal:

```
╭─ ★ Best ─────────────────────────────────────────────────╮
│ 🇳🇱 Amsterdam - Tulip over wireguard · 27.0 Mbps · 109 ms │
│ windscribe-cli connect "Tulip" wireguard                 │
╰──────────────────────────────────────────────────────────╯
```

## Notes

- **Connecting by country picks a random datacenter.** A single run tests one per country. Pass city names or nicknames with `-c` to test specific datacenters.
- **The country list is built in.** On v2.24, `windscribe-cli locations` returns nothing, so WindScout uses a fixed list of country codes. Codes Windscribe doesn't serve are skipped quickly.
- **A full scan takes a while.** The worst case is countries × protocols × timeout. Narrow it with `-c` and `-p`.
- **Your connection changes during the scan.** WindScout connects and disconnects the VPN repeatedly, so don't run it while you need a stable connection.

## License

MIT

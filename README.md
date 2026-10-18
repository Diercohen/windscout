# WindScout

Find which Windscribe locations and protocols actually work from your network, ranked by speed. Runs on Linux, macOS and Windows.

WindScout drives the official `windscribe-cli`: it expands each selected country into named datacenters, connects to each datacenter × protocol pair, measures latency and download speed through the tunnel, disconnects, and prints a ranked table.

![WindScout picking countries, scanning, and printing the availability grid and ranked results](demo.gif)

> Unofficial tool, not affiliated with Windscribe.

## Requirements

- Linux, macOS or Windows 10/11
- Node.js 20+
- The [Windscribe desktop app](https://windscribe.com/download) installed, running and logged in. It includes `windscribe-cli`, which WindScout uses to control the app. Check with `windscribe-cli status`, which should show `Logged in`. On Windows the app doesn't put the CLI on `PATH`, so run `"C:\Program Files\Windscribe\windscribe-cli.exe" status` instead. WindScout finds it there on its own.

## Install

```sh
npm install -g windscout   # or run once with: npx windscout
```

On startup, WindScout checks npm for a newer version. Above the repository link at the bottom of the screen, it shows the installed version in grey (`windscout 0.5.6 · latest` once npm confirms nothing newer is out), or, when a newer one is out, an update notice in yellow. In the picker, press `u` to update and restart on the new version. The update runs `npm install -g windscout@latest`, with `sudo` when your global npm folder belongs to root (sudo then asks for your password). The update command is also printed after the final report.

## Usage

Run `windscout` with no arguments to open the interactive picker:

```
╭─ WindScout ──────────────────────────────────── 2/68 selected ─╮
│ 1 ● wireguard   2 ● stealth   3 ○ wstunnel   4 ● udp   5 ● tcp │
│ s ○ speed test  off: connect-only, ranks by latency            │
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
| `f` | toggle "block internet while scanning" (firewall) |
| `u` | update to the newer version and restart (only when the picker shows one is out) |
| `enter` | start scanning |
| `q` | quit (during a scan: stop and show partial results; press again to force quit) |

**Mouse:** click a country to select or unselect it, click a protocol or the speed-test line to toggle it, click the search box to start typing (click anywhere else to leave it), and scroll the list with the wheel. The `[ ▶ Start ]  [ All ]  [ None ]  [ Quit ]` buttons under the table do the same as their keys; the shortcut key is underlined on screen (on the buttons, the protocol numbers and `s`). This needs a terminal with mouse support, which most have. On Windows, use Windows Terminal; if clicks do nothing there, the keyboard does everything.

Your selection is saved to `~/.config/windscout/config.json` (`%USERPROFILE%\.config\windscout\config.json` on Windows) and preselected next time.

Selecting a country scans every named datacenter in its location catalog. For example, selecting **US** tests locations such as **New York - Empire**, **Los Angeles - Lamar** and **Salt Lake City - Missionary** separately, over each selected protocol. The picker shows location counts beside countries, and its attempt count and time estimate include all those locations.

Use `-l 5` (or `--limit 5`) to test at most five distinct locations **per country**. The limit follows catalog order, and every selected protocol is still tried at each chosen location. Countries with fewer locations are scanned once each without repeats. Omitting `-l` tests all catalog locations. The limit also applies to known nicknames in `-c`; a city or unknown nickname keeps the CLI's direct lookup behavior. The limit is per run and is not saved in the picker settings.

While scanning, WindScout shows a progress bar, elapsed time and remaining time. It also shows what it's doing right now (connecting, measuring latency or measuring speed). The table of working locations refreshes as each datacenter is tested. When the scan finishes, the final report is printed to your normal terminal. It ends with the best connection and the other working ones, each with its `windscribe-cli connect` command; type a number at the prompt to connect to it.

### Non-interactive

Pass `-c` to skip the picker, for scripts or when there is no terminal:

```sh
windscout -c DE,NL,TR -p stealth,tcp:443    # chosen countries and protocols (port optional)
windscout -c US -p wireguard -n             # all US datacenters, connect-only
windscout -c US,DE -l 5 -p wireguard -n      # at most 5 locations per country (up to 10 attempts)
windscout -l 5                              # picker with capped counts and estimates
windscout -c Frankfurt,Wurstchen            # cities or datacenter nicknames work too
windscout -c Empire,Lamar,Missionary -n      # only these specific datacenters
windscout -t 40 -a                          # longer connect timeout, also list failed attempts
```

| Option | Meaning | Default |
|---|---|---|
| `-c, --countries` | comma-separated ISO country codes (all catalog datacenters), city names or specific nicknames | open the picker |
| `-p, --protocols` | comma-separated: `wireguard`, `ikev2` (macOS and Windows), `stealth`, `wstunnel`, `udp`, `tcp`, optionally `:port` | saved, or all |
| `-t, --timeout` | seconds to wait for each connection, at least 10 | picker: saved, or 15; with `-c`: 15 |
| `-l, --limit` | maximum distinct locations per country; positive whole number | all locations |
| `-a, --all` | include failed attempts in the final table | off |
| `-n, --no-speed` | connect-only mode: skip the download test, rank by latency | picker: saved, or connect-only on first run; with `-c`: speed test on |
| `-f, --firewall` | block internet while scanning, except through the VPN | picker: saved, or off; with `-c`: off |
| `-v, --version` | print the installed version; if a newer one is on npm, show the update command (with `sudo` when needed) and ask (y/n) to run it | |

## Connect-only mode

Often you only need to know **what connects**, not how fast it is. Turn the speed test off with `s` in the picker or with `--no-speed`. Each working connection is then checked with a quick latency test only. That saves about 15 s per working connection, and results are ranked by latency. Connect-only is the default on the first run, and the choice is remembered.

Both modes show an **availability grid** grouped by country, with a separate row per datacenter and ✓ / ✗ for each protocol (`·` = not tried yet). A failure at one datacenter does not mark the others as failed:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ Availability                                         2/3 countries reachable │
├─────────────────────────┬────────────────────────┬─────────┬───────────┬─────┤
│ Country                 │ Location(s)            │ stealth │ wireguard │ tcp │
├─────────────────────────┼────────────────────────┼─────────┼───────────┼─────┤
│ 🇩🇪 Germany              │ Frankfurt - Castle     │    ✓    │     ✓     │  ✓  │
│                         │ Frankfurt - Wurst      │    ✗    │     ✓     │  ✗  │
│ 🇳🇱 Netherlands          │ Amsterdam - Tulip      │    ✓    │     ✓     │  ·  │
│ 🇦🇪 United Arab Emirates │ Dubai                  │    ✗    │     ✗     │  ✗  │
╰─────────────────────────┴────────────────────────┴─────────┴───────────┴─────╯
```

While scanning, press `tab` to switch between the availability grid and the speed or latency ranking. Press `p` (or `space`) to pause: the current attempt finishes, the VPN disconnects, and the scan waits until you press `p` again. Paused time doesn't count toward elapsed or remaining. In connect-only mode the scan starts on the availability grid.

## Block internet while scanning (firewall)

Between attempts the VPN is disconnected for a moment, and apps on your computer (browser, messengers, updates) can go online over your real connection. Turn on **block internet while scanning** with `f` in the picker or `--firewall`, and WindScout switches on the Windscribe app's firewall for the scan: nothing gets online except through the VPN. When the scan ends or you stop it, the firewall goes back off (if you already had it on, WindScout leaves it on). While a scan is paused, the firewall keeps blocking.

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

- **Countries expand into individual datacenters.** WindScout uses each datacenter's nickname so a country scan tests multiple distinct locations, rather than asking Windscribe to choose one. City names and nicknames passed with `-c` retain their direct CLI lookup behavior; use nicknames to pin individual datacenters. Duplicate nickname targets are scanned once.
- **Location discovery works offline.** Before scanning, WindScout tries Windscribe's [public location catalog](https://assets.windscribe.com/serverlist/mob-v2/1/0), with a four-second timeout. If it is unreachable or invalid, it uses the bundled snapshot of 200 datacenters across 72 countries (52 US locations), retrieved on 2026-10-18 from a [mirror of that catalog](https://github.com/tn3w/Windscribe-IPs). A country absent from the catalog falls back to the original country lookup. The list can include Pro locations; your Windscribe account determines which ones can connect.
- **The country list is built in.** On v2.24, `windscribe-cli locations` returns nothing, so WindScout uses a fixed list of country codes. Codes Windscribe doesn't serve are skipped quickly.
- **A full scan takes a while.** The worst case is datacenters × protocols × timeout. Narrow it with specific nicknames in `-c` and fewer protocols in `-p`.
- **No flags in macOS Terminal.** Terminal.app draws flag emoji wider than their space, which pushes table borders out of line, so WindScout leaves them out there (as on Windows). iTerm2 and other terminals show them.
- **Your connection changes during the scan.** WindScout connects and disconnects the VPN repeatedly, so don't run it while you need a stable connection.

## Development

The source is TypeScript in `src/`. It compiles to `dist/`, which is what gets published.

```sh
npm install
npm run build       # compile src/ to dist/ (the windscout command is dist/cli.js)
npm test            # build and run regression tests (Node.js 22.3+ for module mocking)
node dist/cli.js    # run your build; takes the same options as windscout
./publish.sh        # build, install the packed tarball to check it runs, publish to npm (bump the version first)
```

To run a local build, use `node dist/cli.js -c US -l 5 -p wireguard -n` after building. The published `npx windscout` package and the picker's npm update action install the npm release, which may not include local changes.

## License

MIT

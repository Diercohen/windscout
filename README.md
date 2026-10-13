# WindScout

Find which Windscribe locations and protocols actually work from your network, ranked by speed. Runs on Linux, macOS and Windows.

WindScout drives the official `windscribe-cli`: it connects to each country × protocol pair, measures latency and download speed through the tunnel, disconnects, and prints a ranked table.

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

On startup, WindScout checks npm for a newer version. If there is one, it shows the command to update, both in the picker and after the final report.

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
| `enter` | start scanning |
| `q` | quit (during a scan: stop and show partial results; press again to force quit) |

**Mouse:** click a country to select or unselect it, click a protocol or the speed-test line to toggle it, click the search box to start typing (click anywhere else to leave it), and scroll the list with the wheel. The `[ ▶ Start ]  [ All ]  [ None ]  [ Quit ]` buttons under the table do the same as their keys; the shortcut key is underlined on screen (on the buttons, the protocol numbers and `s`). This needs a terminal with mouse support, which most have. On Windows, use Windows Terminal; if clicks do nothing there, the keyboard does everything.

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
| `-t, --timeout` | seconds to wait for each connection, at least 10 | picker: saved, or 20; with `-c`: 20 |
| `-a, --all` | include failed attempts in the final table | off |
| `-n, --no-speed` | connect-only mode: skip the download test, rank by latency | picker: saved, or connect-only on first run; with `-c`: speed test on |
| `-f, --firewall` | block internet while scanning, except through the VPN | picker: saved, or off; with `-c`: off |
| `-v, --version` | print the installed version, and the update command if a newer one is on npm | |

## Connect-only mode

Often you only need to know **what connects**, not how fast it is. Turn the speed test off with `s` in the picker or with `--no-speed`. Each working connection is then checked with a quick latency test only. That saves about 15 s per working connection, and results are ranked by latency. Connect-only is the default on the first run, and the choice is remembered.

Both modes show an **availability grid**: one row per country, and ✓ / ✗ for each protocol (`·` = not tried yet). Location(s) lists each datacenter that connected, one per line, since protocols can land on different ones:

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ Availability                                         2/3 countries reachable │
├─────────────────────────┬────────────────────────┬─────────┬───────────┬─────┤
│ Country                 │ Location(s)            │ stealth │ wireguard │ tcp │
├─────────────────────────┼────────────────────────┼─────────┼───────────┼─────┤
│ 🇩🇪 Germany              │ Frankfurt - Castle     │    ✓    │     ✓     │  ✓  │
│                         │ Frankfurt - Wurst      │         │           │     │
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

- **Connecting by country picks a random datacenter.** A single run tests one per country and protocol, so different protocols may land on different datacenters. Pass city names or nicknames with `-c` to test specific datacenters.
- **The country list is built in.** On v2.24, `windscribe-cli locations` returns nothing, so WindScout uses a fixed list of country codes. Codes Windscribe doesn't serve are skipped quickly.
- **A full scan takes a while.** The worst case is countries × protocols × timeout. Narrow it with `-c` and `-p`.
- **No flags in macOS Terminal.** Terminal.app draws flag emoji wider than their space, which pushes table borders out of line, so WindScout leaves them out there (as on Windows). iTerm2 and other terminals show them.
- **Your connection changes during the scan.** WindScout connects and disconnects the VPN repeatedly, so don't run it while you need a stable connection.

## Development

The source is TypeScript in `src/`. It compiles to `dist/`, which is what gets published.

```sh
npm install
npm run build       # compile src/ to dist/ (the windscout command is dist/cli.js)
node dist/cli.js    # run your build; takes the same options as windscout
./publish.sh        # build, install the packed tarball to check it runs, publish to npm (bump the version first)
```

## License

MIT

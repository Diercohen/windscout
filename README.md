# WindScout

Find which Windscribe locations and protocols actually work from your network, ranked by speed. Runs on Linux, macOS and Windows.

WindScout drives the official `windscribe-cli`: it connects to each country × protocol pair, measures latency and download speed through the tunnel, disconnects, and prints a ranked table.

![WindScout picking countries, scanning, and printing the availability grid and ranked results](demo.gif)

> Unofficial tool, not affiliated with Windscribe.

## Requirements

- Linux, macOS or Windows 10/11
- Node.js 20+
- The [Windscribe desktop app](https://windscribe.com/download) installed, running and logged in. It includes `windscribe-cli`, which WindScout uses to control the app. Check with `windscribe-cli status`, which should show `Logged in`. On Windows the app doesn't put the CLI on `PATH`, so run `"C:\Program Files\Windscribe\windscribe-cli.exe" status` instead. WindScout finds it there on its own.
- Optional, for [parallel scans](#parallel-scan-with-docker): Docker. WindScout offers to install it.

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
| `r` | toggle random order: scan the selected countries shuffled, a new order each run |
| `d` | toggle the [parallel scan in docker containers](#parallel-scan-with-docker) (installs or starts docker first, after asking) |
| `u` | update to the newer version and restart (only when the picker shows one is out) |
| `enter` | start scanning |
| `q` | quit (during a scan: stop and show partial results; press again to force quit) |

**Mouse:** click a country to select or unselect it, click a protocol or the speed-test line to toggle it, click the search box to start typing (click anywhere else to leave it), and scroll the list with the wheel. The `[ ▶ Start ]  [ All ]  [ None ]  [ Quit ]` buttons under the table do the same as their keys; the shortcut key is underlined on screen (on the buttons, the protocol numbers and `s`). This needs a terminal with mouse support, which most have. On Windows, use Windows Terminal; if clicks do nothing there, the keyboard does everything.

Your selection is saved to `~/.config/windscout/config.json` (`%USERPROFILE%\.config\windscout\config.json` on Windows) and preselected next time.

While scanning, WindScout shows a progress bar, elapsed time and remaining time. It also shows what it's doing right now (connecting, measuring latency or measuring speed). The table of working locations refreshes after each country. When the scan finishes, the final report is printed to your normal terminal. It ends with the best connection and the other working ones, each with its `windscribe-cli connect` command. At the prompt, press enter to connect to the best one, type another one's number to connect to that, or `q` to quit.

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
| `-t, --timeout` | seconds to wait for each connection, at least 10 | picker: saved, or 15; with `-c`: 15 |
| `-a, --all` | include failed attempts in the final table | off |
| `-n, --no-speed` | connect-only mode: skip the download test, rank by latency | picker: saved, or connect-only on first run; with `-c`: speed test on |
| `-f, --firewall` | block internet while scanning, except through the VPN | picker: saved, or off; with `-c`: off |
| `-r, --random` | scan the countries in a random order | picker: saved, or off; with `-c`: off |
| `-d, --docker` | [scan in parallel, in docker containers](#parallel-scan-with-docker) | picker: saved, or off; with `-c`: off |
| `-v, --version` | print the installed version; if a newer one is on npm, show the update command (with `sudo` when needed) and ask (y/n) to run it | |

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

## Parallel scan with Docker

A normal scan tries one location at a time, because your computer has one VPN connection. Turn on **parallel scan** with `d` in the picker or `--docker`, and each attempt runs in its own docker container instead. Each container has its own Windscribe app (Windscribe's Linux CLI app) and so its own VPN connection, and several locations are tried at once. The results come back to the scan screen, which shows a line per container.

**How many containers:** one per attempt, as many as docker's CPUs allow and three quarters of its memory (at 250 MB each), at most 8. The picker shows the number (`8 at a time`) and the estimate that goes with it.

**First time:** if docker isn't installed or isn't running, `d` (or a scan with `--docker`) opens a dialog that says what WindScout will do, and does it once you agree:

- **macOS:** downloads Docker Desktop from docker.com (about 600 MB), installs it in `/Applications` with its license accepted, and starts it.
- **Linux:** runs Docker's install script from get.docker.com (or, where docker.com refuses, installs your distribution's own docker package), adds you to the `docker` group and starts docker. The group takes effect in a new login session: log out and back in (or run `newgrp docker`), then start WindScout again. Members of the `docker` group can control docker, which is as good as root.
- **Windows:** installs Docker Desktop with winget, with its license accepted and its WSL 2 engine, and starts it. Windows asks for permission, and may want a restart. Docker Desktop may also ask to install or update WSL: do what it asks, then try again. If Docker Desktop is set to Windows containers, switch it to Linux containers (right-click its icon by the clock).

Steps that need root ask for your password in the dialog. WindScout checks it with `sudo` once, so a typo counts as one failed try. It keeps the password in memory until the steps are done and never saves it. Docker Desktop is free for personal use, education and small businesses; bigger companies need a [paid plan](https://www.docker.com/pricing/).

Then the first parallel scan builds a local image, `windscout-worker`, with Node and Windscribe's Linux CLI app (the latest stable release on [GitHub](https://github.com/Windscribe/Desktop-App/releases)). That takes a few minutes. Later scans reuse it until WindScout updates.

**In Iran (and other places docker.com refuses):** Docker Hub and docker.com refuse Iranian addresses (US sanctions), so every download falls back to mirrors in Iran when the official source refuses or doesn't answer. Everywhere else, the official sources are used as before:

- **The image's base** (`node:22-bookworm-slim`) comes from Docker Hub, else from the first mirror of it that answers: `registry.docker.ir`, `docker.iranserver.com`, `docker.kernel.ir`, `mirror2.chabokan.net`, `docker-mirror.liara.ir`, `hub.hamdocker.ir`, `docker.arvancloud.ir`, `focker.ir`, `docker.mobinhost.com`, `mirror-docker.runflare.com`. It's pinned by digest, so a mirror can only hand over that exact image. To try other mirrors first, list them in `WINDSCOUT_REGISTRY_MIRRORS` (comma-separated hosts).
- **Debian's packages** in the image come from deb.debian.org, else `mirror.shatel.ir`, `mirror.iranserver.com`, `mirror.mobinhost.com` or `mirror2.chabokan.net`. apt checks Debian's signatures, whichever mirror serves them.
- **Windscribe's app** in the image comes from GitHub, which Iran can reach.
- **Docker on Linux:** where get.docker.com refuses, your distribution's own docker package is installed instead, from the mirrors your system already uses.
- **Docker Desktop on macOS and Windows** has no mirror anywhere: when docker.com refuses the download, the dialog says so. Connect a VPN (Windscribe will do), then press Retry. That's needed once, for the install.

The mirrors come from [Mirava](https://github.com/MiravaOrg/Mirava)'s list of mirrors in Iran; they come and go, and that's where to look for new ones.

**Kernel check:** each container first checks that docker's Linux kernel gives it what Windscribe needs: a tunnel device (tun) and a firewall (nftables). If not, the scan stops and says so, rather than showing every location as blocked. Windscribe's WireGuard also needs nftables' `fib` in its firewall table, which Docker Desktop's own Linux VM lacks (on macOS, and on Windows without WSL 2). There, WireGuard runs on this computer instead (see below).

**Login:** each container's Windscribe app logs in once. WindScout asks for your Windscribe username and password (and a 2FA code or captcha when Windscribe asks for one) and passes them to the containers, one at a time. Each login is kept in that container's docker volume (`windscout-1`, `windscout-2`, …), so later scans don't ask.

**Remember username and password** is ticked to start with (tab to it and press space, or click it). Once the login works, WindScout saves both in `~/.config/windscout/login.json`, as plain text that only you can read. Then containers that are new next time (a scan with more attempts) log in by themselves, with no terminal too; a 2FA code is never saved, so with 2FA they still ask. Untick it and nothing is saved, and a login saved before is forgotten. Deleting that file forgets it too. With `-c` and no terminal, only containers that are logged in already, or can log in with the remembered login, take part.

**Measuring:** the containers share your internet connection, so they take turns measuring latency and speed while the connecting happens in parallel. Numbers stay comparable with a normal scan. Most of the time saved comes from attempts that hang until the timeout, which overlap now.

**Differences from a normal scan:**

- IKEv2, and WireGuard when the kernel check finds it can't run in the containers, are tried on this computer once the containers are done, one at a time like a normal scan. The scan screen shows them on a line of their own (`this computer`), and the picker's estimate counts them. Windscribe's Linux app has no IKEv2.
- This computer's own Windscribe connection is disconnected at the start and stays off while the containers scan, since it would carry their traffic too.
- No firewall: "block internet while scanning" isn't used, since it would block the containers' traffic too.

The containers are removed after the scan. To remove the logins too, run `docker volume rm windscout-1 windscout-2 …`. To remove the image, run `docker rmi windscout-worker`.

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
- **Your connection changes during the scan.** WindScout connects and disconnects the VPN repeatedly, so don't run it while you need a stable connection. A [parallel scan](#parallel-scan-with-docker) does that inside its containers instead, and your computer's own VPN stays off.

## Development

The source is TypeScript in `src/`. It compiles to `dist/`, which is what gets published.

```sh
npm install
npm run build       # compile src/ to dist/ (the windscout command is dist/cli.js)
npm test            # build, then check the scan's scheduling (no VPN, no docker)
node dist/cli.js    # run your build; takes the same options as windscout
./publish.sh        # build, install the packed tarball to check it runs, publish to npm (bump the version first)
```

## License

MIT

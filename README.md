# WindScout

Find which Windscribe locations and protocols actually work from your network, ranked by speed. Runs on Linux, macOS and Windows.

WindScout drives the official `windscribe-cli`: it connects to each country × protocol pair, measures latency and download speed through the tunnel, disconnects, and prints a ranked table. Then the [results screen](#results-screen-connect-test-again-stay-connected) stays open: connect to one, test them all again, and let WindScout keep you connected.

![WindScout picking countries, scanning, and printing the availability grid and ranked results](demo.gif)

> Unofficial tool, not affiliated with Windscribe.

## Requirements

- Linux, macOS or Windows 10/11
- Node.js 20+
- The [Windscribe desktop app](https://windscribe.com/download) installed, running and logged in. It includes `windscribe-cli`, which WindScout uses to control the app. Check with `windscribe-cli status`, which should show `Logged in`. Any recent version works: 2.25 reworded that status (`Connection:` instead of `Connect state:`, among others), and WindScout reads both wordings. On Windows the app doesn't put the CLI on `PATH`, so run `"C:\Program Files\Windscribe\windscribe-cli.exe" status` instead. WindScout finds it there on its own.
- Optional, for [parallel scans](#parallel-scan-with-docker): Docker. WindScout offers to install it.

## Install

```sh
npm install -g windscout   # or run once with: npx windscout
```

On startup, WindScout checks npm for a newer version. Above the repository link at the bottom of the screen, it shows the installed version in grey (`windscout 0.5.6 · latest` once npm confirms nothing newer is out), or, when a newer one is out, an update notice in yellow. In the picker, press `u` to update and restart on the new version. The update runs `npm install -g windscout@latest`, with `sudo` when your global npm folder belongs to root (sudo then asks for your password). The update command is also printed after the final report.

### In a sandbox (Docker)

To run WindScout without installing it or Node on your computer, run it in a container. The container has its own Windscribe app (Windscribe's Linux CLI app) and, for [parallel scans](#parallel-scan-with-docker), its own docker daemon inside it (Docker-in-Docker). You need Docker: on Linux, docker itself; on macOS and Windows, [Docker Desktop](https://docs.docker.com/desktop/) (on Windows with its WSL 2 engine, set to Linux containers). Build the image once, the same way on every system. Docker fetches this repository from GitHub itself, so there's nothing to clone (add `#` and a branch, tag or commit to the URL to build that one, as in `windscout.git#main`; in a clone, use `.` in place of the URL to build your copy):

```sh
docker build -t windscout-sandbox -f sandbox/Dockerfile https://github.com/Diercohen/windscout.git
```

Then run it with the command for your system, below. If the Windscribe app on your computer is logged in, the container's app logs in with that app's session, as the [parallel scan's containers](#parallel-scan-with-docker) do: the command hands it to the container in a file mounted read-only, and the container copies only the session (`userId` and `authHash`) into its own app's settings. Without the app, or when its session doesn't work, the container asks for your Windscribe username and password (and 2FA code, if you use one), and the `windscout-home` volume keeps that login for the next runs. Then the picker opens as usual. Options after the image name go to WindScout: `windscout-sandbox -c "DE,NL" -d`. The `windscout-docker` volume keeps the inner docker's `windscout-worker` image and its containers' volumes, so only the first parallel scan builds them.

**Linux:** the app's settings file is mounted as it is (read-only, never changed). Without the Windscribe app, leave out the `Windscribe2.conf` line: otherwise docker creates an empty folder in its place.

```sh
docker run -it --rm --privileged \
  -v ~/.config/Windscribe/Windscribe2.conf:/host/Windscribe2.conf:ro \
  -v windscout-home:/home/ws -v windscout-docker:/var/lib/docker \
  windscout-sandbox
```

**macOS** (Terminal): the app keeps its session in its defaults, so the first line writes it to a private temporary file, which the last line deletes after the run.

```sh
s=$(mktemp) && printf '[General]\nuserId=%s\nauthHash=%s\n' "$(defaults read com.windscribe.Windscribe2 userId)" "$(defaults read com.windscribe.Windscribe2 authHash)" > "$s"
docker run -it --rm --privileged \
  -v "$s:/host/Windscribe2.conf:ro" \
  -v windscout-home:/home/ws -v windscout-docker:/var/lib/docker \
  windscout-sandbox
rm -f "$s"
```

**Windows** (PowerShell): the app keeps its session in the registry, so the first lines write it to a private temporary file, which the last line deletes after the run.

```powershell
$k = Get-ItemProperty HKCU:\Software\Windscribe\Windscribe2
$s = New-TemporaryFile
Set-Content $s "[General]`nuserId=$($k.userId)`nauthHash=$($k.authHash)"
docker run -it --rm --privileged `
  -v "$($s.FullName):/host/Windscribe2.conf:ro" `
  -v windscout-home:/home/ws -v windscout-docker:/var/lib/docker `
  windscout-sandbox
Remove-Item $s
```

Without the Windscribe app on macOS or Windows, run only the `docker run` command, without its `Windscribe2.conf` line.

- `--privileged` is needed: the inner docker, and the Windscribe app's tunnel and firewall, need it. It gives the container broad control of docker's Linux kernel (on Linux, your computer's), so this isolates files and installs, not security. VPN connections stay inside the container: your computer's own connection doesn't change.
- Docker Desktop's own Linux VM (macOS, Windows without WSL 2) can't run Windscribe's WireGuard (see the kernel check under [parallel scans](#parallel-scan-with-docker)), and in the sandbox that goes for its own app too. Windscribe's Linux app has no IKEv2, so the sandbox doesn't try it.
- Where Docker Hub refuses (Iran), take the base image from a mirror: `docker build --build-arg BASE=registry.docker.ir/library/node:22-bookworm-slim -t windscout-sandbox -f sandbox/Dockerfile https://github.com/Diercohen/windscout.git`
- Updating from inside (`u`) doesn't last, since each run starts fresh from the image: run the build command again instead, for the latest WindScout; add `--no-cache` to get the latest Windscribe app too.
- To remove everything: `docker rmi windscout-sandbox` and `docker volume rm windscout-home windscout-docker`.

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
| `p` | toggle [all ports](#all-ports): each protocol on every port it has, not just its default |
| `s` | toggle the speed test (off = connect-only mode) |
| `f` | toggle "block internet while scanning" (firewall) |
| `d` | toggle the [parallel scan in docker containers](#parallel-scan-with-docker) (installs or starts docker first, after asking) |
| `o` | change the [scanning type](#scanning-type): default, by random country, by last success result first, only the last results |
| `w` | toggle [stop at the first working connection](#stop-at-the-first-working-connection) that holds up |
| `h` | type how many seconds each working connection has to [hold up](#stop-at-the-first-working-connection) for `w` (enter/esc to finish) |
| `u` | update to the newer version and restart (only when the picker shows one is out) |
| `enter` | start scanning |
| `q` | quit (during a scan: stop and show partial results; press again to force quit) |

**Mouse:** click a country to select or unselect it, click a protocol or a setting's line to toggle it (the scanning type's line changes the type), click the search box to start typing (click anywhere else to leave it), and scroll the list with the wheel. The `[ ▶ Start ]  [ All ]  [ None ]  [ Quit ]` buttons under the table do the same as their keys; the shortcut key is underlined on screen (on the buttons, the protocol numbers and `s`). This needs a terminal with mouse support, which most have. On Windows, use Windows Terminal; if clicks do nothing there, the keyboard does everything.

Your selection is saved to `~/.config/windscout/config.json` (`%USERPROFILE%\.config\windscout\config.json` on Windows) and preselected next time.

After you start, the Start button spins (`[ ⠋ Starting… ]`) until the scan's screen shows, which can take a moment when it turns the firewall on or starts docker. While scanning, WindScout shows a progress bar, elapsed time and remaining time. It also shows what it's doing right now (connecting, measuring latency or measuring speed). The table of working locations refreshes after each country. When the scan finishes, the final report is printed to your normal terminal. It ends with the best connection and the other working ones, each with its `windscribe-cli connect` command. Then the [results screen](#results-screen-connect-test-again-stay-connected) opens over it, and WindScout stays open until you quit. The report is still there in your terminal afterwards.

### Non-interactive

Pass `-c` to skip the picker, for scripts or when there is no terminal:

```sh
windscout -c DE,NL,TR -p stealth,tcp:443    # chosen countries and protocols (port optional)
windscout -c Frankfurt,Wurstchen            # cities or datacenter nicknames work too
windscout -c DE -p stealth,tcp -P           # every port of stealth and tcp
windscout -t 40 -a                          # longer connect timeout, also list failed attempts
```

| Option | Meaning | Default |
|---|---|---|
| `-c, --countries` | comma-separated ISO country codes, city names or nicknames | open the picker |
| `-p, --protocols` | comma-separated: `wireguard`, `ikev2` (macOS and Windows), `stealth`, `wstunnel`, `udp`, `tcp`, optionally `:port` | saved, or all |
| `-P, --all-ports` | try each protocol on [every port](#all-ports) Windscribe offers for it, not just its default | picker: saved, or off; with `-c`: off |
| `-t, --timeout` | seconds to wait for each connection, at least 10 | picker: saved, or 15; with `-c`: 15 |
| `-a, --all` | include failed attempts in the final table | off |
| `-n, --no-speed` | connect-only mode: skip the download test, rank by latency | picker: saved, or connect-only on first run; with `-c`: speed test on |
| `-f, --firewall` | block internet while scanning, except through the VPN | picker: saved, or off; with `-c`: off |
| `-o, --order` | [scanning type](#scanning-type): `default`, `random`, `last-first` or `last-only` (`-r` still works: the same as `-o random`) | picker: saved, or `default`; with `-c`: `default` |
| `-w, --stop-at-first` | [stop at the first working connection](#stop-at-the-first-working-connection) that holds up | picker: saved, or off; with `-c`: off |
| `-H, --hold` | with `-w`: seconds each working connection has to [hold up](#stop-at-the-first-working-connection), at least 10 | picker: saved, or 30; with `-c`: 30 |
| `-d, --docker` | [scan in parallel, in docker containers](#parallel-scan-with-docker) | picker: saved, or off; with `-c`: off |
| `-v, --version` | print the installed version; if a newer one is on npm, show the update command (with `sudo` when needed) and ask (y/n) to run it | |

Without a terminal, WindScout prints the report and exits, with no results screen.

## Results screen: connect, test again, stay connected

In a terminal, the scan's working connections stay on screen after the report, best first:

```
╭─ WindScout ─────────────────────────────────────────────────── 4 working · scanned 2m ago ─╮
│                                                                                            │
│    ● CONNECTED   🇳🇱 Amsterdam - Canal over stealth:443                                     │
│   up 12m 07s · 106 ms ▄██▁▂▁ · IP 185.x.x.x · connected again 1×                           │
│                                                                                            │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│  ◉ watch on · when this connection drops, windscout connects you to the next best          │
│  ◉ background checks · 3 of 3 worked 2m ago · next in 3m 00s                               │
╰────────────────────────────────────────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────────────────────────────────────────╮
│ Working connections                                               by speed · o: by latency │
├─────┬─────────────────────────────┬─────────────┬─────────┬───────────┬────────────────────┤
│   # │ Location                    │ Protocol    │ Latency │     Speed │ Status             │
├─────┼─────────────────────────────┼─────────────┼─────────┼───────────┼────────────────────┤
│ ❯ 1 │ 🇩🇪 Frankfurt - Castle       │ wireguard   │  105 ms │ 48.2 Mbps │ ✓ 2m ago           │
│   2 │ 🇳🇱 Amsterdam - Canal        │ stealth:443 │  107 ms │ 31.7 Mbps │ ● connected        │
│   3 │ 🇹🇷 Istanbul - Bosphorus     │ tcp:443     │   61 ms │ 12.4 Mbps │ ✓ 2m ago           │
│   4 │ 🇫🇷 Paris - Seine            │ udp         │  120 ms │ 22.1 Mbps │ ✗ timeout · 5m ago │
╰─────┴─────────────────────────────┴─────────────┴─────────┴───────────┴────────────────────╯
      [ ▶ Connect ]  [ Disconnect ]  [ Speed test all ]  [ Latency test all ]  [ Watch: on ]
                                      [ New scan ]  [ Quit ]
```

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k`, PgUp/PgDn, Home/End | move |
| `enter` | connect to the selected one |
| `d` | disconnect |
| `s` | speed test them all again; it first says how long that takes and how much it downloads (up to 10 MB each), and `s` again starts it |
| `l` | latency test them all again (no downloads); `l` again starts it |
| `o` | sort by speed or by latency |
| `w` | watch on or off |
| `b` | background checks on or off |
| `n` | new scan: back to the picker, with your saved settings |
| `esc` | stop what's running (a test, or connecting); with nothing running, quit |
| `q` | quit; the VPN stays as it is (press again to quit right away) |

**Mouse:** click a row to select it, double-click it to connect, scroll with the wheel. The buttons do the same as their keys.

**Where you're connected** is the box on top: a green `● CONNECTED` with the location, protocol, how long it's been up, its latency (checked every 3 s, with the last round trips as a sparkline), the VPN's IP, and how many times WindScout connected you again. While connecting, it shows each step and the time against the timeout. `▲ CONNECTION LOST` shows while it connects you again, `✗ NONE CONNECT NOW` when none of them does, and `● CONNECTED IN THE APP` when you connected in the Windscribe app yourself (WindScout doesn't watch that one). The terminal window's title says it too, for when the terminal is behind another window. The box also shows the last two things that happened, with the time, on a tall enough terminal.

**Connecting:** when the one you chose doesn't connect, WindScout goes back to the one you were on, if any, else it tries the next ones in the list, around to the one before it. The one that didn't connect goes to the end of the list, marked ✗ with why and when.

**Testing them all again** (`s` or `l`) goes through the list one at a time on this computer, as a scan does: it connects, measures, disconnects. Your VPN switches as it goes. Afterwards the list is ranked by what the test found, and WindScout connects you back to the one you had if it still works, else to the best. When you stop the test (`esc`), it connects you back too. The ones that didn't connect go to the end, marked ✗: they may work again later, and the next test tries them again. When none connects, that's your network rather than them, so the list stays as it was.

**Watching** (on by default, remembered) keeps you connected. Every 3 s it checks the connection: still connected, with internet through it. After 3 misses in a row, it connects again. If the connection had lasted 5 minutes, it tries the same one first; one that dropped sooner is likely blocked, so it goes to the end of the list and the next best is tried. When none connects, it waits 30 s and tries them all again from the best. Disconnecting or switching in the Windscribe app is yours to do: WindScout tells that from a drop by the app's own log (`~/.local/share/Windscribe/Windscribe2/client.log` on Linux) and leaves the VPN alone. Where it can't read that log, it takes your disconnect for a drop, so press `d` in WindScout instead. With watching off, a drop just shows (`▲ NO INTERNET`).

**Background checks** (`b`, remembered; on by default once you've used [parallel scans](#parallel-scan-with-docker)) keep the list fresh while you stay connected. While watching, every 5 minutes, 3 docker containers connect to each connection in the list and measure its latency. Your own VPN connection isn't touched, and nothing pops up: only the line in the box says what they're doing. They skip the one you're on, since the watch checks it already, and they don't run a speed test, since that would cost data. What works gets its new latency, and what doesn't goes to the end of the list. A check where nothing worked changes nothing. The first check comes 5 minutes after the scan, or right away for an older saved list. The containers stay up between checks, at about 120 MB each, and go away when you turn the checks off, quit, or start a new scan. If docker isn't set up, `b` offers to install or start it, as `d` in the picker does.

The containers have to go out on your own network, not through your VPN: through it, they'd test from the VPN's server and everything would look like it works.

- **Docker on Linux:** WindScout puts them on a docker network of their own, `windscout-direct`. A routing rule then sends that network's traffic out your normal gateway: routing table 2470, at rule priorities 89-90, set up by a short-lived container on the host network. Only that network's traffic is affected. Windscribe's firewall filters this computer's own traffic, not what it forwards, so it doesn't block them. The rule goes away when the checks stop.
- **Docker Desktop** (macOS, Windows) sends its containers' traffic through your VPN, and WindScout can't route around that.

Either way, before each check WindScout compares the containers' outside IP with your VPN's. If they're the same, it turns the checks off and says why. With Docker Desktop, excluding docker in Windscribe's split tunneling lets the checks run.

**Quitting** leaves the VPN as it is. If you quit while connecting to one you chose, that attempt finishes first. If you quit during a test, it connects you back to the one you had first. Press `q` again to quit right away. On the way out, WindScout prints the list as it is now (when it changed) and whether you're connected.

**New scan** (`n`): WindScout stops what's running and the background checks, then opens the picker with your saved settings. When you're connected, it asks first, since the scan switches your VPN (it disconnects it before it starts).

The list is [saved](#last-result-rescan-and-connect) as it changes, so `windscout connect` and the scanning types by the last result use what the screen found.

## Last result: rescan and connect

After each scan, WindScout saves its working connections, best first, to `~/.config/windscout/last.json`, and the [results screen](#results-screen-connect-test-again-stay-connected) updates them as it learns more. The ones whose last check didn't connect stay, at the end, marked with why: they may work again. Versions before 0.9.0 read those as working ones, and try them last. That includes a partial scan you stopped, and a scan started with `-c`. A scan's working connections replace the saved ones it tried, so the ones that stopped working drop out. The saved connections it didn't try stay, after its own: those of countries it didn't scan, and what a stopped scan didn't get to. A scan where nothing worked keeps the previous result as it is, since the network may just be down.

- **Rescan:** the [scanning types](#scanning-type) *by last success result first* and *only the last results* use the saved connections: the first tries the ones in your selection before the rest of it, the second tries only them.
- **Connect:** `windscout connect` connects to the best saved connection, without a scan. It checks each as the scan does: when one doesn't connect within the timeout (`-t`, or the saved one), or has no internet through it, it tries the next, until one connects. In a terminal, that happens on the [results screen](#results-screen-connect-test-again-stay-connected), which then keeps you connected (`n` there starts a scan). Without a terminal, it connects and exits. When none connects, or there's no saved scan, it says so and suggests a rescan or a new scan.

```sh
windscout connect          # the best saved connection that still works, on the results screen
windscout connect -t 30    # wait longer for each
```

## Scanning type

Press `o` in the picker, or pass `-o`, to choose what a scan tries and in which order. The picker's line shows the type, and the estimate under the table counts what that type scans. The type is remembered with your other settings.

| Type | `-o` | What it scans |
|---|---|---|
| default | `default` | the selected countries × protocols, the countries in list order |
| by random country | `random` | the same, with the countries shuffled, a new order each run |
| by last success result first | `last-first` | the same, but the [last result](#last-result-rescan-and-connect)'s working connections among them go first, best first and on their own port, then the rest. With one country selected, only that country is scanned, its saved connections first. The line shows how many saved connections are in your selection (`1 of 7 saved selected · 3h ago`) |
| only the last results | `last-only` | only the last result's working connections, each on its own protocol and port. The countries, protocols and all ports are skipped, so the picker greys them out and locks them. Its country list shows just the countries this scan tries, all selected; your own selection comes back when you change the type, and stays for next time. With `-o last-only`, `-c` isn't needed |

The two types by the last result need a saved scan. Until there is one, choosing either turns `[ ▶ Start ]` off (greyed out), and a warning takes the estimate's place: `no saved scan yet, so start is off: press o for another scanning type`. Without the picker, `-o last-first` and `-o last-only` stop with an error instead. The estimate counts each saved connection once: `tcp` and `tcp:443` are the same attempt when 443 is tcp's default port.

### Stop at the first working connection

Press `w` in the picker, or pass `-w`, to end the scan at the first connection that works and holds up: the attempts still connecting give up, and no more start. The scan stops at one connection, so that one has to be good for long use. A tunnel can connect and then be cut or throttled once traffic flows, or refuse the next connection, which is the one you make. So each connection that connects is checked first:

1. **Speed test**, even with the speed test off (`s`, `-n`). It must reach at least 1 Mbps.
2. **Hold:** it has to stay connected to the same server for 30 s, with a round trip through it every 2 s. A lost round trip now and then is fine, but 2 in a row (an outage), or more than 1 in 10, fail it. Change the 30 s with `h` in the picker or `-H` (at least 10, saved with your other settings): a longer hold catches connections that drop later, but takes longer for each one.
3. **Speed test again.** It must still reach 1 Mbps, which catches a connection that gets throttled once traffic flows. The table shows the slower of the two.
4. **Reconnect:** it disconnects and connects again the way you will, by the datacenter's nickname (`windscribe-cli connect "Castle" stealth`): within the timeout, with internet through it.

A connection that fails a check gets the status `unreliable` and doesn't count as working: it isn't saved, or offered to connect to. One slower than 1 Mbps still counts as working, but isn't checked: the scan never stops there, and keeps looking. If nothing passes, the scan runs to the end, the report shows whatever worked, and a line above it says those connections weren't checked.

The checks add about 1m 15s to each connection that passes the first speed test (each speed test takes up to 15 s), more with a longer hold; the `w` line shows it. The estimate reads `up to N attempts · ≈ … if none connects`. With a type by the last result, the best saved connection goes first, and the `w` line shows about how long the scan takes if it still holds up (`≈ 1m 15s if DE stealth still holds up`). It's the quickest way back online: *only the last results* or *by last success result first*, with `w`. In a [parallel scan](#parallel-scan-with-docker), the containers take turns for the speed tests and the hold, as they do for measuring, and each reconnects after its turn.

## Connect-only mode

Often you only need to know **what connects**, not how fast it is. Turn the speed test off with `s` in the picker or with `--no-speed`. Each working connection is then checked with a quick latency test only. That saves about 15 s per working connection, and results are ranked by latency. Connect-only is the default on the first run, and the choice is remembered.

Both modes show an **availability grid**: one row per country, and ✓ / ✗ for each protocol (`·` = not tried yet; `key limit`, in a [parallel scan](#parallel-scan-with-docker): WireGuard couldn't be tried). With [all ports](#all-ports), it counts how many of a protocol's ports worked: `✓ 3/11`. Location(s) lists each datacenter that connected, one per line, since protocols can land on different ones:

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

While scanning, press `tab` to switch between the availability grid and the speed or latency ranking. Press `p` (or `space`) to pause: the current attempt finishes, the VPN disconnects, and the scan waits until you press `p` again. Paused time doesn't count toward elapsed or remaining. The scan starts on the ranking (*Working so far*) until you switch: then the next scans start on the table you left it on (saved to `~/.config/windscout/view.json`).

## All ports

Each protocol is normally tried on its default port, the first one Windscribe lists for it. A network can block a protocol on one port and let it through on another, so turn on **all ports** with `p` in the picker or `-P` (`--all-ports`): each selected protocol is then tried on every port Windscribe offers for it. WindScout asks your Windscribe app for the ports (`windscribe-cli ports tcp`), so the list follows Windscribe's. In October 2026 it was:

| Protocol | Ports | Attempts per country |
|---|---|---|
| wireguard | 443, 80, 53, 123, 1194, 65142 | 6 |
| stealth | 443, 587, 21, 22, 80, 123, 143, 3306, 8080, 54783, 8443 | 11 |
| wstunnel | 443 | 1 |
| udp | 443, 80, 53, 123, 1194, 54783 | 6 |
| tcp | 443, 587, 21, 22, 80, 123, 143, 3306, 8080, 54783, 1194 | 11 |

With every protocol selected, that's 35 attempts per country instead of 5, 7 times as many (on macOS and Windows, IKEv2 adds its own ports). The picker shows the count (`35 attempts per country, not 5`) and the estimate: one country takes about 11m 40s instead of 1m 40s in a normal scan, and about 2 minutes in a [parallel scan](#parallel-scan-with-docker), which helps most here. With the speed test on, every working port gets a speed test too, about 15 s each, so connect-only mode finds the working ports sooner. To try fewer, select only the protocols you need, or give a port yourself: a protocol with a port (`-p tcp:443`) stays on that one.

The availability grid keeps one column per protocol and counts how many of its ports worked (`✓ 3/11`, or `✗ 0/11` when none did). The results list each working protocol with its port, and the per-protocol table has a line per port.

When the app making an attempt doesn't offer a port, Windscribe quietly connects on the protocol's default port instead. That can happen in a parallel scan, where each container runs its own copy of the app, which can be older or newer than yours. WindScout checks the port it actually connected on and shows those attempts as `no port` (in yellow), rather than as results for a port that wasn't tried. Listing ports needs Windscribe 2.22 or newer. With an older app, all ports changes nothing, and the picker says so.

## Block internet while scanning (firewall)

Between attempts the VPN is disconnected for a moment, and apps on your computer (browser, messengers, updates) can go online over your real connection. Turn on **block internet while scanning** with `f` in the picker or `--firewall`, and WindScout switches on the Windscribe app's firewall for the scan: nothing gets online except through the VPN. When the scan ends or you stop it, the firewall goes back off (if you already had it on, WindScout leaves it on). While a scan is paused, the firewall keeps blocking.

## Parallel scan with Docker

A normal scan tries one location at a time, because your computer has one VPN connection. Turn on **parallel scan** with `d` in the picker or `--docker`, and each attempt runs in its own docker container instead. Each container has its own Windscribe app (Windscribe's Linux CLI app) and so its own VPN connection, and several locations are tried at once. The results come back to the scan screen, which shows a line per container.

**How many containers:** one per attempt, so 1 country with 5 protocols starts 5. Docker's CPUs, three quarters of its memory (at 250 MB each) and a maximum of 16 limit that. With more attempts than that, WindScout starts the fewest containers that need no more rounds: 17 attempts get 9 containers with 2 attempts each, the same 2 rounds that 16 containers would take. Fewer containers log in sooner (in a test, 1 took 37 s, and 16 together up to 75 s) and register fewer WireGuard keys. The picker shows the number (`9 at a time`) and the estimate that goes with it, which includes the time the containers take to log in before the scan starts (`+ ~58s login`: about 35 s, plus 2.5 s per container).

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

**Kernel check:** each container first checks that docker's Linux kernel gives it what Windscribe needs: a tunnel device (tun) and a firewall (nftables). If not, the scan stops and says so, rather than showing every location as blocked. Windscribe's WireGuard also needs nftables' `fib` in its firewall table, which Docker Desktop's own Linux VM lacks (on macOS, and on Windows without WSL 2). There, a parallel scan skips WireGuard (see below).

**Login:** the containers' Windscribe apps log in with the session that the Windscribe app on this computer is logged in with, so they never log in with your password. Windscribe locks an account that logs in many times at once, and a login per container would do that. WindScout reads the session from the app's settings (`~/.config/Windscribe/Windscribe2.conf` on Linux, the `com.windscribe.Windscribe2` defaults on macOS, `HKEY_CURRENT_USER\Software\Windscribe\Windscribe2` in the registry on Windows) and hands it to each container on its standard input, not on a command line, where other programs could see it. Each container's docker volume (`windscout-1`, `windscout-2`, …) keeps its app's settings for the next scans, with the WireGuard keys it registered with your account. A volume that another account used starts over. If you log out of the Windscribe app, the containers' session ends too, and the next scan gives them the new one.

**WireGuard keys:** each container's app registers a WireGuard key of its own with your account the first time it uses WireGuard, and keeps it in its volume for later scans. Windscribe allows each account only so many keys. A container past that limit can't try WireGuard, which says nothing about your network, so the grid shows `key limit` (in yellow) instead of ✗, and those attempts don't count in the report's per-protocol numbers. Under the grid, the report says how many there were and gives the command that tries them on this computer, which has a key of its own: `windscout -c "DE,NL" -p wireguard`.

WindScout 0.6.0 asked for your username and password instead, and could save them in `~/.config/windscout/login.json`. WindScout now deletes that file.

**Measuring:** the containers share your internet connection, so they take turns measuring latency and speed while the connecting happens in parallel. Numbers stay comparable with a normal scan. Most of the time saved comes from attempts that hang until the timeout, which overlap now.

**Differences from a normal scan:**

- The containers do the whole scan: nothing runs on this computer. What they can't run is skipped: IKEv2 (Windscribe's Linux app has none), and WireGuard when the kernel check finds it can't run in the containers. The picker's docker line says so (`ikev2 skipped`), its estimate leaves them out, and a line after the scan lists them. To try them, scan without docker. If every container stops, the scan ends there, with what they found, and says why.
- This computer's own Windscribe connection is disconnected at the start and stays off while the containers scan, since it would carry their traffic too.
- No firewall: "block internet while scanning" isn't used, since it would block the containers' traffic too.

The containers are removed after the scan. To remove their settings too (and the session in them), run `docker volume rm windscout-1 windscout-2 …`. To remove the image, run `docker rmi windscout-worker`.

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
npm test            # build, then check the scan, the results screen's keeper and the status parsing (no VPN, no docker)
node dist/cli.js    # run your build; takes the same options as windscout
./publish.sh        # build, install the packed tarball to check it runs, publish to npm (bump the version first)
```

## License

MIT

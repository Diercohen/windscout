// Parallel scans: a docker container per slot, each with its own Windscribe app, so each has its own tunnel.
// The apps log in with the session this computer's app is logged in with.
// A container runs `windscout --worker` (worker.ts) and takes attempts from here one at a time:
// a JSON object per line on its stdin, answered the same way on its stdout.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Result } from "./probe.js";
import type { Prober } from "./scan.js";
import { sleep } from "./time.js";
import type { Session } from "./windscribe.js";

const IMAGE = "windscout-worker";
const ROOT = new URL("..", import.meta.url); // this package: its package.json and dist/ go into the image
// The image's base, node:22-bookworm-slim pinned by digest: whichever registry serves it, it's exactly this image.
// ponytail: pinned; refresh it now and then (docker buildx imagetools inspect node:22-bookworm-slim) for Node and Debian fixes
const BASE = "library/node@sha256:3ed98443660ff48413b5af19ecefce3b9d50845a901a43420d47cc63a9fddbe9";
const BASE_TAG = "windscout-base:node22-3ed98443"; // BASE once pulled, from wherever
// Docker Hub, then mirrors of it in Iran, where Docker Hub refuses to serve (US sanctions). From github.com/MiravaOrg/Mirava:
// the first six after Docker Hub served BASE on 2026-10-21. WINDSCOUT_REGISTRY_MIRRORS (comma-separated hosts) go first.
// ponytail: mirrors come and go; refresh the list from Mirava when they do
const REGISTRIES = [...(process.env.WINDSCOUT_REGISTRY_MIRRORS?.split(",").map((h) => h.trim()).filter(Boolean) ?? []),
  "docker.io", "registry.docker.ir", "docker.iranserver.com", "docker.kernel.ir", "mirror2.chabokan.net", "docker-mirror.liara.ir",
  "hub.hamdocker.ir", "docker.arvancloud.ir", "focker.ir", "docker.mobinhost.com", "mirror-docker.runflare.com"];
// Debian's packages: deb.debian.org, else its mirrors in Iran (from Mirava; apt checks Debian's signatures, whoever serves them).
// Over http: the base image has no CA certificates yet.
// Windscribe's Linux CLI app: its latest stable release on GitHub, found through the releases/latest redirect, not GitHub's API,
// whose 60 requests an hour per address run out behind shared addresses (as on Iran's mobile networks).
// openresolv: the app sets the tunnel's DNS through resolvconf; without it, DNS goes nowhere once connected.
// The CMD first checks the kernel (WSL's builds tun and parts of nftables as modules): no tun or nftables, no tunnel, so
// the container stops saying so instead of scanning. The helper's WireGuard routing also puts a fib rule in an inet table,
// which Docker Desktop's own kernel (macOS, Windows without WSL) can't run: WS_WIREGUARD=0 then, and it runs on this computer.
// No systemd in a container: start the helper (root) like its unit would; the worker starts the app once it has the session
const DOCKERFILE = `FROM ${BASE_TAG}
ENV LANG=C.UTF-8
RUN for m in deb.debian.org mirror.shatel.ir mirror.iranserver.com mirror.mobinhost.com mirror2.chabokan.net; do \\
   sed -i -E "s#^URIs: [a-z]+://[^/]+/#URIs: http://$m/#" /etc/apt/sources.list.d/debian.sources; \\
   apt-get -o Acquire::http::Timeout=20 update --error-on=any && break; \\
 done \\
 && apt-get install -y --no-install-recommends ca-certificates curl openresolv \\
 && v=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/Windscribe/Desktop-App/releases/latest | sed 's#.*/v##') \\
 && curl -fsSL -o /tmp/windscribe.deb "https://github.com/Windscribe/Desktop-App/releases/download/v$v/windscribe-cli_"$v"_$(dpkg --print-architecture).deb" \\
 && apt-get install -y --no-install-recommends /tmp/windscribe.deb \\
 && rm -rf /tmp/windscribe.deb /var/lib/apt/lists/* \\
 && useradd -m ws && mkdir -p /home/ws/.config/Windscribe && chown -R ws: /home/ws
COPY package.json /app/
COPY dist /app/dist
CMD mkdir -p /dev/net && { [ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200; } \\
  && ip tuntap add mode tun dev wscheck && ip link del wscheck \\
  && nft 'add table inet wscheck; add chain inet wscheck o { type filter hook output priority 0; }; add rule inet wscheck o ct mark 1 reject; delete table inet wscheck' \\
  || { echo "this docker's Linux kernel can't give a container a VPN tunnel (tun) and firewall (nftables)" >&2; exit 1; }; \\
  nft 'add table inet wscheck; add chain inet wscheck p { type filter hook prerouting priority 0; }; add rule inet wscheck p fib saddr type != local drop; delete table inet wscheck' 2>/dev/null \\
  && wg=1 || wg=0; \\
  /opt/windscribe/helper >/dev/null 2>&1 & \\
  exec runuser -u ws -- env HOME=/home/ws WS_WIREGUARD=$wg node /app/dist/cli.js --worker
`;

const user = userInfo().username;
// Docker Desktop, and the docker CLI in it: used when docker isn't on PATH (a fresh install on Windows isn't, for this process)
const DD = join(process.env.ProgramFiles || "C:\\Program Files", "Docker", "Docker");
const [DESKTOP, DESKTOP_CLI] = ({
  darwin: ["/Applications/Docker.app", "/Applications/Docker.app/Contents/Resources/bin/docker"],
  win32: [join(DD, "Docker Desktop.exe"), join(DD, "resources", "bin", "docker.exe")],
} as Partial<Record<NodeJS.Platform, string[]>>)[process.platform] ?? [];
/** Where to install docker by hand, when installing it from here didn't work */
export const INSTALL_DOCS = ({
  darwin: "https://docs.docker.com/desktop/setup/install/mac-install/",
  win32: "https://docs.docker.com/desktop/setup/install/windows-install/",
} as Partial<Record<NodeJS.Platform, string>>)[process.platform] ?? "https://docs.docker.com/engine/install/";

const lastLine = (s: string) => s.trim().split("\n").at(-1)?.trim() ?? "";

/** Runs a command (a shell line when args is null); onLine gets its output as it comes, curl's progress too. code -1: not installed */
function exec(cmd: string, args: string[] | null, { input, onLine = () => {}, timeout }: { input?: string; onLine?: (line: string) => void; timeout?: number } = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const p = args ? spawn(cmd, args, { timeout }) : spawn(cmd, { shell: true, timeout });
    let out = "";
    const take = (d: Buffer) => {
      out = (out + d).slice(-20_000);
      String(d).split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean).forEach(onLine);
    };
    p.stdout.on("data", take);
    p.stderr.on("data", take);
    p.stdin.on("error", () => {});
    p.stdin.end(input);
    p.on("error", (e) => resolve({ code: -1, out: e.message }));
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

/** Runs the docker CLI. Not on PATH: Docker Desktop's folder goes on it, for the CLI and the credential helper beside it */
async function docker(args: string[], options?: Parameters<typeof exec>[2]) {
  const r = await exec("docker", args, options);
  if (r.code !== -1 || !DESKTOP_CLI || !existsSync(DESKTOP_CLI) || process.env.PATH?.split(delimiter).includes(dirname(DESKTOP_CLI))) return r;
  process.env.PATH = dirname(DESKTOP_CLI) + delimiter + process.env.PATH;
  return exec("docker", args, options);
}

export type DockerState = "ready" | "stopped" | "denied" | "missing";
let info = { cpus: 0, memory: 0, os: "linux" }; // docker's, from the last dockerState() that found it ready

/** ready: the daemon answers us. denied: it runs, but this user may not use it (Linux: not in the docker group yet) */
export async function dockerState(): Promise<DockerState> {
  const r = await docker(["info", "--format", "{{.NCPU}} {{.MemTotal}} {{.OSType}}"], { timeout: 30_000 });
  if (r.code === -1) return DESKTOP && existsSync(DESKTOP) ? "stopped" : "missing";
  if (r.code) return /permission denied/i.test(r.out) ? "denied" : "stopped";
  const [cpus, memory, os] = r.out.trim().split(/\s+/);
  info = { cpus: Number(cpus), memory: Number(memory), os };
  return "ready";
}

const WORKER_MEMORY = 250e6; // bytes per container: Windscribe's app and helper, a tunnel and node take ~120 MB
// ponytail: past this, more containers mostly add load on the one uplink, and WireGuard keys on the account; raise if real scans say so
const MAX_WORKERS = 16;

/** Protocols the containers can't do, which a parallel scan runs on this computer after them: IKEv2 (Windscribe's Linux app
 * has none), and WireGuard when their kernel can't run its routing (see DOCKERFILE) */
export const notInContainers = (protocols: readonly string[], wireguard: boolean) =>
  new Set(protocols.filter((p) => p === "ikev2" || (p === "wireguard" && !wireguard)));

/** Containers for this many attempts, when docker can run at most `most`: one per attempt; past that, the fewest that need no
 * more rounds (17 attempts, 16 at most: 9 containers make 2 rounds, as 16 would), since fewer log in sooner and register fewer keys */
export const containersFor = (attempts: number, most: number) =>
  attempts <= most ? Math.max(1, attempts) : Math.ceil(attempts / Math.ceil(attempts / most));

// ponytail: rough seconds until n containers are logged in: in a test, 1 took 37 s, 16 at once 38-75 s; refine from real runs
export const loginSeconds = (containers: number) => 35 + 2.5 * containers;

/** Containers for a scan of this many attempts, within docker's CPUs and 3/4 of its memory */
export const workerCount = (attempts: number) =>
  containersFor(attempts, Math.max(1, Math.min(MAX_WORKERS, info.cpus, Math.floor((info.memory * 0.75) / WORKER_MEMORY))));

export interface Step {
  label: string;
  cmd: (dir: string) => string; // a shell line; dir: a private temp folder the steps share
  root?: boolean; // runs through sudo
}

const DMG = `https://desktop.docker.com/mac/main/${process.arch === "arm64" ? "arm64" : "amd64"}/Docker.dmg`;
const START_DESKTOP: Step = process.platform === "win32"
  ? { label: "start Docker Desktop", cmd: () => `start "" "${DESKTOP}"` }
  : { label: "start Docker Desktop", cmd: () => "open -a Docker" };
// docker.com refuses some countries (Iran: US sanctions): then the distribution's own docker package, from the mirrors it uses.
// get.docker.com may have left its repository behind: without that gone, the package manager would fail on it
const DISTRO_DOCKER = "rm -f /etc/apt/sources.list.d/docker.list /etc/apt/sources.list.d/docker.sources /etc/yum.repos.d/docker-ce.repo; "
  + "if command -v apt-get >/dev/null; then apt-get update; apt-get install -y docker.io && { apt-get install -y docker-buildx || true; }; "
  + "elif command -v dnf >/dev/null; then dnf install -y moby-engine; "
  + "elif command -v pacman >/dev/null; then pacman -Sy --noconfirm docker docker-buildx; "
  + "elif command -v zypper >/dev/null; then zypper --non-interactive install docker; "
  + "else echo 'no package manager WindScout knows here: install docker yourself' >&2; false; fi";
// Linux: members of the docker group control docker, root-equivalent; that's what lets us run it without sudo
const JOIN: Step = { label: "add you to the docker group, and start docker", root: true,
  cmd: () => `usermod -aG docker "${user}" && (systemctl enable --now docker || service docker start)` };

/** What it takes to get docker answering, from this state */
export function steps(state: Exclude<DockerState, "ready">): Step[] {
  if (process.platform === "linux") return state === "missing" ? [
    { label: "install docker from get.docker.com, or else your distribution's package", root: true,
      cmd: (d) => `{ curl -fsSL --max-time 60 -o "${d}/get-docker.sh" https://get.docker.com && sh "${d}/get-docker.sh"; } || { ${DISTRO_DOCKER}; }` },
    JOIN,
  ] : state === "denied" ? [JOIN] : [{ label: "start docker", root: true, cmd: () => "systemctl start docker || service docker start" }];
  if (state !== "missing") return [START_DESKTOP];
  return process.platform === "win32" ? [
    { label: "install Docker Desktop with winget (Windows asks for permission, and may want a restart)",
      cmd: () => "winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements" },
    START_DESKTOP,
  ] : [
    { label: "download Docker Desktop from docker.com (about 600 MB)", cmd: (d) => `curl -fL -o "${d}/Docker.dmg" ${DMG}` },
    { label: "install it in /Applications, accepting its license", root: true,
      cmd: (d) => `hdiutil attach -nobrowse -quiet -mountpoint "${d}/mnt" "${d}/Docker.dmg"`
        + ` && "${d}/mnt/Docker.app/Contents/MacOS/install" --accept-license --user="${user}"; s=$?; hdiutil detach -quiet "${d}/mnt"; exit $s` },
    START_DESKTOP,
  ];
}

/** sudo runs without asking right now (a recent password, or NOPASSWD) */
export const sudoReady = async () => (await exec("sudo", ["-n", "true"])).code === 0;

/** Gives sudo the password, so the root steps can run with sudo -n; "" when it took it, else why not */
export async function sudoLogin(password: string): Promise<string> {
  // -S: the password from stdin, -v: only validate. One line, so a typo counts as one failed try, not three
  const r = await exec("sudo", ["-S", "-p", "", "-v"], { input: password + "\n" });
  return !r.code ? "" : /incorrect|sorry/i.test(r.out) ? "wrong password, try again" : lastLine(r.out) || "sudo refused";
}

/** Runs the steps; root ones with sudo -n, after sudoLogin() (password: to log in again if that ran out meanwhile) */
export async function runSteps(todo: Step[], password: string | undefined, onStep: (label: string) => void, onLine: (line: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "windscout-"));
  try {
    for (const s of todo) {
      onStep(s.label);
      if (s.root && !(await sudoReady()) && (!password || (await sudoLogin(password)))) throw new Error(`sudo wants your password again: try again`);
      const r = await (s.root ? exec("sudo", ["-n", "sh", "-c", s.cmd(dir)], { onLine }) : exec(s.cmd(dir), null, { onLine }));
      if (r.code) throw new Error(`${s.label} failed: ${lastLine(r.out) || `exit ${r.code}`}`);
    }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {} // a leftover temp folder isn't worth failing over
  }
}

/** Waits for the daemon after starting it; Docker Desktop can take a minute or two the first time */
export async function waitReady(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    const state = await dockerState();
    if (state === "ready") return;
    if (state === "denied") throw new Error("docker runs now, but your user can't use it yet: try again to fix that");
    await sleep(2000);
  }
  throw new Error("docker didn't start within 3 minutes. If Docker Desktop asks for something (on Windows: a restart, or WSL), do that, then try again");
}

/** Hash of what goes into the image (dist/ holds this file, so the Dockerfile too): another build of windscout gets a new image */
function fingerprint(): string {
  const h = createHash("sha256");
  const files = ["package.json", ...readdirSync(new URL("dist", ROOT), { recursive: true, encoding: "utf8" }).map((f) => `dist/${f}`)].sort();
  for (const f of files) if (statSync(new URL(f, ROOT)).isFile()) h.update(f).update(readFileSync(new URL(f, ROOT)));
  return h.digest("hex").slice(0, 16);
}

/** Whether a registry answers at all: 200 or 401 from its API (Docker Hub says 403 to Iran) */
const answers = (registry: string) =>
  fetch(`https://${registry === "docker.io" ? "registry-1.docker.io" : registry}/v2/`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.status === 200 || r.status === 401, () => false);

/** Gets the image's base: from the first registry in REGISTRIES that answers and serves it */
async function pullBase(onLine: (line: string) => void): Promise<void> {
  if (!(await docker(["image", "inspect", BASE_TAG])).code) return;
  const up = await Promise.all(REGISTRIES.map(answers)); // asking them all at once: dead ones would each take the timeout
  // Docker Hub last even if it didn't answer: docker may reach it through a proxy that this process doesn't use
  const order = [...REGISTRIES.filter((_, i) => up[i]), ...(up[REGISTRIES.indexOf("docker.io")] ? [] : ["docker.io"])];
  let why = "none answered";
  for (const registry of order) {
    onLine(`the base image, from ${registry}`);
    const ref = `${registry}/${BASE}`;
    const r = await docker(["pull", ref], { onLine, timeout: 15 * 60_000 });
    if (!r.code) return void (await docker(["tag", ref, BASE_TAG]));
    why = `${registry}: ${lastLine(r.out)}`;
  }
  throw new Error(`couldn't get the containers' base image from Docker Hub or its mirrors (${why}). A VPN may help`);
}

/** Builds the containers' image, unless this windscout's is there already; onLine gets the build's output */
export async function buildImage(onLine: (line: string) => void): Promise<void> {
  if (info.os === "windows") throw new Error("Docker Desktop runs Windows containers: switch it to Linux containers (right-click its icon by the clock), then try again");
  const tag = fingerprint();
  const have = await docker(["image", "inspect", "-f", '{{index .Config.Labels "windscout"}}', IMAGE]);
  if (!have.code && have.out.trim() === tag) return;
  await pullBase(onLine);
  // no --progress=plain: when piped, BuildKit prints plain anyway, and a distribution's docker may have only the old builder
  const r = await docker(["build", "--label", `windscout=${tag}`, "-t", IMAGE, "-f", "-", fileURLToPath(ROOT).replace(/[\\/]$/, "")],
    { input: DOCKERFILE, onLine });
  if (r.code) throw new Error(`building the containers' image failed: ${lastLine(r.out)}`);
}

type Message = Partial<{ // from a worker
  ready: boolean; // logged in: takes attempts
  wireguard: boolean; // with ready: its kernel lets Windscribe's WireGuard set up its routing
  step: string;
  measure: boolean; // connected, wants to measure: one container at a time, they share this computer's connection
  measured: boolean;
  result: Result;
}>;

// one at a time: `await lock()` resolves to the function that lets the next one in
function mutex(): () => Promise<() => void> {
  let last = Promise.resolve();
  return () => new Promise((enter) => {
    last = last.then(() => new Promise<void>((leave) => enter(leave)));
  });
}

const running = new Map<string, ChildProcess>(); // container name → its `docker run`, until the container stops
// a crash or a force quit leaves them running: remove them
const removeAll = () => running.size && spawnSync("docker", ["rm", "-f", ...running.keys()], { stdio: "ignore" });
process.on("exit", removeAll);

/** Starts n containers, their apps logged in with this computer's session; resolves to a prober for each container that got
 * ready, and whether WireGuard works in them */
export async function startWorkers(n: number, session: Session, onStatus: (text: string) => void) {
  const measuring = mutex();
  let wireguard = true;
  let ready = 0;

  const start = (i: number) => new Promise<Prober | null>((resolve) => {
    const name = `windscout-${process.pid}-${i + 1}`;
    // its own volume keeps its app's settings for the next scans: its WireGuard keys, registered with Windscribe once
    // it makes /dev/net/tun itself: Docker's Linux VM may have none (WSL loads tun as a module), and --device needs one there
    const p = spawn("docker", ["run", "-i", "--rm", "--init", "--name", name, "--cap-add", "NET_ADMIN", "--device-cgroup-rule", "c 10:200 rwm",
      "--sysctl", "net.ipv4.conf.all.src_valid_mark=1", "-v", `windscout-${i + 1}:/home/ws/.config/Windscribe`, IMAGE],
    { detached: process.platform !== "win32" }); // its own process group, so ctrl-c reaches only us (Windows would open a window)
    running.set(name, p);
    const send = (m: object) => p.stdin.write(JSON.stringify(m) + "\n");
    p.stdin.on("error", () => {}); // it stopped: "close" deals with that
    send({ session }); // on stdin, not in the command line or the environment, where ps and docker inspect show it
    let on = (_: Message) => {}; // the current phase's message handler
    let fail = (_: string) => {}; // and what it does when the container stops
    let dead = "", err = "";
    p.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
    createInterface({ input: p.stdout }).on("line", (l) => {
      let m: Message;
      try {
        m = JSON.parse(l);
      } catch {
        return; // not ours
      }
      on(m);
    });
    const gone = (why: string) => {
      if (dead) return;
      dead = why;
      running.delete(name);
      fail(why);
    };
    p.on("error", (e) => gone(e.message));
    p.on("close", (code) => gone(lastLine(err) || `exited (${code})`));

    const prober: Prober = (query, protocol, { timeout, speedTest, stopped = () => false, onStep = () => {} }) =>
      new Promise((done, reject) => {
        if (dead) return reject(new Error(`container ${i + 1} stopped: ${dead}`));
        let leave: (() => void) | null = null, over = false;
        const tick = setInterval(() => stopped() && send({ stop: true }), 1000);
        const end = () => ((over = true), clearInterval(tick), leave?.());
        fail = (why) => (end(), reject(new Error(`container ${i + 1} stopped: ${why}`)));
        on = async (m) => {
          if (m.step) onStep(m.step);
          else if (m.measure) {
            onStep("waiting for the other containers to measure");
            const l = await measuring();
            if (over) l();
            else (leave = l), send({ go: true });
          } else if (m.measured) leave?.(), (leave = null);
          else if (m.result) end(), done(m.result);
        };
        send({ probe: { query, protocol, timeout, speedTest } });
      });

    fail = (why) => (onStatus(`container ${i + 1}: ${why}`), resolve(null));
    on = (m) => {
      if (!m.ready) return;
      wireguard &&= m.wireguard !== false;
      fail = () => {};
      onStatus(`${++ready} of ${n} ready`);
      resolve(prober);
    };
  });

  const probers = (await Promise.all(Array.from({ length: n }, (_, i) => start(i)))).filter((p): p is Prober => p !== null);
  return { probers, wireguard };
}

/** Ends the containers once the scan is over: a worker exits when its stdin closes, and docker removes its container */
export async function stopWorkers(): Promise<void> {
  for (const p of running.values()) p.stdin?.end();
  for (let i = 0; running.size && i < 40; i++) await sleep(250);
  removeAll(); // stuck ones: their docker run would keep us from exiting
}

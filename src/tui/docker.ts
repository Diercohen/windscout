// Docker on screen, for parallel scans: dialogs to install or start it (taking the sudo password),
// and progress while the image builds and the containers start.
import type { Key } from "node:readline";
import { buildImage, dockerState, INSTALL_DOCS, runSteps, startWorkers, steps, sudoLogin, sudoReady, waitReady, workerCount, type DockerState } from "../docker.js";
import type { Prober } from "../scan.js";
import { duration, now } from "../time.js";
import { session } from "../windscribe.js";
import { draw, enterScreen, input, leaveScreen, out, type Mouse } from "./terminal.js";
import { bold, cyan, dim, vw, yellow } from "./text.js";
import { box, centerIn } from "./widgets.js";

interface Dialog {
  lines: string[];
  password?: string; // a password field's label: the field shows • for each character
  buttons?: [ok: string, cancel?: string]; // enter / esc
  error?: string; // in yellow, under the field
}

// where paint() put the buttons, for clicks: their row and [from, to) columns
interface Hits {
  row: number;
  ok: [number, number];
  cancel: [number, number];
}

const tty = () => Boolean(process.stdin.isTTY && out.isTTY);
const clip = (s: string, n = 76) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// lines of at most n columns, broken at spaces: an error can be longer than the screen is wide
const wrap = (s: string, n = 76) => s.match(new RegExp(`.{1,${n}}(\\s+|$)|\\S+`, "g"))?.map((l) => l.trim()) ?? [s];

function paint({ lines, password, buttons, error }: Dialog, typed = ""): Hits {
  const body = [...lines];
  if (password !== undefined) body.push("", `${password} ${bold("•".repeat(typed.length))}${cyan("▏")}`);
  if (error) body.push("", yellow(error));
  const width = Math.max(56, ...body.map(vw));
  let row = -1, line = "";
  if (buttons) {
    const [ok, cancel] = buttons;
    line = `${bold(cyan(`[ ${ok} ]`))}${cancel ? dim(`  [ ${cancel} ]`) : ""}`;
    row = body.length + 1;
    body.push("", centerIn(line, width), centerIn(dim([`enter ${ok.toLowerCase()}`, cancel && `esc ${cancel.toLowerCase()}`].filter(Boolean).join(" · ")), width));
  }
  enterScreen();
  const at = draw(box(body, { title: bold(cyan("WindScout · docker")), width }));
  if (!buttons) return { row: -1, ok: [0, 0], cancel: [0, 0] };
  // a body line sits a row under the box's top border, two columns right of its left one
  const x = at.left + 2 + Math.floor((width - vw(line)) / 2), okEnd = x + vw(`[ ${buttons[0]} ]`);
  return { row: at.top + 1 + row, ok: [x, okEnd], cancel: buttons[1] ? [okEnd + 2, okEnd + 2 + vw(`[ ${buttons[1]} ]`)] : [0, 0] };
}

/** Shows the dialog until the user answers: what was typed in its field ("" without one) on enter or a click on ok, null on esc */
function ask(d: Dialog): Promise<string | null> {
  if (!tty()) return Promise.resolve(null);
  let typed = "";
  let hits = paint(d, typed);
  const redraw = () => (hits = paint(d, typed));
  return new Promise((resolve) => {
    const done = (v: string | null) => {
      input.off("keypress", onKey);
      input.off("mouse", onMouse);
      out.off("resize", redraw);
      resolve(v);
    };
    const onKey = (str: string | undefined, key: Key = {}) => {
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return done(null);
      if (key.name === "return") return done(typed);
      if (key.name === "backspace") typed = typed.slice(0, -1);
      else if (d.password !== undefined && str && !key.ctrl && !key.meta && str >= " ") typed += str;
      redraw();
    };
    const onMouse = (m: Mouse) => {
      const on = ([from, to]: [number, number]) => m.press && m.button === 0 && m.y === hits.row && m.x >= from && m.x < to;
      if (on(hits.ok)) done(typed);
      else if (on(hits.cancel)) done(null);
    };
    input.on("keypress", onKey);
    input.on("mouse", onMouse);
    out.on("resize", redraw);
  });
}

/** Waits for work while the screen shows a spinner, status.label, the time so far and status.line (its latest output). esc quits */
async function busy<T>(status: { label: string; line: string }, work: Promise<T>): Promise<T> {
  if (!tty()) {
    console.error(`${status.label}…`);
    return work;
  }
  const t = now();
  let frame = 0;
  const tick = () => paint({ lines: [`${cyan("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame++ % 10])} ${status.label} ${dim("· " + duration(now() - t))}`,
    dim(clip(status.line)), "", dim("esc quits")] });
  // the exit handlers remove containers already started
  const quit = (_: unknown, key: Key = {}) => (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c"))
    && (leaveScreen(), process.exit(130));
  const timer = setInterval(tick, 120);
  input.on("keypress", quit);
  tick();
  try {
    return await work;
  } finally {
    clearInterval(timer);
    input.off("keypress", quit);
  }
}

const WHY: Record<Exclude<DockerState, "ready">, string> = {
  missing: "A parallel scan runs each attempt in a docker container, and docker isn't installed.",
  stopped: "A parallel scan runs each attempt in a docker container, and docker isn't running.",
  denied: "Docker is installed, but your user can't use it yet.",
};

/** Gets docker answering: asks, then installs or starts it. False when the user cancels, it fails, or (Linux) a new login is needed first */
export async function setupDocker(): Promise<boolean> {
  const state = await dockerState();
  if (state === "ready") return true;
  if (!tty()) throw new Error(`${WHY[state]} Run windscout in a terminal to set it up, or scan without --docker.`);
  const todo = steps(state);
  const root = todo.some((s) => s.root) && !(await sudoReady());
  const lines = [WHY[state], "", "WindScout will:", ...todo.map((s) => `  • ${s.label}${s.root ? dim(" (sudo)") : ""}`),
    ...(state === "missing" && process.platform !== "linux"
      ? ["", dim("Docker Desktop is free for personal use, education and small businesses;"), dim("bigger companies need a paid plan: docker.com/pricing")]
      : [])];
  let password: string | undefined, error = "";
  for (;;) {
    const a = await ask({ lines, password: root ? "password for sudo:" : undefined, buttons: [state === "missing" ? "Install" : "Start", "Cancel"], error });
    if (a === null) return false;
    if (!root) break;
    if (!(error = await sudoLogin(a))) {
      password = a; // kept until the steps are done: one may need sudo again after a long download
      break;
    }
  }
  const status = { label: "", line: "" };
  try {
    await busy(status, runSteps(todo, password, (label) => Object.assign(status, { label, line: "" }), (line) => (status.line = line)));
    if (process.platform === "linux" && state !== "stopped") {
      await ask({ lines: ["Docker is ready, and you're in the docker group now.", "That takes effect in a new login session: log out and back in",
        `(or run ${bold("newgrp docker")}), then start windscout again.`], buttons: ["OK"] });
      return false;
    }
    Object.assign(status, { label: "waiting for docker to start", line: "" });
    await busy(status, waitReady());
    return true;
  } catch (e) {
    const why = (e as Error).message;
    // docker.com refuses some countries (Iran: US sanctions), and nobody mirrors Docker Desktop: only a VPN gets it there
    const refused = /\b403\b|forbidden/i.test(why);
    const a = await ask({ lines: [...wrap(why).map(yellow),
      ...(refused ? ["", ...wrap(`docker.com refuses downloads from some countries, Iran among them${process.platform === "linux" ? ""
        : ", and no mirror carries Docker Desktop"}: connect a VPN (Windscribe will do), then retry.`)] : []),
      ...(state === "missing" ? ["", `To install docker yourself: ${INSTALL_DOCS}`] : [])], buttons: ["Retry", "Cancel"] });
    return a !== null && setupDocker();
  }
}

/** Starts the containers for a parallel scan of this many attempts: docker, the image, the containers' apps logged in with
 * this computer's session. Resolves to their probers and whether WireGuard works in them; null if the user backed out */
export async function startParallel(attempts: number): Promise<{ probers: Prober[]; wireguard: boolean } | null> {
  const s = session();
  if (!s) throw new Error("can't find the session this computer's Windscribe app is logged in with, which the containers' apps log in with:"
    + " update the Windscribe app, or scan without --docker (d in the picker)");
  if (!(await setupDocker())) return null;
  const status = { label: "building the containers' image (the first time takes a few minutes)", line: "" };
  await busy(status, buildImage((line) => (status.line = line)));
  const n = workerCount(attempts);
  Object.assign(status, { label: `starting ${n} container${n > 1 ? "s" : ""}`, line: "" });
  const started = await busy(status, startWorkers(n, s, (line) => (status.line = line)));
  if (!started.probers.length) {
    const why = status.line.startsWith("container") ? ` (${status.line})` : ""; // the last container's trouble
    throw new Error(`no container got ready${why}`);
  }
  return started;
}

// Docker on screen, for parallel scans: dialogs to install or start it (taking the sudo password),
// progress while the image builds and the containers start, and the Windscribe login the containers need.
import { homedir } from "node:os";
import type { Key } from "node:readline";
import { LOGIN_FILE, loadLogin, saveLogin } from "../config.js";
import { buildImage, dockerState, INSTALL_DOCS, runSteps, startWorkers, steps, sudoLogin, sudoReady, waitReady, workerCount, type Credentials, type DockerState } from "../docker.js";
import type { Prober } from "../scan.js";
import { duration, now } from "../time.js";
import { draw, enterScreen, input, leaveScreen, out, type Mouse } from "./terminal.js";
import { bold, cyan, dim, green, vw, yellow } from "./text.js";
import { box, centerIn } from "./widgets.js";

interface Field {
  label: string;
  value?: string; // its text to start with
  secret?: boolean; // shows • for each character
}

interface Dialog {
  lines: string[];
  fields?: Field[];
  check?: { label: string; on: boolean; note?: string }; // a checkbox under the fields; note: a dim line under it
  buttons?: [ok: string, cancel?: string]; // enter / esc
  error?: string; // in yellow, under the fields
}

/** What the user has typed and ticked; focus: the field with the cursor, or past the fields, the checkbox */
interface Answer {
  values: string[];
  checked: boolean;
  focus: number;
}

// where paint() put things, for clicks: the fields' and checkbox's rows, the buttons' row and their [from, to) columns
interface Hits {
  rows: number[];
  buttons: number;
  ok: [number, number];
  cancel: [number, number];
}

const tty = () => Boolean(process.stdin.isTTY && out.isTTY);
const clip = (s: string, n = 76) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// lines of at most n columns, broken at spaces: an error can be longer than the screen is wide
const wrap = (s: string, n = 76) => s.match(new RegExp(`.{1,${n}}(\\s+|$)|\\S+`, "g"))?.map((l) => l.trim()) ?? [s];
let asking = false; // a dialog waits for the user: progress doesn't draw over it

function paint({ lines, fields = [], check, buttons, error }: Dialog, a: Answer = { values: [], checked: false, focus: 0 }): Hits {
  const many = fields.length + (check ? 1 : 0) > 1; // then a ❯ marks where the keys go
  const mark = (i: number) => (!many ? "" : i === a.focus ? cyan("❯ ") : "  ");
  const body = [...lines], items: number[] = [];
  if (fields.length || check) body.push("");
  fields.forEach((f, i) => {
    items.push(body.length);
    body.push(`${mark(i)}${f.label} ${bold(f.secret ? "•".repeat(a.values[i].length) : a.values[i])}${i === a.focus ? cyan("▏") : ""}`);
  });
  if (check) {
    items.push(body.length);
    body.push(`${mark(fields.length)}${a.checked ? green("[✓]") : dim("[ ]")} ${check.label}`);
    if (check.note) body.push(dim(`${many ? "  " : ""}    ${check.note}`));
  }
  if (error) body.push("", yellow(error));
  const width = Math.max(56, ...body.map(vw));
  let row = -1, line = "";
  if (buttons) {
    const [ok, cancel] = buttons;
    line = `${bold(cyan(`[ ${ok} ]`))}${cancel ? dim(`  [ ${cancel} ]`) : ""}`;
    row = body.length + 1;
    body.push("", centerIn(line, width), centerIn(dim([many && "tab/↑↓ move", check && "space ticks the box", `enter ${ok.toLowerCase()}`,
      cancel && `esc ${cancel.toLowerCase()}`].filter(Boolean).join(" · ")), width));
  }
  enterScreen();
  const at = draw(box(body, { title: bold(cyan("WindScout · docker")), width }));
  // a body line sits a row under the box's top border, two columns right of its left one
  const rows = items.map((i) => at.top + 1 + i);
  if (!buttons) return { rows, buttons: -1, ok: [0, 0], cancel: [0, 0] };
  const x = at.left + 2 + Math.floor((width - vw(line)) / 2), okEnd = x + vw(`[ ${buttons[0]} ]`);
  return { rows, buttons: at.top + 1 + row, ok: [x, okEnd], cancel: buttons[1] ? [okEnd + 2, okEnd + 2 + vw(`[ ${buttons[1]} ]`)] : [0, 0] };
}

/** Shows the dialog until the user answers: what was typed and ticked on enter (or a click on ok), null on esc.
 * tab, ↑↓ and enter move between the fields; space or a click ticks the checkbox */
function form(d: Dialog): Promise<Answer | null> {
  if (!tty()) return Promise.resolve(null);
  asking = true;
  const fields = d.fields ?? [];
  const n = fields.length + (d.check ? 1 : 0);
  const a: Answer = { values: fields.map((f) => f.value ?? ""), checked: d.check?.on ?? false, focus: 0 };
  let hits = paint(d, a);
  const redraw = () => (hits = paint(d, a));
  return new Promise((resolve) => {
    const done = (v: Answer | null) => {
      asking = false;
      input.off("keypress", onKey);
      input.off("mouse", onMouse);
      out.off("resize", redraw);
      resolve(v);
    };
    const onKey = (str: string | undefined, key: Key = {}) => {
      const field = a.focus < fields.length;
      if (key.name === "escape" || (key.ctrl && key.name === "c")) return done(null);
      if (key.name === "return") {
        if (a.focus >= fields.length - 1) return done(a);
        a.focus++; // like a form: on to the next field
      } else if (n > 1 && (key.name === "tab" || key.name === "down")) a.focus = (a.focus + (key.shift ? n - 1 : 1)) % n;
      else if (n > 1 && key.name === "up") a.focus = (a.focus + n - 1) % n;
      else if (!field) {
        if (key.name === "space") a.checked = !a.checked;
      } else if (key.name === "backspace") a.values[a.focus] = a.values[a.focus].slice(0, -1);
      else if (str && !key.ctrl && !key.meta && str >= " ") a.values[a.focus] += str;
      redraw();
    };
    const onMouse = (m: Mouse) => {
      if (!m.press || m.button !== 0) return;
      const i = hits.rows.indexOf(m.y);
      const on = ([from, to]: [number, number]) => m.y === hits.buttons && m.x >= from && m.x < to;
      if (i >= 0) {
        a.focus = i;
        if (i === fields.length) a.checked = !a.checked; // the checkbox
      } else if (on(hits.ok)) return done(a);
      else if (on(hits.cancel)) return done(null);
      redraw();
    };
    input.on("keypress", onKey);
    input.on("mouse", onMouse);
    out.on("resize", redraw);
  });
}

/** A dialog with one field or none: the field's text ("" without one) on enter, null on esc */
const ask = async (d: Dialog) => {
  const a = await form(d);
  return a && (a.values[0] ?? "");
};

/** Waits for work while the screen shows a spinner, status.label, the time so far and status.line (its latest output). esc quits */
async function busy<T>(status: { label: string; line: string }, work: Promise<T>): Promise<T> {
  if (!tty()) {
    console.error(`${status.label}…`);
    return work;
  }
  const t = now();
  let frame = 0;
  const tick = () => asking || paint({ lines: [`${cyan("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[frame++ % 10])} ${status.label} ${dim("· " + duration(now() - t))}`,
    dim(clip(status.line)), "", dim("esc quits")] });
  // a dialog on top (the login) takes its own keys; the exit handlers remove containers already started
  const quit = (_: unknown, key: Key = {}) => !asking && (key.name === "escape" || key.name === "q" || (key.ctrl && key.name === "c"))
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
    const a = await ask({ lines, fields: root ? [{ label: "password for sudo:", secret: true }] : [], buttons: [state === "missing" ? "Install" : "Start", "Cancel"], error });
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

const LOGIN = [
  "Each container runs its own Windscribe app, which logs in once:",
  "the login stays in the container's docker volume for the next scans.",
];
let lastUser = "", remember = true; // the box as last ticked: ticked to start with

/** A remembered login unless that just failed, else the login form */
async function credentials(error: string): Promise<Credentials | null> {
  const saved = loadLogin();
  if (saved && !error) return saved;
  const a = await form({
    lines: LOGIN,
    fields: [{ label: "Windscribe username:", value: lastUser || saved?.username }, { label: "Windscribe password:", secret: true }],
    check: { label: "remember username and password", on: remember,
      note: `saved in ${LOGIN_FILE.replace(homedir(), "~")}, only you can read it` },
    buttons: ["Log in", "Cancel"],
    error,
  });
  if (!a) return null;
  remember = a.checked;
  if (!remember) saveLogin(null); // unticked: forget the one saved before, if any
  const [username, password] = a.values;
  return { username: (lastUser = username), password };
}

/** Starts the containers for a parallel scan of this many attempts: docker, the image, the logins.
 * Resolves to their probers and whether WireGuard works in them; null if the user backed out */
export async function startParallel(attempts: number): Promise<{ probers: Prober[]; wireguard: boolean } | null> {
  if (!(await setupDocker())) return null;
  const status = { label: "building the containers' image (the first time takes a few minutes)", line: "" };
  await busy(status, buildImage((line) => (status.line = line)));
  const n = workerCount(attempts);
  Object.assign(status, { label: `starting ${n} container${n > 1 ? "s" : ""}`, line: "" });
  const started = await busy(status, startWorkers(n, {
    credentials,
    answer: (question) => ask({ lines: ["Windscribe asks:", "", ...question.split("\n")], fields: [{ label: "answer:" }], buttons: ["Send", "Cancel"] }),
    loggedIn: (c) => remember && saveLogin(c), // saved only once it worked
  }, (line) => (status.line = line)));
  if (!started.probers.length) {
    const why = status.line.startsWith("container") ? ` (${status.line})` : ""; // the last container's trouble
    throw new Error(why || tty() ? `no container got ready${why}` : "the containers aren't logged in to Windscribe yet: run windscout --docker in a terminal once");
  }
  return started;
}

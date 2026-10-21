// windscout --worker: runs in a parallel scan's docker container (docker.ts), beside the container's own Windscribe app.
// Takes the host's messages from stdin and answers on stdout, a JSON object per line.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { probe } from "./probe.js";
import { sleep } from "./time.js";
import { CLI, windscribe } from "./windscribe.js";

type Message = Partial<{ // from the host
  login: { username: string; password: string } | null;
  input: string;
  probe: { query: string; protocol: string; timeout: number; speedTest: boolean };
  go: boolean; // our turn to measure
  stop: boolean;
}>;

const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");
// the CLI mixes JSON log lines into its output
const text = (s: string) => s.split("\n").filter((l) => !l.startsWith('{"tm"')).join("\n").trim();

export async function worker(): Promise<void> {
  const inbox: Message[] = [];
  let wake = () => {}, closed = false, stop = false;
  createInterface({ input: process.stdin })
    .on("line", (l) => {
      const m: Message = JSON.parse(l);
      if (m.stop) stop = true; // the scan is stopping: give up connecting
      else inbox.push(m), wake();
    })
    .on("close", () => ((closed = true), wake()));
  /** The host's next message; null once it closed stdin: the scan is over */
  const next = async () => {
    while (!inbox.length && !closed) await new Promise<void>((resolve) => (wake = resolve));
    return inbox.shift() ?? null;
  };

  // the app starts beside us (the image's CMD); its CLI answers once it's up
  let status = "";
  for (let i = 0; i < 60 && !(status = await windscribe("status")).includes("Login state"); i++) await sleep(1000);
  if (!status.includes("Login state")) return void console.error("Windscribe's app didn't start in the container");
  if (!status.includes("Logged in")) {
    for (let error = ""; ; ) {
      send({ need: "login", text: error });
      const m = await next();
      if (!m?.login) return; // no credentials for us: this container sits out the scan
      if (!(error = await login(m.login.username, m.login.password, next))) break;
    }
  }
  send({ ready: true, wireguard: process.env.WS_WIREGUARD !== "0" }); // the image's CMD checked the kernel
  for (let m: Message | null; (m = await next()); ) {
    if (!m.probe) continue;
    stop = false;
    const { query, protocol, timeout, speedTest } = m.probe;
    const result = await probe(query, protocol, {
      timeout, speedTest,
      stopped: () => stop,
      onStep: (step) => send({ step }),
      measure: async (fn) => {
        send({ measure: true });
        await next(); // go
        try {
          await fn();
        } finally {
          send({ measured: true });
        }
      },
    });
    send({ result });
  }
}

/** windscribe-cli login, with the password on its stdin; what it asks next (a 2FA code, a captcha) goes to the host.
 * "" once logged in, else why not */
function login(username: string, password: string, next: () => Promise<Message | null>): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(CLI, ["login", username], { stdio: ["pipe", "pipe", "ignore"] });
    p.stdin.on("error", () => {});
    p.stdin.write(password + "\n");
    let out = "";
    p.stdout.on("data", async (d) => {
      out += d;
      const asked = text(out);
      // a question ends the output, with no newline after it: "2FA code:", or under a captcha "…to continue:"
      if (!asked.endsWith(":")) return;
      out = "";
      if (asked.endsWith("Password:")) return; // answered already
      send({ need: "input", text: asked });
      p.stdin.write(((await next())?.input ?? "") + "\n");
    });
    // it exits 0 whether that worked or not: ask the app
    p.on("close", async () => resolve((await windscribe("status")).includes("Logged in") ? "" : text(out).split("\n").at(-1) || "login failed"));
  });
}

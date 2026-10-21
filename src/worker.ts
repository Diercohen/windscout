// windscout --worker: runs in a parallel scan's docker container (docker.ts), beside the container's own Windscribe app.
// Takes the host's messages from stdin and answers on stdout, a JSON object per line.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { probe } from "./probe.js";
import { now, sleep } from "./time.js";
import { SETTINGS, windscribe, withSession, type Session } from "./windscribe.js";

const APP = "/opt/windscribe/Windscribe"; // as the image installs it

type Message = Partial<{ // from the host
  session: Session; // the first message: the session this computer's app is logged in with
  probe: { query: string; protocol: string; timeout: number; speedTest: boolean };
  go: boolean; // our turn to measure
  stop: boolean;
}>;

const send = (m: object) => process.stdout.write(JSON.stringify(m) + "\n");

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

  // The app logs in with this computer's session, which goes in its settings before it starts: no login of its own, since
  // Windscribe locks an account that logs in many times at once. Never log out here: that would end this computer's session too
  const session = (await next())?.session;
  if (!session) return;
  let ini = "";
  try {
    ini = readFileSync(SETTINGS, "utf8");
  } catch {} // a new volume: no settings yet
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, withSession(ini, session));
  // no systemd in a container: start the app like its unit would, as this user (its CLI refuses root)
  spawn(APP, { stdio: "ignore" }).on("error", () => {}); // not there: its CLI never answers below
  // its CLI answers once it's up, and says logged in once Windscribe accepts the session, or the error it got instead
  let status = "";
  for (const t = now(); now() - t < 120 && !/Login state: (Logged in|Error)/.test(status = await windscribe("status")); ) await sleep(1000);
  if (!status.includes("Logged in")) {
    const state = status.match(/^Login state: (.*)$/m)?.[1].trim();
    return void console.error(state ? `Windscribe's app didn't log in with this computer's session (${state})` : "Windscribe's app didn't start in the container");
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

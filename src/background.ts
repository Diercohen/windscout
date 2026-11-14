// Background checks, for the results screen's watch. Every few minutes, docker containers connect to each connection in the
// list and measure its latency, so the list stays fresh while you stay connected: this computer's VPN isn't touched. There's no
// speed test, since that would cost data. The containers must go out on their own, not through your VPN: through it, they'd
// test from its server instead of your network, and everything would look like it works. On Linux, windscout routes its
// containers around the VPN (docker.ts). And before each check, it compares the IP the containers go out from with the VPN's,
// and checks only when they differ.
import { buildImage, DIRECT_NETWORK, directNetwork, dockerState, nativeDocker, notInContainers, routeAround, startWorkers, unroute, type Workers } from "./docker.js";
import { outsideIp } from "./measure.js";
import { target, type Entry, type Result } from "./probe.js";
import { Scan } from "./scan.js";
import type { Checker } from "./watch.js";
import { connectState, session } from "./windscribe.js";

// ponytail: checks a list of ~10 in about a minute, with far less load than a scan; raise if lists grow. They use the first
// containers' volumes, as a parallel scan does: the WireGuard keys in there are registered with the account already
const CONTAINERS = 3;

/** Checks in docker containers, which stay up between the checks until stop(); timeout: seconds to wait for each connection.
 * One thing at a time: a check, or a stop, waits for the one before it to end (a stop makes it end within seconds) */
export function dockerChecker(timeout: number): Checker {
  let workers: Workers | null = null, subnet = "", off = "";
  let abort = new AbortController(); // stop() ends what's running
  let queue: Promise<unknown> = Promise.resolve();
  const later = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  const say = (text: string) => (checker.status = text);

  /** Gets the containers up, unless they are; false when it can't, or was stopped */
  const ready = async (list: Entry[], stopped: () => boolean, signal: AbortSignal): Promise<boolean> => {
    const over = () => stopped() || signal.aborted;
    if (off) return say(off), false;
    if (workers?.alive()) return true;
    say("checking docker");
    if ((await dockerState()) !== "ready") return say("docker isn't running: they try again next time"), false;
    const s = session();
    if (!s) return say("can't find this computer's Windscribe session for the containers: update the Windscribe app"), false;
    say("getting the containers' image ready (the first time takes a few minutes)");
    await buildImage(() => {}, signal);
    if (over()) return false;
    if (nativeDocker()) subnet ||= await directNetwork(); // routed around your VPN before each check
    if (over()) return false;
    const n = Math.max(1, Math.min(CONTAINERS, list.length));
    say(`starting ${n} container${n > 1 ? "s" : ""} (about a minute)`);
    const w = await startWorkers(n, s, () => {}, { network: subnet ? DIRECT_NETWORK : undefined, tag: "check-", signal });
    if (over()) return await w.stop(), false;
    if (!w.probers.length) return say("no container got ready: they try again next time"), false;
    workers = w;
    say("");
    return true;
  };

  /** Whether the containers go out their own way: compared with your VPN's IP while you're connected */
  const direct = async (w: Workers): Promise<boolean> => {
    const vpn = (await connectState()).startsWith("Connected") ? await outsideIp() : "";
    if (!vpn || vpn !== (await w.whoami())) return true;
    off = nativeDocker() ? "off: their traffic goes through your VPN, and routing it around didn't work"
      : "off: Docker Desktop sends their traffic through your VPN (excluding docker in Windscribe's split tunneling lets them check)";
    say(off);
    return false;
  };

  const check = async (list: Entry[], stopped: () => boolean, signal: AbortSignal): Promise<Result[] | null> => {
    const over = () => stopped() || signal.aborted;
    if (!(await ready(list, stopped, signal)) || over()) return null;
    const w = workers!;
    if (subnet) await routeAround(subnet); // again each time: you may be on another network now
    if (!(await direct(w))) return (workers = null), await w.stop(), null;
    if (over()) return null;
    // what the containers can't run (IKEv2, WireGuard on Docker Desktop's own kernel) stays as it was
    const skip = notInContainers(list.map((e) => e.protocol), w.wireguard);
    const only = list.filter((e) => !skip.has(e.protocol)).map((e) => ({ country: target(e), protocol: e.protocol }));
    if (!only.length) return say("the containers can't run these protocols"), null;
    const scan = new Scan([], [], { timeout, speedTest: false, only }, w.probers);
    say(`checking ${only.length} in ${w.probers.length} container${w.probers.length > 1 ? "s" : ""}`);
    const tick = setInterval(() => over() && scan.stop(), 500);
    try {
      await scan.run({ result: () => say(`checking: ${scan.done} of ${scan.total}`) });
    } finally {
      clearInterval(tick);
    }
    if (!w.alive()) workers = null; // they stopped: started again next time
    if (over()) return null;
    if (!scan.results.length) return say(scan.errors[0] ?? "nothing got checked"), null;
    say("");
    return scan.results;
  };

  const guarded = <T>(fn: (signal: AbortSignal) => Promise<T | null>) => later(async () => {
    try {
      return await fn(abort.signal);
    } catch (e) {
      if (!abort.signal.aborted) say(`couldn't check: ${(e as Error).message}`);
      return null;
    }
  });

  const checker: Checker = {
    status: "",
    prepare: (list, stopped) => guarded(async (signal) => (await ready(list, stopped, signal)) || null).then(Boolean),
    check: (list, stopped) => guarded((signal) => check(list, stopped, signal)),
    stop() {
      abort.abort();
      return later(async () => {
        const w = workers;
        workers = null;
        await w?.stop();
        await unroute();
        say("");
        off = ""; // turned on again: they try again
        abort = new AbortController();
      });
    },
  };
  return checker;
}

// Publishes hostd through `tailscale serve` (SPEC 5.3). It only ever ADDS entries (SPEC 7): it never
// removes or rewrites anything that is already served, and it refuses to touch a port something else holds.
//   bun run deploy/serve.ts
// Prints `before: <status json>`, adds what is missing, prints `after: <status json>`. Exit 1 = a port is
// held by something else (nothing was changed) or tailscale failed.
//
// GUESS: the status JSON shape below (`TCP` port -> {HTTPS}, `Web` "<host>:<port>" -> {Handlers: {"/": {Proxy}}},
// `{}` when nothing is served) comes from tailscale's serve config format. The raw status is printed first so the
// real shape is visible before anything changes.

import { loadConfig, selfFromTailscale } from "../server/src/config";
import { run } from "../server/src/exec";
import { asRecord, asString } from "../server/src/json";
import { configPath } from "../server/src/main";

/** Port on the tailnet name -> the local address Porthole serves there. */
const TARGETS: ReadonlyArray<readonly [port: string, target: string]> = [
  ["443", "http://127.0.0.1:8797"],
  ["8443", "http://127.0.0.1:8798"],
];

/** Every tailscale call here runs with stdin ignored (`run` never gives the child a terminal) and is killed after this long. */
const TAILSCALE_TIMEOUT_MS = 30_000;

export function planServe(status: unknown, host: string): { add: string[][]; refuse: string } {
  const st = asRecord(status);
  const tcp = asRecord(st.TCP);
  const web = asRecord(st.Web);
  const add: string[][] = [];
  const refuse: string[] = [];
  for (const [port, target] of TARGETS) {
    const entry = web[host + ":" + port];
    if (entry !== undefined) {
      const proxy = asString(asRecord(asRecord(asRecord(entry).Handlers)["/"]).Proxy);
      if (proxy !== target) refuse.push("port " + port + " already serves " + (proxy || "something else") + ", not " + target);
    } else if (tcp[port] !== undefined) {
      refuse.push("port " + port + " is already in use by another tailscale serve entry");
    } else {
      add.push(["serve", "--bg", "--https=" + port, target]);
    }
  }
  return refuse.length ? { add: [], refuse: refuse.join("; ") } : { add, refuse: "" };
}

async function statusJson(bin: string): Promise<unknown> {
  const r = await run([bin, "serve", "status", "--json"], { timeoutMs: TAILSCALE_TIMEOUT_MS });
  if (r.code !== 0) throw new Error("tailscale serve status failed: " + r.stderr.trim());
  return JSON.parse(r.stdout);
}

if (import.meta.main) {
  try {
    const bin = loadConfig(configPath()).bin.tailscale;
    const before = await statusJson(bin);
    console.log("before: " + JSON.stringify(before));
    const host = new URL((await selfFromTailscale(bin)).origin).host;
    const plan = planServe(before, host);
    if (plan.refuse) {
      console.log("refused, nothing changed: " + plan.refuse);
      process.exit(1);
    }
    for (const argv of plan.add) {
      const r = await run([bin, ...argv], { timeoutMs: TAILSCALE_TIMEOUT_MS });
      console.log("tailscale " + argv.join(" ") + " -> exit " + r.code + (r.stderr.trim() ? ": " + r.stderr.trim() : ""));
      if (r.code !== 0) process.exit(1);
    }
    console.log("after: " + JSON.stringify(await statusJson(bin)));
  } catch (e) {
    console.log(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

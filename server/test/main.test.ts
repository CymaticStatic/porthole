import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { planServe } from "../../deploy/serve";
import { localTokenPath } from "../src/auth/localtoken";
import { cleanEnv } from "../src/exec";
import { configPath } from "../src/main";
import { Scratch, useTestTimeout } from "./helpers/scratch";

useTestTimeout();

const BUN = process.execPath;
const REPO = path.join(import.meta.dir, "..", "..");
const MAIN = path.join(REPO, "server", "src", "main.ts");
const REAL_STATE = path.join(homedir(), ".local", "state", "porthole");

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

/** Names, sizes and times of the real state folder, to prove a test wrote nothing there. */
function snapshot(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().map((n) => {
    const st = statSync(path.join(dir, n));
    return n + ":" + st.size + ":" + st.mtimeMs;
  });
}

async function readUntil(stream: ReadableStream<Uint8Array>, re: RegExp, ms: number): Promise<RegExpExecArray> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  const deadline = Date.now() + ms;
  let out = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)]);
    if (chunk === null || chunk.done) break;
    out += dec.decode(chunk.value);
    const m = re.exec(out);
    if (m) {
      reader.releaseLock();
      return m;
    }
  }
  throw new Error("no match for " + re.source + " in: " + out);
}

test("configPath honours PORTHOLE_CONFIG, else uses HOME", () => {
  expect(configPath({ PORTHOLE_CONFIG: "/x/hostd.json", HOME: "/home/x" })).toBe("/x/hostd.json");
  expect(configPath({ HOME: "/home/x" })).toBe("/home/x/.config/porthole/hostd.json");
});

test("init-config writes the PORTHOLE_CONFIG file from the given tailscale, 0600, and never overwrites", () => {
  const file = path.join(s.root, "cfg", "hostd.json");
  const argv = [BUN, MAIN, "init-config", "--tailscale", path.join(s.fakeBin, "tailscale")];
  const env = cleanEnv({ PORTHOLE_CONFIG: file, HOME: s.root });
  const first = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" });
  expect(first.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ machineName: "testhost", origin: "https://testhost.example.ts.net", peers: [] });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const second = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe" });
  expect(second.exitCode).toBe(0);
  expect(second.stdout.toString()).toContain("kept existing");
  expect(s.fakeCalls("tailscale")).toEqual([["status", "--json"]]);
  expect(existsSync(path.join(s.root, ".config", "porthole", "hostd.json"))).toBe(false);
});

test("a started main.ts uses only its scratch config, lists only scratch sessions, and exits 0 on SIGTERM", async () => {
  const before = snapshot(REAL_STATE);
  const sock = s.newTmuxServer("only-scratch");
  const file = path.join(s.root, "hostd.json");
  writeFileSync(file, JSON.stringify(s.config()), { mode: 0o600 });
  const proc = Bun.spawn([BUN, MAIN], { env: cleanEnv({ PORTHOLE_CONFIG: file, HOME: s.root, XDG_RUNTIME_DIR: s.runtimeDir }), stdout: "pipe", stderr: "pipe" });
  try {
    const m = await readUntil(proc.stdout, /porthole hostd 0\.1\.0 on 127\.0\.0\.1:(\d+)/, 10_000);
    const base = "http://127.0.0.1:" + m[1];
    const headers = { "X-Porthole": "1", "X-Porthole-Local": readFileSync(localTokenPath(s.runtimeDir), "utf8").trim() };
    const machine = await fetch(base + "/v1/machine", { headers });
    expect(machine.status).toBe(200);
    expect(((await machine.json()) as { name: string }).name).toBe("testhost");
    const tree = (await (await fetch(base + "/v1/sessions", { headers })).json()) as { sessions: { id: string }[] };
    expect(tree.sessions.map((x) => x.id)).toEqual(["tmux:" + sock + ":only-scratch:0.0"]);
    expect(existsSync(path.join(s.stateDir, "access.log"))).toBe(true);
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  expect(snapshot(REAL_STATE)).toEqual(before);
}, 20_000);

test("unit file, install script and serve script follow SPEC 7", () => {
  const unit = readFileSync(path.join(REPO, "deploy", "porthole.service"), "utf8");
  for (const line of ["UMask=0077", "Restart=on-failure", "RestartSec=5", "StartLimitIntervalSec=60", "StartLimitBurst=5", "WantedBy=default.target", "ExecStart=/home/cymatic/.local/share/mise/installs/bun/latest/bin/bun run %h/.local/share/porthole/hostd/current/server/src/main.ts"]) {
    expect(unit).toContain(line);
  }
  const install = readFileSync(path.join(REPO, "deploy", "install.sh"), "utf8");
  const serve = readFileSync(path.join(REPO, "deploy", "serve.ts"), "utf8");
  for (const src of [install, serve]) {
    expect(src).not.toMatch(/\bsudo\b/);
    expect(src).not.toMatch(/tailscaled/);
  }
  expect(install).toContain("systemctl --user enable --now porthole.service");
  // A service that was already running is restarted after `current` is re-pointed.
  expect(install).toContain("systemctl --user restart porthole.service");
  expect(install.indexOf("ln -sfn")).toBeLessThan(install.indexOf("systemctl --user restart porthole.service"));
  // serve.ts gives every tailscale call an explicit timeout.
  expect(serve).toContain("timeoutMs: TAILSCALE_TIMEOUT_MS");
  // serve.ts only adds entries (SPEC 7): it never calls `tailscale serve reset` or `... off`.
  expect(serve).not.toMatch(/\breset\b/);
  expect(serve).not.toMatch(/\boff\b/);
});

test("planServe adds only Porthole's two entries and refuses a port something else holds", () => {
  const host = "testhost.example.ts.net";
  const api = "http://127.0.0.1:8797";
  const preview = "http://127.0.0.1:8798";
  const web = (port: string, proxy: string) => ({ [host + ":" + port]: { Handlers: { "/": { Proxy: proxy } } } });
  expect(planServe({}, host)).toEqual({ refuse: "", add: [["serve", "--bg", "--https=443", api], ["serve", "--bg", "--https=8443", preview]] });
  const ours = { TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } }, Web: { ...web("443", api), ...web("8443", preview) } };
  expect(planServe(ours, host)).toEqual({ refuse: "", add: [] });
  const clash = { TCP: { "443": { HTTPS: true } }, Web: web("443", "http://127.0.0.1:3000") };
  const r = planServe(clash, host);
  expect(r.add).toEqual([]);
  expect(r.refuse).toContain("443");
  const unrelated = { TCP: { "10000": { HTTPS: true } }, Web: web("10000", "http://127.0.0.1:3000") };
  expect(planServe(unrelated, host).add.map((a) => a[2])).toEqual(["--https=443", "--https=8443"]);
});

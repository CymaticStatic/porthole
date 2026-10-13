import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defaultConfig, loadConfig, validateConfig, writeInitialConfig } from "../src/config";
import { Scratch } from "./helpers/scratch";

let s: Scratch;
beforeEach(() => { s = new Scratch(); });
afterEach(() => s.cleanup());

test("defaults match the spec", () => {
  const c = defaultConfig();
  expect(c.host).toBe("127.0.0.1");
  expect(c.apiPort).toBe(8797);
  expect(c.bin).toEqual({ tmux: "/usr/bin/tmux", herdr: "/usr/bin/herdr", pactl: "/usr/bin/pactl", tailscale: "/usr/bin/tailscale" });
  expect(c.tmuxSocketDir).toMatch(/^\/tmp\/tmux-\d+$/);
  expect(c.allowedLogin).toBe("bengovernale@gmail.com");
  expect(c.allowedNodes).toEqual(["bencell", "benacer-omarchy", "bendesk-omarchy"]);
  expect(c.pendingAfterMs).toBe(30_000);
  expect(c.singleForwardedFor).toBe(false);
  expect(c.stateDir.endsWith("/.local/state/porthole")).toBe(true);
});

test("file values override defaults and test overrides win; bin merges per key", () => {
  const file = path.join(s.root, "hostd.json");
  writeFileSync(file, JSON.stringify({ machineName: "bendesk-omarchy", origin: "https://bendesk-omarchy.tailafe04c.ts.net", bin: { herdr: "/opt/herdr" } }));
  const c = loadConfig(file, { apiPort: 0, bin: { pactl: "/x/pactl" } });
  expect(c.machineName).toBe("bendesk-omarchy");
  expect(c.apiPort).toBe(0);
  expect(c.bin).toEqual({ tmux: "/usr/bin/tmux", herdr: "/opt/herdr", pactl: "/x/pactl", tailscale: "/usr/bin/tailscale" });
});

test("validation rejects relative binaries, origins with ports, and non-loopback hosts", () => {
  const c = { ...defaultConfig(), machineName: "m", origin: "https://m.example.ts.net:8443", bin: { ...defaultConfig().bin, tmux: "tmux" } };
  const problems = validateConfig(c);
  expect(problems.join("\n")).toContain("origin");
  expect(problems.join("\n")).toContain("bin.tmux");
  expect(() => loadConfig(null, { machineName: "m", origin: "https://m.example.ts.net", host: "0.0.0.0" as "127.0.0.1" })).toThrow("host");
});

test("init-config reads this machine's name from tailscale and never overwrites", async () => {
  const file = path.join(s.root, "cfg", "hostd.json");
  const msg = await writeInitialConfig(file, path.join(s.fakeBin, "tailscale"));
  expect(msg).toContain("https://testhost.example.ts.net");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ machineName: "testhost", origin: "https://testhost.example.ts.net", peers: [] });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(await writeInitialConfig(file, path.join(s.fakeBin, "tailscale"))).toContain("kept existing");
});

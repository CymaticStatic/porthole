// Fake tailscale 1.102.4 for tests: `status --json` (Self.DNSName) and `whois --json <ip>`.
// $FAKE_DIR/tailscale-whois.json maps ip → {node, login}; unknown ips exit 1 like the real CLI.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_DIR ?? "";
const argv = process.argv.slice(2);
appendFileSync(path.join(dir, "tailscale-calls.log"), JSON.stringify(argv) + "\n");
const [cmd, flag, ip] = argv;
if (cmd === "status" && flag === "--json") {
  process.stdout.write(JSON.stringify({ Self: { DNSName: "testhost.example.ts.net.", HostName: "testhost" } }));
  process.exit(0);
}
if (cmd === "whois" && flag === "--json" && ip) {
  const f = path.join(dir, "tailscale-whois.json");
  const map = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, { node: string; login: string }>) : {};
  const who = map[ip];
  if (!who) {
    process.stderr.write("no match for IP:port " + ip + "\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ Node: { Name: who.node + ".example.ts.net.", ComputedName: who.node }, UserProfile: { LoginName: who.login } }));
  process.exit(0);
}
process.stderr.write("fake tailscale: unsupported " + argv.join(" ") + "\n");
process.exit(1);

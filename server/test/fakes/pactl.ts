// Fake pactl 17.0 for tests: only `pactl -f json list source-outputs` (plan Verified facts 14).
// Prints $FAKE_DIR/pactl-source-outputs.json (default []); $FAKE_DIR/pactl-fail makes it fail.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_DIR ?? "";
const argv = process.argv.slice(2);
appendFileSync(path.join(dir, "pactl-calls.log"), JSON.stringify(argv) + "\n");
if (existsSync(path.join(dir, "pactl-fail"))) {
  process.stderr.write("Connection failure: Connection refused\n");
  process.exit(1);
}
if (argv.join(" ") !== "-f json list source-outputs") {
  process.stderr.write("fake pactl: unsupported " + argv.join(" ") + "\n");
  process.exit(1);
}
const f = path.join(dir, "pactl-source-outputs.json");
process.stdout.write(existsSync(f) ? readFileSync(f, "utf8") : "[]");

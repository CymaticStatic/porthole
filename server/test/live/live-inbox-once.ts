// One live check of the inbox route against a real, throwaway omp (P1.3 a). Run once; never rerun,
// whether it passes or fails. Exit 0 = pass, 1 = fail (stop, report to Ben), 2 = could not start.
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Deliverer } from "../../src/deliver/deliver";
import { inboxDir } from "../../src/deliver/inbox";
import { SentLog } from "../../src/deliver/sentlog";
import { Registry } from "../../src/sessions/registry";
import { Scratch, waitFor } from "../helpers/scratch";

const repo = path.join(import.meta.dir, "..", "..", "..");
const omp = Bun.which("omp");
if (!omp) {
  console.log("CANNOT RUN: omp is not on PATH");
  process.exit(2);
}
const s = new Scratch();
mkdirSync(s.runtimeDir, { recursive: true, mode: 0o700 });
const cfg = s.config({ inboxRoot: path.join(s.runtimeDir, "omp-inbox"), pendingAfterMs: 30_000 });
const registry = new Registry(cfg);
const log = new SentLog(cfg.stateDir);
const d = new Deliverer(cfg, registry, log);
let code = 1;
let ompPid = 0;
try {
  const cmd = "XDG_RUNTIME_DIR='" + s.runtimeDir + "' '" + omp + "' --no-extensions -e '" + path.join(repo, "omp-extension", "live-inbox.ts") + "' --no-session --model haiku";
  s.newTmuxServer("live-inbox", cmd, s.root);
  let id = "";
  await waitFor(async () => {
    const t = await registry.scan();
    const found = t.sessions.find((x) => x.omp?.inbox);
    if (found?.omp) {
      id = found.id;
      ompPid = found.omp.pid;
    }
    return id !== "";
  }, 60_000, 500);
  const dir = inboxDir(cfg.inboxRoot, ompPid);
  console.log("omp pid " + ompPid + ", inbox " + dir);
  const first = await d.send(id, "porthole-live-1", "reply with the word porthole");
  console.log("first send: " + first.status + " " + first.reason);
  const linesBefore = readFileSync(log.file, "utf8").split("\n").filter(Boolean).length;
  const second = await d.send(id, "porthole-live-1", "reply with the word porthole");
  await Bun.sleep(2000);
  const leftover = readdirSync(dir).filter((f) => f.includes("porthole-live-1"));
  const linesAfter = readFileSync(log.file, "utf8").split("\n").filter(Boolean).length;
  console.log("second send: " + second.status + ", files left: " + JSON.stringify(leftover) + ", new sent.jsonl lines: " + (linesAfter - linesBefore));
  const pass = first.status === "delivered" && second.at === first.at && leftover.length === 0 && linesAfter === linesBefore;
  console.log(pass ? "PASS" : "FAIL: stop, do not rerun, report to Ben");
  code = pass ? 0 : 1;
} catch (e) {
  console.log("FAIL: " + (e instanceof Error ? e.message : String(e)) + " (stop, do not rerun, report to Ben)");
} finally {
  if (ompPid > 0 && existsSync("/proc/" + ompPid)) process.kill(ompPid, "SIGTERM");
  s.cleanup();
}
process.exit(code);

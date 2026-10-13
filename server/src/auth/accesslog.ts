// One JSON line per request: who and what, never message text (SPEC 5.4).

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AccessEntry { device: string; method: string; route: string; session: string; status: number; reason: string }

export class AccessLog {
  readonly file: string;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    this.file = path.join(stateDir, "access.log");
    writeFileSync(this.file, "", { mode: 0o600, flag: "a" });
    chmodSync(this.file, 0o600);
  }

  write(e: AccessEntry): void {
    const line: { at: string } & AccessEntry = { at: new Date().toISOString(), ...e };
    appendFileSync(this.file, JSON.stringify(line) + "\n");
  }
}

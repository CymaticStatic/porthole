// Token for local tools and tests (SPEC 5.4): $XDG_RUNTIME_DIR/porthole/local-token, 0600 in a 0700 folder.

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function localTokenPath(runtimeDir: string): string {
  return path.join(runtimeDir, "local-token");
}

export function ensureLocalToken(runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  chmodSync(runtimeDir, 0o700);
  const file = localTokenPath(runtimeDir);
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return readFileSync(file, "utf8").trim();
}

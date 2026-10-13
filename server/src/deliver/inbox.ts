// Live inbox sender: same contract as deliver() in idea-board 94bcde4 live-inbox/omp-voice
// (write ".<name>.part", rename to "<name>", delivered once the extension removed it).

import { existsSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CLIENT_MSG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const MAX_MESSAGE_BYTES = 512 * 1024;

export interface Staged { part: string; final: string }

export function inboxDir(inboxRoot: string, pid: number): string {
  return path.join(inboxRoot, String(pid));
}

export function stageInbox(dir: string, clientMsgId: string, text: string): Staged {
  const final = path.join(dir, clientMsgId + ".msg");
  // A rename over an unconsumed file would silently replace that message.
  if (existsSync(final)) throw new Error("inbox file already exists: " + final);
  const part = path.join(dir, "." + clientMsgId + ".msg.part");
  writeFileSync(part, text, { mode: 0o600 });
  return { part, final };
}

export function commitInbox(s: Staged): void {
  renameSync(s.part, s.final);
}

export async function waitTaken(file: string, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (existsSync(file)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(stepMs);
  }
  return true;
}

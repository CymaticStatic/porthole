// Delivery (SPEC 4.5): send a message to a session exactly once (inbox, tmux or herdr), and the key row.
// A message id is looked up and delivered inside a per-id lock, so the same id twice never types twice.

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import type { HostdConfig } from "../config";
import { prompt, sendKeys as herdrSendKeys, herdrError } from "../sessions/herdr";
import { ompAlive } from "../sessions/procs";
import type { Registry, SessionInfo } from "../sessions/registry";
import { sendKeys, sendText } from "../sessions/tmux";
import type { TmuxWhere } from "../sessions/ids";
import { commitInbox, inboxDir, MAX_MESSAGE_BYTES, stageInbox, waitTaken } from "./inbox";
import { HERDR_KEYS, TMUX_KEYS, type KeyStep } from "./keys";
import type { SendRecord, SendRoute, SendStatus, SentLog } from "./sentlog";

export type KeyResult = { status: "sent" | "refused" | "failed"; reason: string };

const OMP_GONE = "omp exited before reading the message";
const STOPPED_TYPING = "hostd stopped while typing; check the pane";

/** Runs callbacks of one key one after the other. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class Deliverer {
  private readonly idLock = new KeyedLock();
  private readonly sessionLock = new KeyedLock();
  private readonly inFlight = new Set<string>();

  constructor(private readonly cfg: HostdConfig, private readonly registry: Registry, private readonly sentLog: SentLog) {}

  status(clientMsgId: string): SendRecord | undefined {
    return this.sentLog.latest(clientMsgId);
  }

  hasPending(): boolean {
    return this.sentLog.pending().length > 0;
  }

  send(sessionId: string, clientMsgId: string, text: string): Promise<SendRecord> {
    return this.idLock.run(clientMsgId, async () => {
      // Under the id lock nothing else (nor reconcilePending) writes a record for this id until we return.
      this.inFlight.add(clientMsgId);
      try {
        const latest = this.sentLog.latest(clientMsgId);
        if (latest && (latest.status === "delivered" || latest.status === "pending")) {
          if (latest.sessionId === sessionId) return latest;
          return { ...latest, sessionId, status: "refused", reason: "this message id was already used for another session", route: "none", text: "" };
        }
        return await this.sessionLock.run(sessionId, () => this.deliver(sessionId, clientMsgId, text));
      } finally {
        this.inFlight.delete(clientMsgId);
      }
    });
  }

  private record(sessionId: string, clientMsgId: string, text: string, status: SendStatus, reason: string, route: SendRoute, pid: number | null = null, file: string | null = null): SendRecord {
    return this.sentLog.append({ clientMsgId, sessionId, status, reason, route, text, pid, file });
  }

  private async deliver(sessionId: string, clientMsgId: string, text: string): Promise<SendRecord> {
    const refuse = (reason: string, keepText = true) => this.record(sessionId, clientMsgId, keepText ? text : "", "refused", reason, "none");
    if (text.trim() === "") return refuse("the message is empty");
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) return refuse("the message is longer than " + MAX_MESSAGE_BYTES / 1024 + " KiB", false);

    const info = await this.registry.get(sessionId, 0);
    if (info === null) return refuse("no such session");

    if (info.kind === "herdr") {
      const where = info.where;
      if (where.kind !== "herdr") return refuse("no such session");
      if (info.liveVoice === null) return refuse("cannot tell if live voice is on for this herdr pane");
      if (info.liveVoice) return refuse("live voice is on");
      if (info.herdrStatus === "blocked") return refuse("the agent is showing a question; answer it with the key row first");
      this.record(sessionId, clientMsgId, text, "pending", "", "herdr");
      const r = await prompt(this.cfg, where.pane, text);
      return r.ok
        ? this.record(sessionId, clientMsgId, text, "delivered", "", "herdr")
        : this.record(sessionId, clientMsgId, text, "failed", "herdr could not send: " + r.error, "herdr");
    }

    if (info.omp?.inbox) return this.viaInbox(sessionId, clientMsgId, text, info.omp.pid);
    if (info.omp) {
      if (info.liveVoice === true) return refuse("live voice is on and this omp has no inbox; turn live voice off or restart omp");
      if (info.liveVoice === null) return refuse("cannot tell if live voice is on; refusing to type into this omp");
    }
    const where = info.where;
    if (where.kind !== "tmux") return refuse("no such session");
    this.record(sessionId, clientMsgId, text, "pending", "", "tmux");
    const r = await sendText(this.cfg, where, text);
    return r.ok
      ? this.record(sessionId, clientMsgId, text, "delivered", "", "tmux")
      : this.record(sessionId, clientMsgId, text, "failed", "tmux could not type: " + r.error, "tmux");
  }

  private async viaInbox(sessionId: string, clientMsgId: string, text: string, pid: number): Promise<SendRecord> {
    const dir = inboxDir(this.cfg.inboxRoot, pid);
    let staged;
    try {
      staged = stageInbox(dir, clientMsgId, text);
    } catch (e) {
      return this.record(sessionId, clientMsgId, text, "failed", "could not write to the omp inbox: " + (e instanceof Error ? e.message : String(e)), "inbox", pid);
    }
    const pending = this.record(sessionId, clientMsgId, text, "pending", "", "inbox", pid, staged.final);
    try {
      commitInbox(staged);
    } catch (e) {
      rmSync(staged.part, { force: true });
      return this.record(sessionId, clientMsgId, text, "failed", "could not write to the omp inbox: " + (e instanceof Error ? e.message : String(e)), "inbox", pid, staged.final);
    }
    if (!(await waitTaken(staged.final, this.cfg.pendingAfterMs))) return pending;
    // The file is gone: omp took it, or omp exited and its inbox folder went with it.
    return this.inboxGone(pending);
  }

  /** The message file no longer exists: delivered only when omp is still there (folder present, process alive). */
  private inboxGone(r: SendRecord): SendRecord {
    const pid = r.pid ?? 0;
    const alive = existsSync(inboxDir(this.cfg.inboxRoot, pid)) && ompAlive(pid);
    return this.record(r.sessionId, r.clientMsgId, r.text, alive ? "delivered" : "failed", alive ? "" : OMP_GONE, r.route, r.pid, r.file);
  }

  /** Finishes every pending record that no send in this process is working on. */
  async reconcilePending(): Promise<void> {
    for (const r of this.sentLog.pending()) {
      if (this.inFlight.has(r.clientMsgId)) continue;
      try {
        this.reconcileOne(r);
      } catch {
        // One broken record must not stop the others; it stays pending and is tried again.
      }
    }
  }

  private reconcileOne(r: SendRecord): void {
    const fail = (reason: string) => this.record(r.sessionId, r.clientMsgId, r.text, "failed", reason, r.route, r.pid, r.file);
    if (r.route !== "inbox") {
      fail(STOPPED_TYPING);
      return;
    }
    if (r.file === null || r.pid === null) {
      fail(OMP_GONE);
      return;
    }
    const file = r.file;
    const part = path.join(path.dirname(file), "." + path.basename(file) + ".part");
    const alive = ompAlive(r.pid);
    if (existsSync(part)) {
      if (!alive) {
        rmSync(part, { force: true });
        fail(OMP_GONE);
        return;
      }
      try {
        commitInbox({ part, final: file });
      } catch {
        rmSync(part, { force: true });
        fail(OMP_GONE);
      }
      return;
    }
    if (existsSync(file)) {
      if (alive) return;
      rmSync(file, { force: true });
      fail(OMP_GONE);
      return;
    }
    this.inboxGone(r);
  }

  async keys(sessionId: string, steps: KeyStep[]): Promise<KeyResult> {
    return this.sessionLock.run(sessionId, async () => {
      const info = await this.registry.get(sessionId, 0);
      if (info === null) return { status: "refused", reason: "no such session" };
      if (info.kind === "herdr") return this.herdrKeys(info, steps);
      return this.tmuxKeys(info, steps);
    });
  }

  private voiceRefusal(info: SessionInfo): string | null {
    if (info.liveVoice === true) return "live voice is on; keys would mix with it";
    if (info.liveVoice === null) return "cannot tell if live voice is on, so keys are off";
    return null;
  }

  private async tmuxKeys(info: SessionInfo, steps: KeyStep[]): Promise<KeyResult> {
    const where = info.where as TmuxWhere;
    if (info.omp) {
      const why = this.voiceRefusal(info);
      if (why !== null) return { status: "refused", reason: why };
    }
    for (const step of steps) {
      let args: string[];
      if ("text" in step) args = ["-l", "--", step.text];
      else if (Object.hasOwn(TMUX_KEYS, step.key)) args = [TMUX_KEYS[step.key]];
      else args = ["-l", "--", step.key];
      const r = await sendKeys(this.cfg, where, args);
      if (!r.ok) return { status: "failed", reason: "tmux could not send the keys: " + r.error };
    }
    return { status: "sent", reason: "" };
  }

  private async herdrKeys(info: SessionInfo, steps: KeyStep[]): Promise<KeyResult> {
    if (info.where.kind !== "herdr") return { status: "refused", reason: "no such session" };
    const why = this.voiceRefusal(info);
    if (why !== null) return { status: "refused", reason: why };
    const names: string[] = [];
    for (const step of steps) {
      if ("text" in step) return { status: "refused", reason: "text steps work on tmux panes only; use Send for herdr" };
      names.push(Object.hasOwn(HERDR_KEYS, step.key) ? HERDR_KEYS[step.key] : step.key);
    }
    const r = await herdrSendKeys(this.cfg, info.where.pane, names);
    return r.ok ? { status: "sent", reason: "" } : { status: "failed", reason: "herdr could not send the keys: " + r.error };
  }
}

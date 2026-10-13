import { asObject } from "./json.js";

/** @typedef {import("./storage.js").Store} Store */
/** @typedef {{text: string, at: number, origin: string, sessionId: string}} TalkEntry */

const KEY = "porthole:talkhistory";
const CAP = 50;

/** @param {unknown} v @returns {TalkEntry | null} the entry when it has the right shape, else null */
function clean(v) {
  const e = asObject(v);
  if (typeof e.text !== "string" || e.text === "") return null;
  return {
    text: e.text,
    at: Number(e.at) || 0,
    origin: typeof e.origin === "string" ? e.origin : "",
    sessionId: typeof e.sessionId === "string" ? e.sessionId : "",
  };
}

/**
 * The last 50 successful transcriptions on this device (SPEC 4.12), newest first, backed by a Storage-like store.
 * Corrupt or missing storage reads as an empty list; a failed write (quota) is never thrown.
 * @param {Store} store @param {() => number} [now]
 */
export function createTalkHistory(store, now = Date.now) {
  /** @returns {TalkEntry[]} */
  function read() {
    try {
      const raw = store.getItem(KEY);
      const v = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(v) ? v.map(clean).filter((e) => e !== null).slice(0, CAP) : [];
    } catch {
      return [];
    }
  }
  return {
    /** @returns {TalkEntry[]} newest first */
    list: read,
    /**
     * Puts one transcription at the front, keeping the newest 50. Empty text is not kept.
     * @param {{text: string, origin?: string, sessionId?: string}} item
     * @returns {{ok: true} | {ok: false, reason: "empty" | "quota"}}
     */
    add(item) {
      const text = String(item.text ?? "").trim();
      if (text === "") return { ok: false, reason: "empty" };
      const list = [{ text, at: now(), origin: item.origin ?? "", sessionId: item.sessionId ?? "" }, ...read()].slice(0, CAP);
      try {
        store.setItem(KEY, JSON.stringify(list));
      } catch {
        return { ok: false, reason: "quota" };
      }
      return { ok: true };
    },
    clear() {
      try { store.removeItem(KEY); } catch { /* nothing to clear */ }
    },
  };
}

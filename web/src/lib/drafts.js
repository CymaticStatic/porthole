/** @typedef {import("./storage.js").Store} Store */
/** @typedef {{text: string, files: string[], updatedAt: number}} Draft */
/** @typedef {{clientMsgId: string, text: string, at: number, status: string, reason: string | null}} SentItem */

const SENT_CAP = 50;

/** @param {string} origin @param {string} sessionId */
const draftKey = (origin, sessionId) => `porthole:draft:${origin}|${sessionId}`;
/** @param {string} origin @param {string} sessionId */
const sentKey = (origin, sessionId) => `porthole:sent:${origin}|${sessionId}`;

/** @param {Store} store @param {string} key @returns {unknown} parsed JSON, or undefined when missing, unreadable or corrupt */
function readJson(store, key) {
  try {
    const raw = store.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Per machine and per session composer drafts and sent-message history, backed by a Storage-like store.
 * @param {Store} store @param {() => number} [now]
 */
export function createDrafts(store, now = Date.now) {
  return {
    /** @param {string} origin @param {string} sessionId @returns {Draft | null} */
    get(origin, sessionId) {
      const v = /** @type {any} */ (readJson(store, draftKey(origin, sessionId)));
      if (!v || typeof v !== "object" || typeof v.text !== "string" || !Array.isArray(v.files)) return null;
      return { text: v.text, files: v.files.filter((/** @type {unknown} */ f) => typeof f === "string"), updatedAt: Number(v.updatedAt) || 0 };
    },
    /**
     * An empty text with no files removes the key. A failed write (quota) is reported, never thrown.
     * @param {string} origin @param {string} sessionId @param {string} text @param {string[]} files
     * @returns {{ok: true} | {ok: false, reason: "quota"}}
     */
    put(origin, sessionId, text, files) {
      const key = draftKey(origin, sessionId);
      try {
        if (text === "" && files.length === 0) store.removeItem(key);
        else store.setItem(key, JSON.stringify({ text, files, updatedAt: now() }));
      } catch {
        return { ok: false, reason: "quota" };
      }
      return { ok: true };
    },
    /** @param {string} origin @param {string} sessionId */
    clear(origin, sessionId) {
      try { store.removeItem(draftKey(origin, sessionId)); } catch { /* nothing to clear */ }
    },
    /** @param {string} origin @param {string} sessionId @returns {SentItem[]} newest last */
    sent(origin, sessionId) {
      const v = readJson(store, sentKey(origin, sessionId));
      return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
    },
    /** Appends one item, keeping the newest 50. @param {string} origin @param {string} sessionId @param {SentItem} item */
    addSent(origin, sessionId, item) {
      const list = [...this.sent(origin, sessionId), item].slice(-SENT_CAP);
      try { store.setItem(sentKey(origin, sessionId), JSON.stringify(list)); } catch { /* history is best effort */ }
    },
  };
}

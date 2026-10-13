import { asObject } from "./json.js";

/** @typedef {import("./storage.js").Store} Store */
/**
 * @typedef {object} OutboxEntry
 * @property {string} clientMsgId
 * @property {string} origin
 * @property {string} sessionId
 * @property {string} text
 * @property {string} status
 * @property {number} at
 */
/** @typedef {import("../net/api.js").ApiResult} SendAnswer */
/** @typedef {{draft: "keep" | "clear", outbox: "keep" | "remove", show: string | null, poll: boolean}} NextAction */

const KEY = "porthole:outbox";

/** Messages the phone is holding until the machine answers (one JSON array under one key). @param {Store} store */
export function createOutbox(store) {
  /** @returns {OutboxEntry[]} */
  const read = () => {
    try {
      const raw = store.getItem(KEY);
      const v = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(v) ? v.filter((e) => e && typeof e === "object" && typeof e.clientMsgId === "string") : [];
    } catch {
      return [];
    }
  };
  /** @param {OutboxEntry[]} list */
  const write = (list) => {
    try {
      if (list.length === 0) store.removeItem(KEY);
      else store.setItem(KEY, JSON.stringify(list));
    } catch { /* the in-flight send still proceeds; only the reload survival is lost */ }
  };
  return {
    all: read,
    /** @param {string} clientMsgId @returns {OutboxEntry | null} */
    get: (clientMsgId) => read().find((e) => e.clientMsgId === clientMsgId) ?? null,
    /** Entries for one machine still waiting to be sent. @param {string} origin */
    held: (origin) => read().filter((e) => e.origin === origin && e.status === "held"),
    /** Adds an entry, replacing one with the same clientMsgId. @param {OutboxEntry} entry */
    put(entry) {
      write([...read().filter((e) => e.clientMsgId !== entry.clientMsgId), entry]);
    },
    /** @param {string} clientMsgId @param {Partial<OutboxEntry>} patch @returns {OutboxEntry | null} the updated entry */
    update(clientMsgId, patch) {
      const list = read();
      const i = list.findIndex((e) => e.clientMsgId === clientMsgId);
      if (i < 0) return null;
      list[i] = { ...list[i], ...patch, clientMsgId };
      write(list);
      return list[i];
    },
    /** @param {string} clientMsgId */
    remove(clientMsgId) {
      write(read().filter((e) => e.clientMsgId !== clientMsgId));
    },
  };
}

/**
 * Maps a hostd answer to what the composer, the outbox and the toast should do next.
 * `show` is a copy key (see copy.js). Pure.
 * @param {OutboxEntry} _entry @param {SendAnswer} answer @returns {NextAction}
 */
export function nextAction(_entry, answer) {
  if (answer.ok) {
    switch (asObject(answer.data).status) {
      case "delivered": return { draft: "clear", outbox: "remove", show: null, poll: false };
      case "pending": return { draft: "keep", outbox: "keep", show: "pendingTitle", poll: true };
      default: return { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false }; // refused, failed, or anything unknown
    }
  }
  // No answer at all (network down): hold it and try again. Any HTTP answer is final.
  if (answer.status === 0) return { draft: "keep", outbox: "keep", show: "sendHeld", poll: false };
  return { draft: "keep", outbox: "remove", show: "sendFailedTitle", poll: false };
}

/**
 * Chat item store for one session. Pure: no DOM, no timers.
 * Items are unique by `id` and kept in cursor order. An assistant message's text item and its
 * tools item share one cursor (server/src/transcript/parse.ts), so ordering inside one cursor is
 * the order the items first arrived in.
 */

/**
 * @typedef {object} ChatItem
 * @property {number} cursor
 * @property {string} id
 * @property {string} at
 * @property {"user" | "assistant" | "tools"} kind
 * @property {string} text
 * @property {string[]} tools
 * @property {"typed" | "live-voice" | null} via
 * @property {string | null} stopReason
 */
/** @typedef {{items: ChatItem[], start: number, end: number, hasOlder: boolean}} ChatPage */

/**
 * @returns {{
 *   backlog(page: ChatPage): ChatItem[],
 *   append(items: ChatItem[], end?: number): ChatItem[],
 *   older(page: ChatPage): ChatItem[],
 *   items(): ChatItem[],
 *   newestAssistant(): ChatItem | null,
 * }}
 */
export function createChat() {
  /** @type {ChatItem[]} */
  let list = [];
  /** @type {Set<string>} */
  const ids = new Set();

  /** Merge items, return only the ones not seen before (in the order given). @param {ChatItem[]} incoming */
  function merge(incoming) {
    /** @type {ChatItem[]} */
    const fresh = [];
    for (const item of incoming) {
      if (ids.has(item.id)) continue;
      ids.add(item.id);
      fresh.push(item);
    }
    if (fresh.length > 0) {
      // Array.prototype.sort is stable: items sharing a cursor keep their arrival order.
      list = list.concat(fresh).sort((a, b) => a.cursor - b.cursor);
    }
    return fresh;
  }

  return {
    /** The newest page (first load, and again after every reconnect). Returns the items not seen before. */
    backlog: (page) => merge(page.items),
    /** Live items. `end` is the server's newest cursor; the model needs no use for it. Returns the new items. */
    append: (items, _end) => merge(items),
    /** An earlier page ("Show earlier"). Returns the items not seen before. */
    older: (page) => merge(page.items),
    items: () => list.slice(),
    newestAssistant() {
      for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === "assistant") return list[i];
      return null;
    },
  };
}

/** "Used 2 tools: read, grep". @param {{tools: string[]}} item */
export function toolSummary(item) {
  const n = item.tools.length;
  if (n === 0) return "Used tools";
  return `Used ${n} ${n === 1 ? "tool" : "tools"}: ${item.tools.join(", ")}`;
}

/**
 * Of the items that just arrived, the ones that are the final assistant message of a finished turn
 * (`stopReason === "stop"`). Text written before a tool call (`toolUse`) and half-written
 * messages (`null`) are never returned, so they are never read aloud.
 * @param {ChatItem[]} newItems
 */
export function finishedReplies(newItems) {
  return newItems.filter((i) => i.kind === "assistant" && i.stopReason === "stop");
}

/** @typedef {Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">} Store */

/**
 * An in-memory Storage-like object: for tests, and the fallback when localStorage throws on access
 * (private mode, blocked cookies).
 * @returns {Store}
 */
export function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? /** @type {string} */ (m.get(k)) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

/**
 * `localStorage` when the browser allows touching it, else a memory store (so the UI still works, it just
 * forgets on reload).
 * @returns {Store}
 */
export function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    if (s) return s;
  } catch { /* access threw: fall through */ }
  return memoryStorage();
}

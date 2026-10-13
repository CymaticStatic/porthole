// Adapter for the Android app's `PortholeNative` object (addWebMessageListener). In a plain browser every
// call resolves to null and the caller uses its web fallback.

/** The only method names the page will send; anything else is refused before it leaves the page. */
const ALLOWED = new Set(["machines", "speak", "stopSpeaking", "startRecording", "stopRecording", "pickFile", "openExternal"]);

/**
 * @param {Record<string, any>} win `window`, or `{}` outside a browser
 * @returns {{available: boolean, call(method: string, args?: unknown): Promise<any>, on(event: string, fn: (data: any) => void): () => void}}
 */
export function createBridge(win) {
  const native = win ? win.PortholeNative : undefined;
  const available = !!native && typeof native.postMessage === "function";
  /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void}>} */
  const pending = new Map();
  /** @type {Map<string, Set<(data: any) => void>>} */
  const listeners = new Map();
  let nextId = 1;

  if (available) {
    native.onmessage = (/** @type {{data: unknown}} */ e) => {
      /** @type {any} */
      let msg = e.data;
      if (typeof msg === "string") {
        try { msg = JSON.parse(msg); } catch { return; }
      }
      if (!msg || typeof msg !== "object") return;
      if (typeof msg.event === "string") {
        for (const fn of [...(listeners.get(msg.event) ?? [])]) {
          try { fn(msg.data); } catch { /* one listener must not stop the others */ }
        }
        return;
      }
      const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result ?? null);
      else p.reject(new Error(typeof msg.error === "string" ? msg.error : "Native call failed"));
    };
  }

  return {
    available,
    async call(method, args = {}) {
      if (!ALLOWED.has(method)) throw new Error(`Bridge method not allowed: ${method}`);
      if (!available) return null;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          native.postMessage(JSON.stringify({ id, method, args }));
        } catch (e) {
          pending.delete(id);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      set.add(fn);
      return () => { set.delete(fn); };
    },
  };
}

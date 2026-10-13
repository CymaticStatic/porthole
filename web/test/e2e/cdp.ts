// A small Chrome DevTools Protocol client for one page of a throwaway headless Chromium (plan C1). One WebSocket to the
// first page target; every helper the e2e tests use sits on `Page`. Nothing here knows about Porthole.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(import.meta.dir, "..", ".out");
const SEND_TIMEOUT_MS = 30_000;
const SHOT_TIMEOUT_MS = 15_000;
const CLICK_WAIT_MS = 5_000;

export interface TouchPoint { x: number; y: number; id: number }
export interface SwipeOptions { x: number; y: number; dx: number; dy: number; fingers?: number; ms?: number }

export interface Page {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Subscribes to a CDP event; returns the unsubscribe function. */
  on(event: string, fn: (params: Record<string, unknown>) => void): () => void;
  goto(url: string): Promise<void>;
  phone(): Promise<void>;
  wide(): Promise<void>;
  /** Runtime.evaluate with awaitPromise + returnByValue; throws when the page expression throws. */
  eval(expression: string): Promise<any>; // the page's own value: each caller knows its shape
  /** Polls `expression` every 100 ms until it is truthy; throws with the last value (or error) on timeout. */
  waitFor(expression: string, ms?: number): Promise<void>;
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
  reload(): Promise<void>;
  onNewDocument(source: string): Promise<void>;
  touch(type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel", points: TouchPoint[]): Promise<void>;
  swipe(o: SwipeOptions): Promise<void>;
  setFiles(selector: string, paths: string[]): Promise<void>;
  /** One screenshot into web/test/.out/<name>.png. A failure is logged and skipped, never retried. */
  shot(name: string): Promise<void>;
  close(): void;
}

interface KeyDef { key: string; code: string; vk: number; text?: string }
const KEYS: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  Escape: { key: "Escape", code: "Escape", vk: 27 },
  Tab: { key: "Tab", code: "Tab", vk: 9 },
  Backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  Delete: { key: "Delete", code: "Delete", vk: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  Home: { key: "Home", code: "Home", vk: 36 },
  End: { key: "End", code: "End", vk: 35 },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
};

function keyDef(name: string): KeyDef {
  const known = KEYS[name];
  if (known) return known;
  if (name === "Esc") return KEYS.Escape;
  if (name === "Space") return KEYS[" "];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const letter = /[A-Z]/.test(upper);
    return { key: name, code: letter ? "Key" + upper : "", vk: upper.charCodeAt(0), text: name };
  }
  throw new Error("page.key: unknown key " + JSON.stringify(name));
}

interface Pending { resolve(v: Record<string, unknown>): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }

/** Attaches to the first page target of the Chromium listening on `port`. */
export async function connectPage(port: number): Promise<Page> {
  let wsUrl = "";
  for (let i = 0; i < 100 && wsUrl === ""; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl?: string }[];
      wsUrl = list.find((t) => t.type === "page")?.webSocketDebuggerUrl ?? "";
    } catch { /* browser still starting */ }
    if (wsUrl === "") await Bun.sleep(100);
  }
  if (wsUrl === "") throw new Error("no page target on the throwaway Chromium at port " + port);

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("could not open the DevTools socket " + wsUrl));
  });

  let nextId = 1;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  let closed = false;

  ws.onmessage = (e: MessageEvent) => {
    const msg = JSON.parse(String(e.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown> };
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result ?? {});
    } else if (msg.method !== undefined) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    }
  };
  ws.onclose = () => {
    closed = true;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error("the DevTools socket closed")); }
    pending.clear();
  };

  function send(method: string, params: Record<string, unknown> = {}, timeoutMs = SEND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (closed) return Promise.reject(new Error("the DevTools socket is closed (" + method + ")"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP " + method + " timed out after " + timeoutMs + " ms")); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function on(event: string, fn: (p: Record<string, unknown>) => void): () => void {
    let set = listeners.get(event);
    if (!set) { set = new Set(); listeners.set(event, set); }
    set.add(fn);
    return () => { set.delete(fn); };
  }

  function once(event: string, ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error("timed out waiting for " + event)); }, ms);
      const off = on(event, () => { clearTimeout(timer); off(); resolve(); });
    });
  }

  async function evaluate(expression: string): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
      result: { value?: unknown };
      exceptionDetails?: { text: string; exception?: { description?: string; value?: unknown } };
    };
    if (r.exceptionDetails) {
      const x = r.exceptionDetails;
      throw new Error("page expression threw: " + (x.exception?.description ?? String(x.exception?.value ?? x.text)));
    }
    return r.result.value;
  }

  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");

  const page: Page = {
    send: (m, p) => send(m, p),
    on,
    async goto(url) {
      const loaded = once("Page.loadEventFired", 30_000);
      loaded.catch(() => undefined); // a same-document navigation never fires it; its rejection is only read below
      const r = (await send("Page.navigate", { url })) as { loaderId?: string; errorText?: string };
      if (r.errorText) throw new Error("goto " + url + " failed: " + r.errorText);
      // No loaderId = a same-document (hash-only) navigation: there is no load event to wait for.
      if (r.loaderId !== undefined) await loaded;
    },
    async phone() {
      await send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
      await send("Emulation.setTouchEmulationEnabled", { enabled: true });
    },
    async wide() {
      await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    },
    eval: evaluate,
    async waitFor(expression, ms = 10_000) {
      const deadline = Date.now() + ms;
      let last: unknown = undefined;
      for (;;) {
        try {
          last = await evaluate(expression);
          if (last) return;
        } catch (e) {
          last = e instanceof Error ? e.message : String(e);
        }
        if (Date.now() > deadline) throw new Error("page.waitFor timed out after " + ms + " ms: " + expression.slice(0, 200) + " (last value: " + JSON.stringify(last) + ")");
        await Bun.sleep(100);
      }
    },
    async click(selector) {
      const sel = JSON.stringify(selector);
      // The element may be a moment from rendering (a view just mounted): wait for it, then scroll it into view.
      await page.waitFor(`(() => { const el = document.querySelector(${sel}); if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`, CLICK_WAIT_MS)
        .catch(() => { throw new Error("page.click: no visible element for " + selector); });
      const pt = (await evaluate(`(() => { const el = document.querySelector(${sel}); el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`)) as { x: number; y: number };
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pt.x, y: pt.y });
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pt.x, y: pt.y, button: "left", clickCount: 1 });
    },
    async type(text) {
      await send("Input.insertText", { text });
    },
    async key(name) {
      const k = keyDef(name);
      const common = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
      await send("Input.dispatchKeyEvent", { type: k.text !== undefined ? "keyDown" : "rawKeyDown", ...common, ...(k.text !== undefined ? { text: k.text } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...common });
    },
    async reload() {
      const loaded = once("Page.loadEventFired", 30_000);
      await send("Page.reload");
      await loaded;
    },
    async onNewDocument(source) {
      await send("Page.addScriptToEvaluateOnNewDocument", { source });
    },
    async touch(type, points) {
      await send("Input.dispatchTouchEvent", { type, touchPoints: points });
    },
    async swipe({ x, y, dx, dy, fingers = 1, ms = 200 }) {
      const STEPS = 8;
      const at = (k: number): TouchPoint[] => Array.from({ length: fingers }, (_, i) => ({ x: x + i * 60 + (dx * k) / STEPS, y: y + (dy * k) / STEPS, id: i }));
      await page.touch("touchStart", at(0));
      for (let k = 1; k <= STEPS; k++) {
        await Bun.sleep(ms / STEPS);
        await page.touch("touchMove", at(k));
      }
      await page.touch("touchEnd", []);
    },
    async setFiles(selector, paths) {
      const doc = (await send("DOM.getDocument", { depth: 0 })) as { root: { nodeId: number } };
      const found = (await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector })) as { nodeId: number };
      if (!found.nodeId) throw new Error("page.setFiles: no element for " + selector);
      await send("DOM.setFileInputFiles", { files: paths, nodeId: found.nodeId });
    },
    async shot(name) {
      try {
        const r = (await send("Page.captureScreenshot", { format: "png" }, SHOT_TIMEOUT_MS)) as { data: string };
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(path.join(OUT_DIR, name + ".png"), Buffer.from(r.data, "base64"));
      } catch (e) {
        console.error("screenshot " + name + " skipped: " + (e instanceof Error ? e.message : String(e)));
      }
    },
    close() {
      closed = true;
      try { ws.close(); } catch { /* already closed */ }
    },
  };
  return page;
}

// Terminal gestures, the gesture → action map, tmux/herdr navigation plans, the Ctrl latch, mouse-wheel
// bytes and text size steps (SPEC 4.4). Pure logic: no DOM, no imports. D3 turns step names into bytes
// with A3's stepBytes.

/** @typedef {{id: number | string, x: number, y: number}} Point */
/** @typedef {{gesture: string, dy?: number}} GestureEvent */

export const ACTIONS = ["window-next", "window-prev", "pane-next", "pane-prev", "session-next", "session-prev", "text-bigger", "text-smaller", "paste", "scroll", "none"];

/** @type {Readonly<Record<string, string>>} */
export const DEFAULT_GESTURES = Object.freeze({
  "swipe1-left": "window-next",
  "swipe1-right": "window-prev",
  "swipe2-left": "pane-next",
  "swipe2-right": "pane-prev",
  "swipe2-up": "session-next",
  "swipe2-down": "session-prev",
  "pinch-out": "text-bigger",
  "pinch-in": "text-smaller",
  "double-tap": "paste",
  drag: "scroll",
});

export const FONT_STEPS = Object.freeze([10, 12, 14, 16, 18, 20, 24, 28]);

const SWIPE_MIN_PX = 60;
const SWIPE_MAX_MS = 800;
const DIRECTION_RATIO = 2;
const PINCH_OUT = 1.2;
const PINCH_IN = 0.83;
const TAP_MAX_MS = 250;
const TAP_MAX_PX = 10;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 24;
const DRAG_MIN_PX = 12;

/**
 * @typedef {{sx: number, sy: number, x: number, y: number, far: number}} Touch
 * @typedef {{t0: number, max: number, touches: Map<number | string, Touch>, dragging: boolean, dragged: boolean}} Active
 */

/** One recogniser per touch surface. `points` are every touch still on the screen. */
export function createRecognizer() {
  /** @type {Active | null} */
  let active = null;
  /** @type {{upT: number, x: number, y: number} | null} */
  let lastTap = null;

  /** @param {Touch} touch @param {Point} pt */
  function moveTouch(touch, pt) {
    touch.x = pt.x;
    touch.y = pt.y;
    touch.far = Math.max(touch.far, Math.hypot(pt.x - touch.sx, pt.y - touch.sy));
  }

  /** @param {Active} a @param {Point[]} points */
  function sync(a, points) {
    for (const pt of points) {
      const known = a.touches.get(pt.id);
      if (known) moveTouch(known, pt);
      else a.touches.set(pt.id, { sx: pt.x, sy: pt.y, x: pt.x, y: pt.y, far: 0 });
    }
  }

  /** @param {number} t @returns {GestureEvent[]} */
  function finish(t) {
    const a = /** @type {Active} */ (active);
    active = null;
    if (a.dragged) {
      lastTap = null;
      return [];
    }
    const touches = [...a.touches.values()];
    if (a.max === 1) {
      const [one] = touches;
      if (t - a.t0 < TAP_MAX_MS && one.far < TAP_MAX_PX) {
        if (lastTap && a.t0 - lastTap.upT < DOUBLE_TAP_MS && Math.hypot(one.sx - lastTap.x, one.sy - lastTap.y) < DOUBLE_TAP_PX) {
          lastTap = null;
          return [{ gesture: "double-tap" }];
        }
        lastTap = { upT: t, x: one.sx, y: one.sy };
        return [];
      }
      lastTap = null;
      const dir = swipeDirection(one.x - one.sx, one.y - one.sy, t - a.t0);
      return dir === "left" || dir === "right" ? [{ gesture: "swipe1-" + dir }] : [];
    }
    lastTap = null;
    if (a.max !== 2 || touches.length < 2) return [];
    const [f1, f2] = touches;
    const dx = (f1.x - f1.sx + f2.x - f2.sx) / 2;
    const dy = (f1.y - f1.sy + f2.y - f2.sy) / 2;
    if (Math.hypot(dx, dy) >= SWIPE_MIN_PX) {
      const dir = swipeDirection(dx, dy, t - a.t0);
      return dir ? [{ gesture: "swipe2-" + dir }] : [];
    }
    const before = Math.hypot(f1.sx - f2.sx, f1.sy - f2.sy);
    if (before === 0) return [];
    const ratio = Math.hypot(f1.x - f2.x, f1.y - f2.y) / before;
    if (ratio >= PINCH_OUT) return [{ gesture: "pinch-out" }];
    if (ratio <= PINCH_IN) return [{ gesture: "pinch-in" }];
    return [];
  }

  return {
    /** @param {number} t @param {Point[]} points @returns {GestureEvent[]} */
    down(t, points) {
      if (!active) active = { t0: t, max: 0, touches: new Map(), dragging: false, dragged: false };
      const a = active;
      sync(a, points);
      if (points.length === 2 && a.max < 2) {
        // The second finger just landed: measure two-finger gestures from here.
        a.t0 = t;
        for (const touch of a.touches.values()) {
          touch.sx = touch.x;
          touch.sy = touch.y;
          touch.far = 0;
        }
      }
      a.max = Math.max(a.max, points.length);
      if (points.length > 1) a.dragging = false;
      return [];
    },
    /** @param {number} t @param {Point[]} points @returns {GestureEvent[]} */
    move(t, points) {
      const a = active;
      if (!a) return [];
      const before = points.length === 1 ? a.touches.get(points[0].id)?.y : undefined;
      sync(a, points);
      a.max = Math.max(a.max, points.length);
      if (a.max !== 1 || points.length !== 1) return [];
      const touch = /** @type {Touch} */ (a.touches.get(points[0].id));
      if (!a.dragging && !a.dragged) {
        const dx = touch.x - touch.sx;
        const dy = touch.y - touch.sy;
        if (Math.abs(dy) >= DRAG_MIN_PX && Math.abs(dy) >= DIRECTION_RATIO * Math.abs(dx)) a.dragging = a.dragged = true;
      }
      if (!a.dragging) return [];
      const dy = touch.y - (before ?? touch.y);
      return dy === 0 ? [] : [{ gesture: "drag", dy }];
    },
    /** @param {number} t @param {Point[]} points the touches left after the lift @returns {GestureEvent[]} */
    up(t, points) {
      if (!active) return [];
      sync(active, points);
      return points.length === 0 ? finish(t) : [];
    },
  };
}

/**
 * `"left" | "right" | "up" | "down"` when the movement is a swipe, else null.
 * @param {number} dx @param {number} dy @param {number} ms
 * @returns {"left" | "right" | "up" | "down" | null}
 */
function swipeDirection(dx, dy, ms) {
  if (ms > SWIPE_MAX_MS || Math.hypot(dx, dy) < SWIPE_MIN_PX) return null;
  if (Math.abs(dx) >= DIRECTION_RATIO * Math.abs(dy)) return dx < 0 ? "left" : "right";
  if (Math.abs(dy) >= DIRECTION_RATIO * Math.abs(dx)) return dy < 0 ? "up" : "down";
  return null;
}

/**
 * The defaults with every valid saved entry laid over them; unknown gesture or action names are ignored.
 * @param {unknown} saved @returns {Record<string, string>}
 */
export function mergeGestureMap(saved) {
  const map = { ...DEFAULT_GESTURES };
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    for (const [gesture, action] of Object.entries(saved)) {
      if (Object.hasOwn(DEFAULT_GESTURES, gesture) && typeof action === "string" && ACTIONS.includes(action)) map[gesture] = action;
    }
  }
  return map;
}

/** @param {string} gesture @param {Record<string, string>} map @returns {string} */
export function gestureAction(gesture, map) {
  const own = (/** @type {Record<string, string>} */ m) => (m && Object.hasOwn(m, gesture) ? m[gesture] : undefined);
  return own(map) ?? own(DEFAULT_GESTURES) ?? "none";
}

/**
 * What the terminal does for an action.
 * @param {string} action @param {"tmux" | "herdr"} kind
 * @returns {{steps: string[]} | {navigate: {level: "window" | "pane" | "session", dir: 1 | -1}} | {local: string} | null}
 */
export function navPlan(action, kind) {
  const nav = /^(window|pane|session)-(next|prev)$/.exec(action);
  if (nav) {
    const level = /** @type {"window" | "pane" | "session"} */ (nav[1]);
    const dir = nav[2] === "next" ? 1 : -1;
    if (kind === "tmux" && level !== "session") {
      if (level === "window") return { steps: ["prefix", dir === 1 ? "n" : "p"] };
      return { steps: dir === 1 ? ["prefix", "o"] : ["prefix", ":", "text:select-pane -t :.-", "Enter"] };
    }
    return { navigate: { level, dir } };
  }
  if (action === "text-bigger" || action === "text-smaller" || action === "paste" || action === "scroll") return { local: action };
  return null;
}

const CTRL_PUNCTUATION = "@[\\]^_";

/**
 * The toolbar's Ctrl button: one tap = the next key only, a second tap within `doubleMs` = locked, any other tap = off.
 * @param {{doubleMs?: number}} [opts]
 */
export function createCtrlLatch({ doubleMs = 350 } = {}) {
  /** @type {"off" | "once" | "locked"} */
  let state = "off";
  let lastTap = 0;
  const encoder = new TextEncoder();
  return {
    /** @param {number} t @returns {"off" | "once" | "locked"} */
    tap(t) {
      if (state === "off") {
        state = "once";
        lastTap = t;
      } else if (state === "once" && t - lastTap <= doubleMs) state = "locked";
      else state = "off";
      return state;
    },
    /** The bytes to send for typed `data`. @param {string} data @returns {Uint8Array<ArrayBuffer>} */
    apply(data) {
      if (state === "off" || data === "") return encoder.encode(data);
      if (state === "once") state = "off";
      if (data.length === 1) {
        if (/^[a-zA-Z]$/.test(data) || CTRL_PUNCTUATION.includes(data)) return Uint8Array.of(data.charCodeAt(0) & 0x1f);
        if (data === " ") return Uint8Array.of(0);
      }
      return encoder.encode(data);
    },
    state: () => state,
  };
}

/**
 * SGR mouse-wheel bytes for tmux (`set -g mouse on`): lines < 0 scrolls back, lines > 0 forward.
 * @param {number} lines @param {number} col @param {number} row @returns {Uint8Array<ArrayBuffer>}
 */
export function wheelBytes(lines, col, row) {
  const count = Math.abs(Math.trunc(lines));
  return new TextEncoder().encode(`\x1b[<${lines < 0 ? 64 : 65};${col};${row}M`.repeat(count));
}

/** The next terminal text size up (dir 1) or down (dir -1), clamped. @param {number} px @param {number} dir @returns {number} */
export function nextFontSize(px, dir) {
  const steps = FONT_STEPS;
  const current = Number.isFinite(px) ? px : 14;
  if (dir > 0) return steps.find((s) => s > current) ?? steps[steps.length - 1];
  return [...steps].reverse().find((s) => s < current) ?? steps[0];
}

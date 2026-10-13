import { expect, test } from "bun:test";
import { DEFAULT_GESTURES, createCtrlLatch, createRecognizer, gestureAction, mergeGestureMap, navPlan, nextFontSize, wheelBytes } from "../../src/lib/gestures.js";

const p = (id, x, y) => ({ id, x, y });
const run = (frames, r = createRecognizer()) => frames.flatMap(([kind, t, pts]) => r[kind](t, pts)).map((e) => (e.gesture === "drag" ? `drag ${e.dy}` : e.gesture));
const text = (u8) => new TextDecoder().decode(u8);

test("one-finger swipes", () => {
  expect(run([["down", 0, [p(1, 300, 400)]], ["move", 100, [p(1, 200, 405)]], ["up", 150, []]])).toEqual(["swipe1-left"]);
  expect(run([["down", 0, [p(1, 100, 400)]], ["move", 100, [p(1, 200, 395)]], ["up", 150, []]])).toEqual(["swipe1-right"]);
});
test("two-finger swipes, sideways and up/down", () => {
  expect(run([["down", 0, [p(1, 100, 400), p(2, 100, 500)]], ["move", 100, [p(1, 200, 402), p(2, 200, 498)]], ["up", 150, []]])).toEqual(["swipe2-right"]);
  expect(run([["down", 0, [p(1, 200, 500), p(2, 300, 500)]], ["move", 100, [p(1, 202, 400), p(2, 298, 400)]], ["up", 150, []]])).toEqual(["swipe2-up"]);
});
test("pinch", () => {
  expect(run([["down", 0, [p(1, 200, 400), p(2, 260, 400)]], ["move", 100, [p(1, 170, 400), p(2, 290, 400)]], ["up", 150, []]])).toEqual(["pinch-out"]);
  expect(run([["down", 0, [p(1, 150, 400), p(2, 310, 400)]], ["move", 100, [p(1, 200, 400), p(2, 260, 400)]], ["up", 150, []]])).toEqual(["pinch-in"]);
});
test("double tap fires once, on the second tap", () => {
  expect(run([["down", 0, [p(1, 100, 100)]], ["up", 80, []], ["down", 200, [p(1, 104, 102)]], ["up", 260, []]])).toEqual(["double-tap"]);
  expect(run([["down", 0, [p(1, 100, 100)]], ["up", 80, []], ["down", 600, [p(1, 104, 102)]], ["up", 660, []]])).toEqual([]);
});
test("vertical drag reports movement and never becomes a swipe", () => {
  expect(run([["down", 0, [p(1, 100, 300)]], ["move", 50, [p(1, 101, 330)]], ["move", 100, [p(1, 101, 360)]], ["up", 150, []]])).toEqual(["drag 30", "drag 30"]);
});
test("small slow movement is nothing", () => {
  expect(run([["down", 0, [p(1, 100, 100)]], ["move", 300, [p(1, 105, 103)]], ["up", 600, []]])).toEqual([]);
});
test("the gesture map: defaults per SPEC 4.4, remapping keeps only valid entries", () => {
  expect(gestureAction("swipe1-left", DEFAULT_GESTURES)).toBe("window-next");
  expect(gestureAction("swipe2-up", DEFAULT_GESTURES)).toBe("session-next");
  expect(gestureAction("double-tap", DEFAULT_GESTURES)).toBe("paste");
  const m = mergeGestureMap({ "double-tap": "none", "pinch-in": "bogus", nope: "paste" });
  expect(m).toEqual({ ...DEFAULT_GESTURES, "double-tap": "none" });
});
test("what each action does in tmux and herdr", () => {
  expect(navPlan("window-next", "tmux")).toEqual({ steps: ["prefix", "n"] });
  expect(navPlan("pane-prev", "tmux")).toEqual({ steps: ["prefix", ":", "text:select-pane -t :.-", "Enter"] });
  expect(navPlan("session-next", "tmux")).toEqual({ navigate: { level: "session", dir: 1 } });
  expect(navPlan("window-prev", "herdr")).toEqual({ navigate: { level: "window", dir: -1 } });
  expect(navPlan("paste", "tmux")).toEqual({ local: "paste" });
  expect(navPlan("none", "tmux")).toBeNull();
});
test("Ctrl: one tap for one key, double tap locks, tap again unlocks", () => {
  const c = createCtrlLatch();
  expect(c.tap(0)).toBe("once");
  expect([...c.apply("c")]).toEqual([3]);
  expect(c.state()).toBe("off");
  expect(text(c.apply("c"))).toBe("c");
  c.tap(1000); expect(c.tap(1200)).toBe("locked");
  expect([...c.apply("a"), ...c.apply("b")]).toEqual([1, 2]);
  expect(c.tap(5000)).toBe("off");
  c.tap(6000); expect(c.tap(6500)).toBe("off");
});
test("scroll back becomes mouse-wheel bytes", () => {
  expect(text(wheelBytes(-2, 10, 5))).toBe("\x1b[<64;10;5M\x1b[<64;10;5M");
  expect(text(wheelBytes(1, 1, 1))).toBe("\x1b[<65;1;1M");
});
test("text size steps", () => {
  expect([nextFontSize(14, 1), nextFontSize(14, -1), nextFontSize(28, 1), nextFontSize(10, -1)]).toEqual([16, 12, 28, 10]);
});

// Beyond the plan's tests: edges the recogniser and latch must get right.
test("a swipe that is too slow, too short or too diagonal is nothing", () => {
  expect(run([["down", 0, [p(1, 300, 400)]], ["move", 900, [p(1, 200, 400)]], ["up", 950, []]])).toEqual([]);
  expect(run([["down", 0, [p(1, 300, 400)]], ["move", 100, [p(1, 260, 400)]], ["up", 150, []]])).toEqual([]);
  expect(run([["down", 0, [p(1, 300, 400)]], ["move", 100, [p(1, 220, 350)]], ["up", 150, []]])).toEqual([]);
});
test("fingers lifting one after the other still make one two-finger swipe", () => {
  expect(run([
    ["down", 0, [p(1, 100, 400)]], ["down", 10, [p(1, 100, 400), p(2, 100, 500)]],
    ["move", 100, [p(1, 200, 402), p(2, 200, 498)]],
    ["up", 120, [p(2, 200, 498)]], ["up", 140, []],
  ])).toEqual(["swipe2-right"]);
});
test("three fingers are nothing, and a drag that gains a second finger stays quiet", () => {
  expect(run([["down", 0, [p(1, 100, 400), p(2, 200, 400), p(3, 300, 400)]], ["move", 100, [p(1, 200, 400), p(2, 300, 400), p(3, 400, 400)]], ["up", 150, []]])).toEqual([]);
  expect(run([["down", 0, [p(1, 100, 300)]], ["move", 50, [p(1, 101, 330)]], ["down", 60, [p(1, 101, 330), p(2, 200, 330)]], ["move", 100, [p(1, 201, 330), p(2, 300, 330)]], ["up", 150, []]])).toEqual(["drag 30"]);
});
test("a double tap does not chain into a triple, and a swipe cancels a pending tap", () => {
  const r = createRecognizer();
  expect(run([["down", 0, [p(1, 100, 100)]], ["up", 80, []], ["down", 200, [p(1, 100, 100)]], ["up", 260, []], ["down", 330, [p(1, 100, 100)]], ["up", 380, []]], r)).toEqual(["double-tap"]);
  expect(run([["down", 0, [p(1, 100, 100)]], ["up", 80, []], ["down", 100, [p(1, 100, 100)]], ["move", 150, [p(1, 200, 100)]], ["up", 180, []], ["down", 200, [p(1, 100, 100)]], ["up", 250, []]])).toEqual(["swipe1-right"]);
});
test("two taps too far apart are not a double tap", () => {
  expect(run([["down", 0, [p(1, 100, 100)]], ["up", 80, []], ["down", 200, [p(1, 160, 100)]], ["up", 260, []]])).toEqual([]);
});
test("gestureAction falls back to the defaults, then none", () => {
  expect(gestureAction("pinch-in", {})).toBe("text-smaller");
  expect(gestureAction("whatever", {})).toBe("none");
});
test("mergeGestureMap tolerates garbage and does not alias the defaults", () => {
  for (const bad of [undefined, null, 5, "x", [], ["double-tap"]]) expect(mergeGestureMap(/** @type {any} */ (bad))).toEqual(DEFAULT_GESTURES);
  const m = mergeGestureMap({});
  m["double-tap"] = "none";
  expect(DEFAULT_GESTURES["double-tap"]).toBe("paste");
});
test("navPlan: every action on both kinds", () => {
  expect(navPlan("window-prev", "tmux")).toEqual({ steps: ["prefix", "p"] });
  expect(navPlan("pane-next", "tmux")).toEqual({ steps: ["prefix", "o"] });
  expect(navPlan("session-prev", "tmux")).toEqual({ navigate: { level: "session", dir: -1 } });
  expect(navPlan("pane-next", "herdr")).toEqual({ navigate: { level: "pane", dir: 1 } });
  expect(navPlan("session-prev", "herdr")).toEqual({ navigate: { level: "session", dir: -1 } });
  for (const a of ["text-bigger", "text-smaller", "paste", "scroll"]) expect(navPlan(a, "herdr")).toEqual({ local: a });
});
test("Ctrl latch: control bytes, locked stays, once is spent on any key", () => {
  const c = createCtrlLatch();
  c.tap(0);
  expect([...c.apply("@")]).toEqual([0]);
  c.tap(10); c.tap(20);
  expect([...["[", "\\", "]", "^", "_", " ", "Z"].flatMap((k) => [...c.apply(k)])]).toEqual([27, 28, 29, 30, 31, 0, 26]);
  expect(c.state()).toBe("locked");
  expect(text(c.apply("1"))).toBe("1");
  expect(c.tap(5000)).toBe("off");
  c.tap(6000);
  expect(text(c.apply("é"))).toBe("é");
  expect(c.state()).toBe("off");
  c.tap(7000);
  expect(text(c.apply("ls"))).toBe("ls");
  expect(c.state()).toBe("off");
});
test("wheelBytes with no lines is empty; font size from an off-grid value", () => {
  expect(wheelBytes(0, 3, 3).length).toBe(0);
  expect([nextFontSize(15, 1), nextFontSize(15, -1)]).toEqual([16, 14]);
});

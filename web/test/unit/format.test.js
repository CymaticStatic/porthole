import { expect, test } from "bun:test";
import { ago, basename, bytes, resetsIn } from "../../src/lib/format.js";
const now = Date.parse("2026-10-13T12:00:00Z");
test("ago", () => {
  expect(["2026-10-13T11:59:40Z", "2026-10-13T11:57:00Z", "2026-10-13T10:00:00Z", "2026-10-12T09:00:00Z", "2026-10-01T09:00:00Z"].map((t) => ago(t, now))).toEqual(["just now", "3 min ago", "2 h ago", "yesterday", "1 Oct"]);
});
test("ago: a time in the future reads as just now; another year shows the year", () => {
  expect(ago("2026-10-13T12:05:00Z", now)).toBe("just now");
  expect(ago("2025-10-12T09:00:00Z", now)).toBe("12 Oct 2025");
});
test("resetsIn and bytes", () => {
  expect(resetsIn("2026-10-13T14:10:00Z", now)).toBe("resets in 2 h 10 min");
  expect([512, 1536, 1_250_000].map(bytes)).toEqual(["512 bytes", "1.5 KB", "1.2 MB"]);
});
test("resetsIn: minutes only, whole hours, days, and already passed", () => {
  expect(["2026-10-13T12:45:00Z", "2026-10-13T14:00:00Z", "2026-10-16T16:00:00Z", "2026-10-13T11:00:00Z"].map((t) => resetsIn(t, now))).toEqual(["resets in 45 min", "resets in 2 h", "resets in 3 d 4 h", "resets now"]);
});
test("bytes: whole units lose the .0", () => {
  expect([1, 1024, 3 * 1024 * 1024].map(bytes)).toEqual(["1 byte", "1 KB", "3 MB"]);
});
test("basename ignores trailing slashes", () => {
  expect([basename("/work/porthole/"), basename("/"), basename(null)]).toEqual(["porthole", "", ""]);
});

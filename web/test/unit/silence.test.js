import { expect, test } from "bun:test";
import { createSilence } from "../../src/lib/silence.js";

const loud = new Float32Array(160).fill(0.2), quiet = new Float32Array(160);
test("stops after 2 s of quiet that follows speech", () => {
  const s = createSilence();
  expect(s.feed(quiet, 10)).toBe("quiet");
  expect(s.feed(loud, 10)).toBe("speech");
  expect(s.feed(quiet, 10)).toBe("silence-started");
  let r = ""; for (let i = 0; i < 198; i++) r = s.feed(quiet, 10);
  expect(r).toBe("silence-started");
  expect(s.feed(quiet, 10)).toBe("stop");
});
test("speech resets the quiet timer", () => {
  const s = createSilence({ holdMs: 100 });
  s.feed(loud, 10); for (let i = 0; i < 9; i++) s.feed(quiet, 10);
  expect(s.feed(loud, 10)).toBe("speech");
  for (let i = 0; i < 9; i++) expect(s.feed(quiet, 10)).toBe("silence-started");
});

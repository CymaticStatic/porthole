import { expect, test } from "bun:test";
import { encodeWav, resample } from "../../src/lib/wav.js";

test("header and samples", () => {
  const w = encodeWav(new Float32Array([0, 1, -1, 2]));
  const v = new DataView(w.buffer);
  expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(w.slice(8, 16))).toBe("WAVEfmt ");
  expect([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)]).toEqual([1, 1, 16000, 16]);
  expect(v.getUint32(40, true)).toBe(8);
  expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)]).toEqual([0, 32767, -32768, 32767]);
  expect(w.length).toBe(52);
});
test("resample 48k → 16k keeps duration", () => {
  expect(resample(new Float32Array(48000), 48000).length).toBe(16000);
});

const RATE = 16000;

/**
 * Linear-interpolation resampler.
 * @param {Float32Array} input @param {number} fromRate @param {number} [toRate] @returns {Float32Array}
 */
export function resample(input, fromRate, toRate = RATE) {
  if (fromRate === toRate) return input;
  const n = Math.round((input.length * toRate) / fromRate);
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  const last = input.length - 1;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const i0 = Math.min(Math.floor(pos), last);
    const i1 = Math.min(i0 + 1, last);
    const f = pos - i0;
    out[i] = input[i0] + (input[i1] - input[i0]) * f;
  }
  return out;
}

/** @param {DataView} v @param {number} at @param {string} s */
function ascii(v, at, s) {
  for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
}

/**
 * Encode 16 kHz mono float samples as a RIFF/WAVE file (PCM, 16-bit, little-endian). Samples are clipped to [-1, 1].
 * @param {Float32Array} samples @returns {Uint8Array}
 */
export function encodeWav(samples) {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  ascii(v, 0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(v, 8, "WAVE");
  ascii(v, 12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true);
  ascii(v, 36, "data");
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

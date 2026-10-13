/**
 * Talk-mode end-of-turn detector (SPEC 4.12): "stop" once quiet has lasted `holdMs` after any speech.
 * Before any speech it returns "quiet" forever, so an empty start never auto-stops.
 * @param {{threshold?: number, holdMs?: number}} [opts]
 */
export function createSilence({ threshold = 0.01, holdMs = 2000 } = {}) {
  let heard = false;
  let quietMs = 0;
  return {
    /**
     * @param {Float32Array} frame @param {number} ms duration of this frame
     * @returns {"speech" | "silence-started" | "stop" | "quiet"}
     */
    feed(frame, ms) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = frame.length ? Math.sqrt(sum / frame.length) : 0;
      if (rms >= threshold) {
        heard = true;
        quietMs = 0;
        return "speech";
      }
      if (!heard) return "quiet";
      quietMs += ms;
      return quietMs >= holdMs ? "stop" : "silence-started";
    },
  };
}

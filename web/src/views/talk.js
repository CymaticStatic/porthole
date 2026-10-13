// Talk mode and read-aloud (SPEC 4.12).
//   attachReadAloud(ctx, chatEvents)  the chat view calls this once; replies that finish are spoken (summary only).
//   mount(root, ctx, opts)            the talk overlay opened from the chat's mic button.
// Settings are read through ctx.settings.get() every time they are needed, never cached or stored here.
import { h } from "../dom/h.js";
import { finishedReplies } from "../lib/chatmodel.js";
import { ago } from "../lib/format.js";
import { asObject } from "../lib/json.js";
import { createSilence } from "../lib/silence.js";
import { readAllUtterances, speakThroughBridge, summaryUtterances } from "../lib/speech.js";
import { defaultStorage } from "../lib/storage.js";
import { createTalkHistory } from "../lib/talkhistory.js";
import { encodeWav, resample } from "../lib/wav.js";

/** @typedef {import("../net/api.js").Api} Api */
/**
 * What this view needs of the app context.
 * @typedef {Pick<import("../lib/types.js").Ctx, "copy" | "settings"> & {bridge?: import("../lib/types.js").Bridge | null}} Ctx
 */
/** @typedef {{on(name: "items", fn: (items: import("../lib/chatmodel.js").ChatItem[]) => void): () => void}} ChatEvents `items` carries what `chatmodel.append` returned for a live push (never a backlog or an older page). */
/**
 * @typedef {object} ReadAloud
 * @property {(markdown: string) => void} readAll speaks the whole reply, or stops when something is being read
 * @property {() => void} stop
 * @property {() => boolean} speaking
 * @property {(fn: (speaking: boolean) => void) => () => void} onChange
 * @property {(getMarkdown: () => string) => HTMLElement} button the speaker button: "Read all", and "Stop reading" while it speaks
 * @property {() => void} detach
 */
/** @typedef {{stop(): Promise<Uint8Array>, cancel(): void}} Recorder */

const SAMPLE_RATE = 16000;
/** Longest browser recording. hostd refuses more than 25 MB (about 13 minutes of 16 kHz mono); 10 minutes also keeps the unconverted samples small. */
const MAX_RECORDING_MS = 600_000;
/** How long "Couldn't read this aloud." stays up. */
const FAILED_NOTE_MS = 8000;

/** Overlays open right now: while one is open every finished reply is read aloud. */
let talkOpen = 0;

/**
 * @param {Ctx} ctx @param {string} key @param {boolean} fallback
 * @returns {boolean}
 */
function flag(ctx, key, fallback) {
  const v = ctx.settings.get()[key];
  return typeof v === "boolean" ? v : fallback;
}

// ---------------------------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------------------------

/**
 * Speaks batches of utterances in order. The Android app speaks through the bridge; a browser uses speechSynthesis.
 * `stop()` drops everything queued and cuts the current one off.
 * @param {Ctx} ctx
 */
function createSpeaker(ctx) {
  /** @type {string[][]} */
  let queue = [];
  let token = 0;
  let pumping = false;
  let active = false;
  /** @type {(() => void) | null} */
  let cancelNow = null;
  /** @type {Set<(speaking: boolean) => void>} */
  const listeners = new Set();
  /** @type {Set<() => void>} */
  const failListeners = new Set();

  /** @param {boolean} v */
  function setActive(v) {
    if (v === active) return;
    active = v;
    for (const fn of [...listeners]) {
      try { fn(v); } catch { /* one listener must not stop the others */ }
    }
  }

  /**
   * Resolves when the batch has been spoken, was cut off, or could not be spoken.
   * @param {string[]} utterances @param {number} mine
   * @returns {Promise<void>}
   */
  function say(utterances, mine) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cancelNow = null;
        resolve();
      };
      cancelNow = finish;
      const bridge = ctx.bridge;
      if (bridge?.available) {
        speakThroughBridge(bridge, utterances).then((ok) => {
          if (!ok && token === mine) for (const fn of [...failListeners]) { try { fn(); } catch { /* one listener must not stop the others */ } }
          finish();
        });
        return;
      }
      const synth = globalThis.speechSynthesis;
      if (!synth || typeof globalThis.SpeechSynthesisUtterance !== "function") {
        finish();
        return;
      }
      let i = 0;
      const next = () => {
        if (done || token !== mine || i >= utterances.length) {
          finish();
          return;
        }
        const u = new SpeechSynthesisUtterance(utterances[i++]);
        u.onend = next;
        u.onerror = finish;
        try {
          synth.speak(u);
        } catch {
          finish();
        }
      };
      next();
    });
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    const mine = token;
    setActive(true);
    while (token === mine && queue.length > 0) {
      await say(/** @type {string[]} */ (queue.shift()), mine);
    }
    if (token === mine) {
      pumping = false;
      setActive(false);
    }
  }

  return {
    /** @param {string[]} utterances */
    enqueue(utterances) {
      if (utterances.length === 0) return;
      queue.push(utterances);
      void pump();
    },
    stop() {
      if (!pumping && queue.length === 0) return;
      token++;
      queue = [];
      pumping = false;
      cancelNow?.();
      if (ctx.bridge?.available) ctx.bridge.call("stopSpeaking").catch(() => {});
      try { globalThis.speechSynthesis?.cancel(); } catch { /* nothing was speaking */ }
      setActive(false);
    },
    speaking: () => active,
    /** @param {(speaking: boolean) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    clearListeners: () => { listeners.clear(); failListeners.clear(); },
    /** Called when the app's text-to-speech could not read a batch (not when Ben stopped it). @param {() => void} fn */
    onFail(fn) {
      failListeners.add(fn);
      return () => { failListeners.delete(fn); };
    },
  };
}

/** The speaker shape drawn with CSS: a small box and a cone. @returns {HTMLElement} */
const speakerGlyph = () => h("span", { class: "talk-glyph-speaker", "aria-hidden": "true" });

/**
 * Read-aloud for one chat view. Call `detach()` when the view goes away.
 * @param {Ctx} ctx @param {ChatEvents} chatEvents
 * @returns {ReadAloud}
 */
export function attachReadAloud(ctx, chatEvents) {
  const { copy } = ctx;
  const speaker = createSpeaker(ctx);

  const pill = h("button", { type: "button", class: "talk-stop-reading", "data-test": "stop-reading", hidden: true, on: { click: () => speaker.stop() } }, speakerGlyph(), copy.stopReading);
  document.body.append(pill);
  // Where the speech status shows (the "Stop reading" pill), a failed reading says so, then goes away by itself.
  const failedNote = h("p", { class: "talk-read-failed", role: "status", "data-test": "read-failed", hidden: true }, copy.readAloudFailed);
  document.body.append(failedNote);
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let failedTimer;
  function hideFailed() {
    clearTimeout(failedTimer);
    failedNote.hidden = true;
  }
  const offFail = speaker.onFail(() => {
    hideFailed();
    failedNote.hidden = false;
    failedTimer = setTimeout(hideFailed, FAILED_NOTE_MS);
  });
  const offState = speaker.onChange((on) => {
    pill.hidden = !on;
    if (on) hideFailed();
  });

  const offItems = chatEvents.on("items", (items) => {
    if (!Array.isArray(items)) return;
    if (!flag(ctx, "readAloud", false) && talkOpen === 0) return;
    for (const reply of finishedReplies(items)) speaker.enqueue(summaryUtterances(reply.text));
  });

  /** @type {(() => void)[]} */
  const buttonCleanups = [];

  /** @type {ReadAloud} */
  const api = {
    readAll(markdown) {
      if (speaker.speaking()) speaker.stop();
      else speaker.enqueue(readAllUtterances(markdown));
    },
    stop: () => speaker.stop(),
    speaking: () => speaker.speaking(),
    onChange: (fn) => speaker.onChange(fn),
    button(getMarkdown) {
      const label = h("span", { class: "talk-speaker-label" }, copy.readAll);
      const el = h("button", { type: "button", class: "talk-speaker", "data-test": "read-all", on: { click: () => api.readAll(getMarkdown()) } }, speakerGlyph(), label);
      buttonCleanups.push(speaker.onChange((on) => { label.textContent = on ? copy.stopReading : copy.readAll; }));
      return el;
    },
    detach() {
      offItems();
      offState();
      offFail();
      for (const c of buttonCleanups.splice(0)) c();
      speaker.stop();
      speaker.clearListeners();
      hideFailed();
      pill.remove();
      failedNote.remove();
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/**
 * A browser recording: microphone → AudioContext → plain samples, converted to a 16 kHz mono WAV on stop.
 * A ScriptProcessorNode does the capture because an AudioWorklet needs a second script file, and the page's
 * Content-Security-Policy allows scripts from the page's own files only.
 * @param {{autoStop: boolean, onLevel: (level: number) => void, onAutoStop: () => void}} o
 * @returns {Promise<Recorder>}
 */
async function startWebRecorder({ autoStop, onLevel, onAutoStop }) {
  const media = globalThis.navigator?.mediaDevices;
  if (!media || typeof media.getUserMedia !== "function") throw new Error("no microphone access");
  const stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const stopTracks = () => { for (const t of stream.getTracks()) t.stop(); };
  /** @type {AudioContext} */
  let audio;
  try {
    const Ctor = globalThis.AudioContext ?? /** @type {{webkitAudioContext: typeof AudioContext}} */ (/** @type {unknown} */ (globalThis)).webkitAudioContext;
    audio = new Ctor();
    await audio.resume();
  } catch (e) {
    stopTracks();
    throw e;
  }
  const source = audio.createMediaStreamSource(stream);
  const node = audio.createScriptProcessor(4096, 1, 1);
  const sink = audio.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(audio.destination);

  const silence = autoStop ? createSilence() : null;
  /** @type {Float32Array[]} */
  const chunks = [];
  let total = 0;
  let released = false;
  let fired = false;
  const rate = audio.sampleRate;

  node.addEventListener("audioprocess", (e) => {
    if (released) return;
    const frame = e.inputBuffer.getChannelData(0);
    chunks.push(frame.slice());
    total += frame.length;
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    onLevel(Math.min(1, Math.sqrt(sum / frame.length) * 8));
    const verdict = silence ? silence.feed(frame, (frame.length / rate) * 1000) : "quiet";
    if (!fired && (verdict === "stop" || (total / rate) * 1000 >= MAX_RECORDING_MS)) {
      fired = true;
      onAutoStop();
    }
  });

  const release = () => {
    if (released) return;
    released = true;
    try {
      source.disconnect();
      node.disconnect();
      sink.disconnect();
    } catch { /* already disconnected */ }
    stopTracks();
    audio.close().catch(() => {});
  };

  return {
    async stop() {
      release();
      if (total === 0) throw new Error("nothing was recorded");
      const all = new Float32Array(total);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      chunks.length = 0;
      return encodeWav(resample(all, rate, SAMPLE_RATE));
    },
    cancel() {
      release();
      chunks.length = 0;
    },
  };
}

/** @param {unknown} data `{wav: base64}` @returns {Uint8Array} */
function wavFromNative(data) {
  const b64 = data && typeof data === "object" ? /** @type {{wav?: unknown}} */ (data).wav : undefined;
  if (typeof b64 !== "string" || b64 === "") throw new Error("the app returned no recording");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * The phone app's own recorder. GUESS (the Android side is not built yet): `startRecording({autoStop})`
 * resolves once recording has begun, `stopRecording()` resolves `{wav: <base64 of a 16 kHz mono WAV>}`, and when the
 * app stops by itself it emits the bridge event `recordingStopped` with that same `{wav}`.
 * @param {NonNullable<Ctx["bridge"]>} bridge @param {{autoStop: boolean, onAutoStop: () => void}} o
 * @returns {Promise<Recorder>}
 */
async function startNativeRecorder(bridge, { autoStop, onAutoStop }) {
  await bridge.call("startRecording", { autoStop });
  /** @type {Uint8Array | null} */
  let early = null;
  const off = bridge.on("recordingStopped", (data) => {
    try { early = wavFromNative(data); } catch { return; }
    onAutoStop();
  });
  return {
    async stop() {
      off();
      if (early) return early;
      return wavFromNative(await bridge.call("stopRecording"));
    },
    cancel() {
      off();
      bridge.call("stopRecording").catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The talk overlay
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} TalkOptions
 * @property {Api} api this chat's machine; the recording goes to `api.wav`
 * @property {(text: string, o: {send: boolean}) => void} onText add `text` to the composer draft (saved like typing); press Send when `send` is true
 * @property {() => void} [onClose]
 * @property {string} [origin] this chat's machine address, kept with each transcription in the history
 * @property {string} [sessionId] this chat's session, kept with each transcription in the history
 */

/**
 * The talk overlay. Returns `{unmount()}`.
 * @param {HTMLElement} root @param {Ctx} ctx @param {TalkOptions} opts
 * @returns {{unmount(): void}}
 */
export function mount(root, ctx, opts) {
  const { copy } = ctx;
  talkOpen++;
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  /** @type {"idle" | "starting" | "recording" | "working"} */
  let state = "idle";
  let closed = false;
  /** @type {Recorder | null} */
  let recorder = null;
  /** @type {Uint8Array | null} the recording that failed to upload, kept for "Try again" */
  let pendingWav = null;
  /** @type {{headline: string, reason: string} | null} */
  let error = null;
  let heard = "";

  const history = createTalkHistory(defaultStorage());
  /** @type {ReturnType<typeof setTimeout>[]} */
  const copiedTimers = [];
  const titleId = "talk-title";
  const glyph = h("span", { class: "talk-glyph-mic", "aria-hidden": "true" });
  const micLabel = h("span", { class: "talk-mic-label" });
  const mic = h("button", { type: "button", class: "talk-mic", "data-test": "talk-mic", on: { click: () => (state === "recording" ? void finish() : void begin()) } }, glyph, micLabel);
  const ring = h("div", { class: "talk-ring" }, mic);
  const status = h("p", { class: "talk-status", "data-test": "talk-status", role: "status" });
  const errorHeadline = h("span", { class: "talk-error-headline" });
  const errorReason = h("span", { class: "talk-error-reason" });
  const retry = h("button", { type: "button", class: "talk-retry", "data-test": "talk-retry", on: { click: () => void retryNow() } }, copy.tryAgain);
  const errorBox = h("div", { class: "talk-error", "data-test": "talk-error", role: "alert", hidden: true }, errorHeadline, errorReason, retry);
  const heardBox = h("p", { class: "talk-heard", "data-test": "talk-heard", hidden: true });
  const closeBtn = h("button", { type: "button", class: "talk-close", "data-test": "talk-close", on: { click: () => dispose(true) } }, copy.close);
  const recentList = h("ul", { class: "talk-recent-list", "data-test": "talk-recent-list" });
  const recent = h("section", { class: "talk-recent", "aria-labelledby": "talk-recent-title" }, h("h3", { id: "talk-recent-title", class: "talk-recent-title" }, copy.talkRecent), recentList);
  const sheet = h("div", { class: "talk-sheet" },
    h("header", { class: "talk-head" }, h("h2", { id: titleId, class: "talk-title" }, copy.talkTitle), closeBtn),
    status, ring, heardBox, errorBox, recent);
  const overlay = h("div", { class: "talk-overlay", "data-test": "talk", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, sheet);

  /** The first part of a machine's address, as the name the person knows it by. @param {string} origin */
  function machineName(origin) {
    try { return new URL(origin).hostname.split(".")[0]; } catch { return ""; }
  }

  function renderRecent() {
    const now = Date.now();
    const items = history.list();
    recentList.replaceChildren(
      ...(items.length === 0
        ? [h("li", { class: "talk-recent-empty", "data-test": "talk-recent-empty" }, copy.talkRecentEmpty)]
        : items.map((item) => {
            const copyBtn = h("button", { type: "button", class: "talk-recent-button", "data-test": "talk-recent-copy" }, copy.copyText);
            copyBtn.addEventListener("click", () => {
              void navigator.clipboard.writeText(item.text).then(() => {
                copyBtn.textContent = copy.copied;
                copiedTimers.push(setTimeout(() => { copyBtn.textContent = copy.copyText; }, 1500));
              }, () => {});
            });
            const where = machineName(item.origin);
            return h("li", { class: "talk-recent-item", "data-test": "talk-recent-item" },
              h("p", { class: "talk-recent-meta" }, ago(new Date(item.at).toISOString(), now), where === "" ? "" : ` · ${where}`),
              h("p", { class: "talk-recent-text" }, item.text),
              h("div", { class: "talk-recent-actions" },
                copyBtn,
                h("button", { type: "button", class: "talk-recent-button", "data-test": "talk-recent-putback", on: { click: () => { try { opts.onText(item.text, { send: false }); } catch { /* the chat view is gone */ } dispose(true); } } }, copy.putBack)));
          })),
    );
  }

  /** @param {number} level 0 to 1 */
  const setLevel = (level) => { ring.style.setProperty("--level", level.toFixed(2)); };

  function render() {
    overlay.dataset.state = state;
    /** @type {HTMLButtonElement} */ (mic).disabled = state === "starting" || state === "working";
    micLabel.textContent = state === "recording" ? copy.talkStopRecording : copy.talkStart;
    status.textContent = state === "recording" ? copy.talkListening : state === "working" ? copy.talkWorking : "";
    heardBox.hidden = heard === "";
    heardBox.textContent = heard;
    errorBox.hidden = error === null;
    errorHeadline.textContent = error ? error.headline : "";
    errorReason.textContent = error ? error.reason : "";
    errorReason.hidden = !error || error.reason === "";
  }

  /** @param {string} headline @param {string} [reason] */
  function fail(headline, reason = "") {
    state = "idle";
    setLevel(0);
    error = { headline, reason: reason === "" ? "" : copy.reasonLine(reason) };
    if (!closed) render();
  }

  async function begin() {
    if (state !== "idle") return;
    state = "starting";
    error = null;
    render();
    try {
      const autoStop = flag(ctx, "talkAutoStop", true);
      const onAutoStop = () => { void finish(); };
      recorder = ctx.bridge?.available
        ? await startNativeRecorder(ctx.bridge, { autoStop, onAutoStop })
        : await startWebRecorder({ autoStop, onLevel: setLevel, onAutoStop });
    } catch {
      fail(copy.talkMicDenied);
      return;
    }
    if (closed) {
      recorder.cancel();
      recorder = null;
      return;
    }
    state = "recording";
    render();
  }

  async function finish() {
    if (state !== "recording" || !recorder) return;
    const r = recorder;
    recorder = null;
    state = "working";
    setLevel(0);
    render();
    try {
      pendingWav = await r.stop();
    } catch {
      fail(copy.voiceFailed);
      return;
    }
    await upload();
  }

  async function upload() {
    if (!pendingWav) return;
    state = "working";
    error = null;
    if (!closed) render();
    const res = await opts.api.wav(/** @type {BodyInit} */ (/** @type {unknown} */ (pendingWav)));
    const said = res.ok ? asObject(res.data).text : undefined;
    const text = typeof said === "string" ? said.trim() : "";
    if (!res.ok || text === "") {
      fail(copy.voiceFailed, res.ok ? "" : res.error);
      return;
    }
    pendingWav = null;
    state = "idle";
    heard = text;
    history.add({ text, origin: opts.origin, sessionId: opts.sessionId });
    renderRecent();
    // After the overlay is closed the words still go to the draft, but are never sent on their own.
    const send = !closed && flag(ctx, "talkAutoSend", true);
    try { opts.onText(text, { send }); } catch { /* the chat view is gone; the words are still on screen here */ }
    if (!closed) render();
  }

  function retryNow() {
    if (pendingWav) return upload();
    return begin();
  }

  /** @param {boolean} notify */
  function dispose(notify) {
    if (closed) return;
    closed = true;
    talkOpen--;
    for (const t of copiedTimers) clearTimeout(t);
    if (recorder) {
      recorder.cancel();
      recorder = null;
    }
    overlay.removeEventListener("keydown", onKey);
    overlay.remove();
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    if (notify) opts.onClose?.();
  }

  /** @param {KeyboardEvent} e */
  function onKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      dispose(true);
      return;
    }
    if (e.key !== "Tab") return;
    const stops = [mic, retry, ...recentList.querySelectorAll("button"), closeBtn].filter((el) => !el.hidden && !(el instanceof HTMLButtonElement && el.disabled) && el.offsetParent !== null);
    if (stops.length === 0) return;
    const at = stops.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    const nextAt = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at < 0 || at === stops.length - 1 ? 0 : at + 1);
    e.preventDefault();
    stops[nextAt].focus();
  }

  overlay.addEventListener("click", (e) => { if (e.target === overlay) dispose(true); });
  overlay.addEventListener("keydown", onKey);
  renderRecent();
  render();
  setLevel(0);
  root.append(overlay);
  mic.focus();

  return { unmount: () => dispose(false) };
}

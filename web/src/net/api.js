// One API client per machine. Every call resolves to a result object and never throws:
//   {ok: true, status, data}   or   {ok: false, status, error}   (status 0 = the machine could not be reached).
import { copy } from "../lib/copy.js";
import { isObject } from "../lib/json.js";

/** `data` is whatever JSON hostd sent (`null` for an empty reply): narrow it with lib/json.js before reading a field. @typedef {{ok: true, status: number, data: unknown} | {ok: false, status: number, error: string}} ApiResult */
/**
 * @typedef {object} Api
 * @property {(path: string) => Promise<ApiResult>} get
 * @property {(path: string, body?: unknown) => Promise<ApiResult>} post
 * @property {(path: string, body?: unknown) => Promise<ApiResult>} put
 * @property {(file: Blob, name?: string) => Promise<ApiResult>} upload `POST /v1/uploads` (multipart, field "file") → `{path}`
 * @property {(bytes: BodyInit) => Promise<ApiResult>} wav `POST /v1/voice` (audio/wav) → `{text}`
 */

// Uploads and transcription legitimately take longer than a list request.
const LONG_MS = 120_000;

/** A plain sentence for an HTTP status hostd gave no text for. @param {number} status */
function sentenceFor(status) {
  if (status === 401 || status === 403) return copy.apiRefused;
  if (status === 404) return copy.apiNotFound;
  if (status === 413) return copy.apiTooBig;
  return copy.apiServer;
}

/**
 * @param {{origin: string, fetch?: typeof fetch, timeoutMs?: number, setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout}} deps
 * @returns {Api}
 */
export function createApi({ origin, fetch: fetchFn, timeoutMs = 15000, setTimeout: setT, clearTimeout: clearT }) {
  const doFetch = fetchFn ?? ((/** @type {Parameters<typeof fetch>} */ ...a) => globalThis.fetch(...a));
  const startTimer = setT ?? ((/** @type {Parameters<typeof setTimeout>} */ ...a) => globalThis.setTimeout(...a));
  const stopTimer = clearT ?? ((/** @type {Parameters<typeof clearTimeout>} */ ...a) => globalThis.clearTimeout(...a));

  /**
   * @param {string} method @param {string} path
   * @param {{headers?: Record<string, string>, body?: BodyInit, ms?: number}} [opts]
   * @returns {Promise<ApiResult>}
   */
  async function request(method, path, opts = {}) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = startTimer(() => { timedOut = true; ctl.abort(); }, opts.ms ?? timeoutMs);
    /** @type {Response} */
    let res;
    /** @type {string} */
    let text;
    try {
      res = await doFetch(origin + path, {
        method,
        headers: { "X-Porthole": "1", ...opts.headers },
        body: opts.body,
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        signal: ctl.signal,
      });
      text = await res.text();
    } catch {
      return { ok: false, status: 0, error: timedOut ? copy.apiTimedOut : copy.apiUnreachable };
    } finally {
      stopTimer(timer);
    }
    /** @type {unknown} */
    let data = null;
    let parsed = true;
    if (text !== "") {
      try { data = JSON.parse(text); } catch { parsed = false; }
    }
    if (res.ok) {
      if (!parsed) return { ok: false, status: res.status, error: copy.apiBadReply };
      return { ok: true, status: res.status, data };
    }
    const body = parsed && isObject(data) ? data : null;
    const own = body ? (typeof body.error === "string" && body.error !== "" ? body.error : typeof body.reason === "string" && body.reason !== "" ? body.reason : "") : "";
    return { ok: false, status: res.status, error: own !== "" ? own : sentenceFor(res.status) };
  }

  /** @param {string} method @param {string} path @param {unknown} body */
  const json = (method, path, body) =>
    body === undefined
      ? request(method, path)
      : request(method, path, { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  return {
    get: (path) => request("GET", path),
    post: (path, body) => json("POST", path, body),
    put: (path, body) => json("PUT", path, body),
    upload(file, name) {
      const form = new FormData();
      if (name === undefined) form.append("file", file);
      else form.append("file", file, name);
      return request("POST", "/v1/uploads", { body: form, ms: Math.max(timeoutMs, LONG_MS) });
    },
    wav: (bytes) => request("POST", "/v1/voice", { headers: { "Content-Type": "audio/wav" }, body: bytes, ms: Math.max(timeoutMs, LONG_MS) }),
  };
}

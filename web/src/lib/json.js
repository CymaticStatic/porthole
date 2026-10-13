// Narrowing for JSON that came off the wire (hostd replies, socket frames, the native bridge): the type says nothing, the shape is checked here.

/** @typedef {Record<string, unknown>} JsonObject */

/** @param {unknown} v @returns {v is JsonObject} a plain JSON object (not null, not an array) */
export function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `v` when it is a JSON object, else an empty one, so a field read on a reply of the wrong shape is just `undefined`. @param {unknown} v @returns {JsonObject} */
export function asObject(v) {
  return isObject(v) ? v : {};
}

/** `v` when it is an array, else an empty one. @param {unknown} v @returns {unknown[]} */
export function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** Parses JSON text; `undefined` when it is not JSON. @param {string} text @returns {unknown} */
export function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

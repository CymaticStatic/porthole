/** @typedef {string | Node | null | undefined | false} Child */
/**
 * Build an element. Attributes are set with setAttribute; event handlers only via `on: {click: fn}`.
 * Text always goes through textContent (a string child becomes a Text node), never HTML.
 * @param {string} tag @param {Record<string, any>} [attrs] @param {...(Child|Child[])} children @returns {HTMLElement}
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === "class") el.className = v;
    else if (/^on/i.test(k) || k === "style" || k === "srcdoc") throw new Error("h: attribute not allowed: " + k);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

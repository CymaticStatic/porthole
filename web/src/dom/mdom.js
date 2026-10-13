// Renders the neutral tree from lib/markdown.js (`toTree`) into DOM. Nothing here ever parses HTML: every element is
// built with h(), every string becomes a text node, and only the tags and attributes listed below are ever produced.
import { h } from "./h.js";

/** @typedef {import("../lib/markdown.js").Node} Node */

const TAGS = new Set([
  "p", "h3", "h4", "h5", "h6", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "blockquote", "hr", "br",
  "a", "div", "table", "thead", "tbody", "tr", "th", "td",
]);
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** The only attributes each tag may carry; everything else in the tree is dropped. */
const ATTRS = /** @type {Record<string, string[]>} */ ({
  a: ["href", "target", "rel"],
  div: ["class", "tabindex", "role", "aria-label"],
});
/** `div` is only ever the sideways-scrolling table wrapper. */
const DIV_CLASSES = new Set(["table-scroll"]);

/** @param {string} href */
function safeHref(href) {
  try {
    return SAFE_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/**
 * @param {Node} node
 * @returns {(HTMLElement | string)[]}
 */
function build(node) {
  if (typeof node === "string") return [node];
  if (!node || typeof node !== "object" || typeof node.t !== "string") return [];
  const kids = (node.c ?? []).flatMap((c) => build(c));
  if (!TAGS.has(node.t)) return kids; // unknown tag: keep its words, lose the element
  /** @type {Record<string, string>} */
  const attrs = {};
  for (const name of ATTRS[node.t] ?? []) {
    const v = node.a?.[name];
    if (typeof v === "string") attrs[name] = v;
  }
  if (node.t === "a") {
    if (!attrs.href || !safeHref(attrs.href)) return kids;
    attrs.target = "_blank";
    attrs.rel = "noopener noreferrer";
  }
  if (node.t === "div") {
    if (!DIV_CLASSES.has(attrs.class ?? "")) return kids;
  }
  return [h(node.t, attrs, ...kids)];
}

/**
 * @param {Node[]} nodes the output of `toTree`
 * @returns {DocumentFragment}
 */
export function mdom(nodes) {
  const frag = document.createDocumentFragment();
  for (const n of nodes ?? []) for (const el of build(n)) frag.append(typeof el === "string" ? document.createTextNode(el) : el);
  return frag;
}

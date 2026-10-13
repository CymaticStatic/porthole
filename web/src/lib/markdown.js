// Markdown -> a small neutral tree. Pure: no DOM, no HTML ever produced.
// Only `marked.lexer` is used; every token is rebuilt through the allowlist below.
import { marked } from "../../vendor/marked/lib/marked.esm.js";

/**
 * @typedef {string | {t: string, a?: Record<string, string>, c?: Node[]}} Node
 */

const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** @param {string} href @returns {string | null} the normalised URL, or null when it is not allowed */
function safeHref(href) {
  try {
    const u = new URL(href);
    return SAFE_PROTOCOLS.has(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** marked leaves entities such as `&amp;` in text tokens; the page shows them as characters. @param {string} s */
function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => {
    if (name) return ENTITIES[/** @type {keyof typeof ENTITIES} */ (name)];
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** @param {any[] | undefined} tokens @returns {Node[]} */
function walk(tokens) {
  /** @type {Node[]} */
  const out = [];
  for (const tok of tokens ?? []) {
    const n = node(tok);
    if (n === null) continue;
    if (Array.isArray(n)) out.push(...n);
    else out.push(n);
  }
  return out;
}

/** @param {any} tok @returns {Node | Node[] | null} */
function node(tok) {
  switch (tok.type) {
    case "space":
      return null;
    case "paragraph":
      return { t: "p", c: walk(tok.tokens) };
    case "heading":
      return { t: "h" + Math.min(Math.max(tok.depth, 1) + 2, 6), c: walk(tok.tokens) };
    case "text":
      return tok.tokens ? walk(tok.tokens) : decodeEntities(String(tok.text ?? ""));
    case "escape":
      return String(tok.text ?? "");
    case "strong":
      return { t: "strong", c: walk(tok.tokens) };
    case "em":
      return { t: "em", c: walk(tok.tokens) };
    case "del":
      return { t: "del", c: walk(tok.tokens) };
    case "codespan":
      return { t: "code", c: [String(tok.text ?? "")] };
    case "code":
      return { t: "pre", c: [{ t: "code", c: [String(tok.text ?? "")] }] };
    case "list":
      return { t: tok.ordered ? "ol" : "ul", c: walk(tok.items) };
    case "list_item":
      return { t: "li", c: walk(tok.tokens) };
    case "checkbox":
      return tok.checked ? "[x] " : "[ ] ";
    case "blockquote":
      return { t: "blockquote", c: walk(tok.tokens) };
    case "hr":
      return { t: "hr" };
    case "br":
      return { t: "br" };
    case "link": {
      const href = safeHref(String(tok.href ?? ""));
      const kids = walk(tok.tokens);
      if (href === null) return kids;
      return { t: "a", a: { href, target: "_blank", rel: "noopener noreferrer" }, c: kids };
    }
    case "image": {
      const alt = String(tok.text ?? "").trim();
      const label = alt ? "Image: " + alt : "Image";
      const href = safeHref(String(tok.href ?? ""));
      if (href === null) return label;
      return { t: "a", a: { href, target: "_blank", rel: "noopener noreferrer" }, c: [label] };
    }
    case "table": {
      /** @param {any[]} cells @param {string} tag @returns {Node} */
      const row = (cells, tag) => ({ t: "tr", c: cells.map((cell) => ({ t: tag, c: walk(cell.tokens) })) });
      /** @type {Node[]} */
      const parts = [{ t: "thead", c: [row(tok.header ?? [], "th")] }];
      if (tok.rows?.length) parts.push({ t: "tbody", c: tok.rows.map((/** @type {any[]} */ r) => row(r, "td")) });
      return {
        t: "div",
        a: { class: "table-scroll", tabindex: "0", role: "region", "aria-label": "Table, scrolls sideways" },
        c: [{ t: "table", c: parts }],
      };
    }
    case "html":
      return String(tok.raw ?? tok.text ?? "");
    default:
      return String(tok.raw ?? "");
  }
}

/**
 * @param {string} markdown
 * @returns {Node[]}
 */
export function toTree(markdown) {
  return walk(marked.lexer(String(markdown ?? "")));
}

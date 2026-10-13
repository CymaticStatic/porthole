import { marked } from "../../vendor/marked/lib/marked.esm.js";

/** @typedef {{type: string, text?: string, raw?: string, tokens?: Tok[], items?: Tok[], ordered?: boolean, start?: number | "", depth?: number, alt?: string}} Tok */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** marked leaves entities such as `&amp;` in text tokens; the page shows (and so the voice says) the characters. @param {string} s @returns {string} */
function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => {
    if (name) return ENTITIES[/** @type {keyof typeof ENTITIES} */ (name)];
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

/** Plain text of inline tokens: marks, links and code fences removed, line breaks become spaces. @param {Tok[] | undefined} tokens @returns {string} */
function inlineText(tokens) {
  let out = "";
  for (const t of tokens ?? []) {
    if (t.type === "br") out += " ";
    else if (t.type === "html") continue;
    else if (t.type === "image") out += t.text ?? "";
    else if (t.tokens) out += inlineText(t.tokens);
    else out += t.type === "text" ? decodeEntities(t.text ?? "") : (t.text ?? "");
  }
  return out;
}

/** @param {string} s @returns {string} */
const squash = (s) => s.replace(/\s+/g, " ").trim();

/** Plain text of a block token that holds inline content (paragraph, heading, text). @param {Tok} t @returns {string} */
const blockText = (t) => squash(t.tokens ? inlineText(t.tokens) : decodeEntities(t.text ?? ""));

/** The item's title: its leading strong text, else its first line. @param {Tok} item @returns {string} */
function itemTitle(item) {
  const first = item.tokens?.[0];
  const lead = first?.tokens?.[0];
  if (lead?.type === "strong") return squash(inlineText(lead.tokens));
  const raw = first?.tokens ? inlineText(first.tokens) : decodeEntities(first?.text ?? item.text ?? "");
  return squash(raw.split("\n")[0] ?? "");
}

/** @param {string} s @returns {boolean} */
const isNone = (s) => /^none\.?$/i.test(s.trim());

/**
 * Read-aloud summary of a reply: the first paragraph, then one "<n>. <title>" per item of the first
 * ordered list under a "Needs your decision" heading ("None." means no titles).
 * @param {string} markdown @returns {string[]}
 */
export function summaryUtterances(markdown) {
  const tokens = /** @type {Tok[]} */ (marked.lexer(String(markdown ?? "")));
  /** @type {string[]} */
  const out = [];
  const para = tokens.find((t) => t.type === "paragraph");
  if (para) {
    const text = blockText(para);
    if (text) out.push(text);
  }
  const h = tokens.findIndex((t) => t.type === "heading" && blockText(t).toLowerCase() === "needs your decision");
  if (h < 0) return out;
  const depth = tokens[h].depth ?? 1;
  for (let i = h + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading" && (t.depth ?? 1) <= depth) break;
    if (t.type !== "list" || !t.ordered) continue;
    const items = t.items ?? [];
    if (items.length === 1 && isNone(blockText({ type: "text", tokens: items[0].tokens?.[0]?.tokens, text: items[0].text }))) break;
    const start = typeof t.start === "number" ? t.start : 1;
    items.forEach((item, n) => {
      const title = itemTitle(item);
      if (title) out.push(`${start + n}. ${title}`);
    });
    break;
  }
  return out;
}

/**
 * "Read all": the whole reply as one utterance per block, without tables, code, HTML or rules.
 * @param {string} markdown @returns {string[]}
 */
export function readAllUtterances(markdown) {
  /** @type {string[]} */
  const out = [];
  /** @param {Tok[]} tokens */
  const walk = (tokens) => {
    for (const t of tokens) {
      if (t.type === "paragraph" || t.type === "heading" || t.type === "text") {
        const text = blockText(t);
        if (text) out.push(text);
      } else if (t.type === "blockquote") walk(t.tokens ?? []);
      else if (t.type === "list") {
        const start = typeof t.start === "number" ? t.start : 1;
        (t.items ?? []).forEach((item, n) => {
          const before = out.length;
          walk(item.tokens ?? []);
          if (t.ordered && out.length > before) out[before] = `${start + n}. ${out[before]}`;
        });
      }
      // table, code, html, hr, space, def: not spoken
    }
  };
  walk(/** @type {Tok[]} */ (marked.lexer(String(markdown ?? ""))));
  return out;
}

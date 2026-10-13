// The craft-floor "is it readable" check (plan C1): evaluates in the page and returns the problems found; [] means readable.
import type { Page } from "./cdp";

const CHECK = String.raw`((SEL) => {
  const TOL = 0.5;
  const problems = [];
  const root = document.querySelector(SEL);
  if (!root) return ["element missing: " + SEL];
  const rr = root.getBoundingClientRect();
  if (getComputedStyle(root).display === "none" || rr.width === 0 || rr.height === 0) return ["element not shown (display:none or zero size): " + SEL];

  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    const c = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".") : "";
    if (c) s += "." + c;
    const t = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return s + (t ? ' "' + t + '"' : "");
  };
  const rendered = (el) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  if (document.documentElement.scrollWidth > window.innerWidth) {
    problems.push("document is wider than the viewport: " + document.documentElement.scrollWidth + " > " + window.innerWidth);
  }

  const all = [root, ...root.querySelectorAll("*")];
  for (const el of all) {
    if (!rendered(el)) continue;
    const cs = getComputedStyle(el);
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
    if (hasText) {
      const px = parseFloat(cs.fontSize);
      const limit = el.closest(".meta") ? 12 : 14;
      if (px + TOL < limit) problems.push("text smaller than " + limit + "px (" + px + "px): " + name(el));
    }
    if ((cs.overflowX === "hidden" || cs.overflowY === "hidden" || cs.overflow === "hidden") && el.scrollWidth > el.clientWidth + 1) {
      const ellipsis = cs.textOverflow === "ellipsis" && el.hasAttribute("title");
      if (!ellipsis && !el.closest(".table-scroll")) problems.push("clipped content (scrollWidth " + el.scrollWidth + " > clientWidth " + el.clientWidth + "): " + name(el));
    }
  }

  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="option"], [tabindex]:not([tabindex="-1"])';
  for (const el of [...(root.matches(INTERACTIVE) ? [root] : []), ...root.querySelectorAll(INTERACTIVE)]) {
    if (!rendered(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 && r.height <= 1) continue; // visually hidden control (its visible stand-in is checked on its own)
    if (el.tagName === "A" && getComputedStyle(el).display === "inline") {
      const p = el.parentElement;
      if (p && (p.textContent || "").trim() !== (el.textContent || "").trim()) continue; // a link inside a sentence
    }
    const label = el.closest("label");
    if (el.tagName === "INPUT" && label) {
      const lr = label.getBoundingClientRect();
      if (lr.width + TOL >= 44 && lr.height + TOL >= 44) continue; // the label is the tap target
    }
    if (r.width + TOL < 44 || r.height + TOL < 44) problems.push("tap target smaller than 44x44 (" + Math.round(r.width * 10) / 10 + "x" + Math.round(r.height * 10) / 10 + "): " + name(el));
  }
  return problems;
})`;

/** Problems found in `selector`'s subtree on the current page (empty = readable). See plan C1 for the rules. */
export async function readable(page: Page, selector: string): Promise<string[]> {
  return (await page.eval(CHECK + "(" + JSON.stringify(selector) + ")")) as string[];
}

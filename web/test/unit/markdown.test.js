import { expect, test } from "bun:test";
import { toTree } from "../../src/lib/markdown.js";

const flat = (n) => (typeof n === "string" ? n : (n.c ?? []).map(flat).join(""));
const tags = (n, out = []) => { if (typeof n !== "string") { out.push(n.t); (n.c ?? []).forEach((c) => tags(c, out)); } return out; };
const ALLOWED = new Set(["p","h3","h4","h5","h6","strong","em","del","code","pre","ul","ol","li","blockquote","hr","br","a","table","thead","tbody","tr","th","td","div"]);

test("raw HTML stays text", () => {
  const tree = toTree('Hi <img src=x onerror=alert(1)> <script>alert(2)</script>');
  expect(tree.flatMap((n) => tags(n)).every((t) => ALLOWED.has(t))).toBe(true);
  expect(tree.map(flat).join("")).toContain("<script>alert(2)</script>");
});
test("only http, https and mailto links survive", () => {
  const [p] = toTree("[a](javascript:alert(1)) [b](https://x.example/) [c](data:text/html,x) [d](mailto:a@b.c)");
  const links = p.c.filter((n) => typeof n !== "string" && n.t === "a");
  expect(links.map((l) => l.a.href)).toEqual(["https://x.example/", "mailto:a@b.c"]);
  expect(links[0].a).toEqual({ href: "https://x.example/", target: "_blank", rel: "noopener noreferrer" });
});
test("headings shift down to h3..h6", () => {
  expect(toTree("# A\n\n## B\n\n#### C").map((n) => n.t)).toEqual(["h3", "h4", "h6"]);
});
test("tables are wrapped in a labelled scroll region", () => {
  const [w] = toTree("| A | B |\n|---|---|\n| 1 | 2 |");
  expect(w.t).toBe("div");
  expect(w.a).toEqual({ class: "table-scroll", tabindex: "0", role: "region", "aria-label": "Table, scrolls sideways" });
  expect(w.c[0].t).toBe("table");
});
test("images become a link that says Image", () => {
  const [p] = toTree("![a cat](https://x.example/c.png)");
  expect(p.c[0]).toEqual({ t: "a", a: { href: "https://x.example/c.png", target: "_blank", rel: "noopener noreferrer" }, c: ["Image: a cat"] });
});
test("attribute values never carry anything but the listed keys", () => {
  const all = (n, out = []) => { if (typeof n !== "string") { out.push(...Object.keys(n.a ?? {})); (n.c ?? []).forEach((c) => all(c, out)); } return out; };
  const keys = toTree("[x](https://a.example \"t\") `c` ```js\nx\n```").flatMap((n) => all(n));
  expect(keys.every((k) => ["href", "target", "rel", "class", "tabindex", "role", "aria-label"].includes(k))).toBe(true);
});

test("block structure: lists, quote, code, rule, break, emphasis", () => {
  const tree = toTree("- a\n- **b**\n\n1. x\n\n> q\n\n```js\nlet x = 1 < 2;\n```\n\n---\n\nl1  \nl2 *e* ~~d~~ `c`");
  expect(tree.map((n) => n.t)).toEqual(["ul", "ol", "blockquote", "pre", "hr", "p"]);
  expect(tree[0].c.map((li) => li.t)).toEqual(["li", "li"]);
  expect(tree[0].c[1].c[0]).toEqual({ t: "strong", c: ["b"] });
  expect(tree[3]).toEqual({ t: "pre", c: [{ t: "code", c: ["let x = 1 < 2;"] }] });
  expect(tags(tree[5])).toEqual(["p", "br", "em", "del", "code"]);
});
test("table rows split into thead and tbody", () => {
  const [w] = toTree("| A | B |\n|---|---|\n| 1 | 2 |");
  const [thead, tbody] = w.c[0].c;
  expect([thead.t, tbody.t]).toEqual(["thead", "tbody"]);
  expect(thead.c[0].c.map((c) => [c.t, flat(c)])).toEqual([["th", "A"], ["th", "B"]]);
  expect(tbody.c[0].c.map((c) => [c.t, flat(c)])).toEqual([["td", "1"], ["td", "2"]]);
});
test("block-level HTML and unsafe image URLs become text", () => {
  const tree = toTree("<div onclick=x>hi</div>\n\n![i](javascript:alert(1))");
  expect(tree.map(flat).join("")).toContain("<div onclick=x>hi</div>");
  expect(tree.flatMap((n) => tags(n)).includes("a")).toBe(false);
  expect(flat(tree.at(-1))).toBe("Image: i");
});
test("escapes and entities show as characters", () => {
  expect(flat(toTree("a \\* b &amp; c &lt;d&gt;")[0])).toBe("a * b & c <d>");
});
test("empty input gives an empty tree", () => {
  expect(toTree("")).toEqual([]);
});

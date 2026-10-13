import { expect, test } from "bun:test";
import { VIEWS, href, parse } from "../../src/lib/route.js";
test("session ids with colons and dots round-trip", () => {
  const r = { view: "chat", machine: "testdesk", sessionId: "tmux:/run/t.sock:main:0.0" };
  expect(parse(href(r))).toEqual(r);
});
test("unknown and empty go to the inbox", () => {
  expect(parse("#/nope")).toEqual({ view: "inbox" });
  expect(parse("")).toEqual({ view: "inbox" });
});
test("every route round-trips and names a view module", () => {
  const routes = [
    { view: "inbox" }, { view: "usage" }, { view: "settings" },
    { view: "term", machine: "m", sessionId: "s:1" }, { view: "changes", machine: "m", sessionId: "s" },
    { view: "previews", machine: "my machine" }, { view: "config", machine: "m" },
  ];
  for (const r of routes) {
    expect(parse(href(r))).toEqual(r);
    expect(typeof VIEWS[r.view]).toBe("string");
  }
  expect(VIEWS.term).toBe("terminal");
  expect(VIEWS.changes).toBe("diff");
});
test("routes missing a machine or session, extra parts, and bad escapes go to the inbox", () => {
  for (const bad of ["#/chat", "#/chat/m", "#/chat/m/", "#/previews", "#/inbox/extra", "#/chat/m/s/x", "#/chat/%E0%A4%A/s"]) expect(parse(bad)).toEqual({ view: "inbox" });
  expect(href({ view: "chat", machine: "m" })).toBe("#/inbox");
  expect(href({ view: "bogus" })).toBe("#/inbox");
});

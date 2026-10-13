/**
 * Hash routes. Every part is encodeURIComponent-ed (session ids contain ":" and ".").
 *   #/inbox  #/usage  #/settings
 *   #/chat/<machine>/<sessionId>  #/term/<machine>/<sessionId>  #/changes/<machine>/<sessionId>
 *   #/previews/<machine>  #/config/<machine>
 * Anything else goes to the inbox.
 */

/** @typedef {{view: string, machine?: string, sessionId?: string}} Route */

/** Route name → view module file name under `views/` (main.js loads `./views/<name>.js`). */
export const VIEWS = {
  inbox: "inbox",
  chat: "chat",
  term: "terminal",
  changes: "diff",
  previews: "previews",
  usage: "usage",
  settings: "settings",
  config: "config",
};

/** How many path parts after the view name each route needs. */
const PARTS = { inbox: 0, chat: 2, term: 2, changes: 2, previews: 1, usage: 0, settings: 0, config: 1 };

/** @returns {Route} */
const inbox = () => ({ view: "inbox" });

/** @param {string} hash e.g. "#/chat/testdesk/tmux%3A%2Frun%2Ft.sock%3Amain%3A0.0" @returns {Route} */
export function parse(hash) {
  const path = (hash || "").replace(/^#/, "").replace(/^\/+/, "");
  if (path === "") return inbox();
  const parts = path.split("/");
  const view = parts[0];
  if (!Object.hasOwn(VIEWS, view)) return inbox();
  const want = PARTS[/** @type {keyof typeof PARTS} */ (view)];
  const rest = parts.slice(1);
  if (rest.length !== want || rest.some((p) => p === "")) return inbox();
  try {
    if (want === 0) return { view };
    if (want === 1) return { view, machine: decodeURIComponent(rest[0]) };
    return { view, machine: decodeURIComponent(rest[0]), sessionId: decodeURIComponent(rest[1]) };
  } catch {
    return inbox(); // malformed %-escape
  }
}

/** @param {Route} route @returns {string} */
export function href(route) {
  const view = route.view;
  if (!Object.hasOwn(VIEWS, view)) return "#/inbox";
  const want = PARTS[/** @type {keyof typeof PARTS} */ (view)];
  if (want === 0) return "#/" + view;
  if (!route.machine) return "#/inbox";
  if (want === 1) return `#/${view}/${encodeURIComponent(route.machine)}`;
  if (!route.sessionId) return "#/inbox";
  return `#/${view}/${encodeURIComponent(route.machine)}/${encodeURIComponent(route.sessionId)}`;
}

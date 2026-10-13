// Changes screen (SPEC 4.9): what changed in a session's folder. Staged, Not staged and New files, each file a
// collapsible row; hunks are unified on a phone and side by side on a wide window (>= 1100 px).
import { h } from "../dom/h.js";
import { copy } from "../lib/copy.js";
import { asObject } from "../lib/json.js";

/** @typedef {{path: string, from: string | null, status: string, binary: boolean, patch: string}} ChangedFile */
/** @typedef {{kind: "hunk" | "add" | "del" | "ctx" | "note", text: string}} DiffLine */
/** @typedef {{kind: "hunk" | "note", text: string} | {kind: "pair", left: DiffLine | null, right: DiffLine | null}} SideRow */
/** @typedef {{fleet: {machine(name: string): import("../net/machine.js").Machine | undefined}, route: import("../lib/route.js").Route}} Ctx */

const POLL_MS = 15_000;
const WIDE_QUERY = "(min-width: 1100px)";
/** Up to this many files are open when the screen first shows. */
const OPEN_BY_DEFAULT = 3;
const MARKS = { add: "+", del: "-", ctx: " " };

/**
 * The lines of one file's patch after its header (`diff --git`, `index`, `---`, `+++`), one entry per line.
 * Only text after the first `@@` counts, so a changed line that itself starts with `---` is never mistaken for a header.
 * @param {string} patch
 * @returns {DiffLine[]}
 */
export function parsePatch(patch) {
  /** @type {DiffLine[]} */
  const out = [];
  let inHunk = false;
  const lines = patch.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const raw of lines) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      out.push({ kind: "hunk", text: raw });
    } else if (!inHunk) {
      continue;
    } else if (raw.startsWith("+")) {
      out.push({ kind: "add", text: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      out.push({ kind: "del", text: raw.slice(1) });
    } else if (raw.startsWith("\\")) {
      continue; // git's "No newline at end of file" marker
    } else if (raw.startsWith("… (cut)")) {
      out.push({ kind: "note", text: raw });
    } else {
      out.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
  }
  return out;
}

/**
 * Old text on the left, new text on the right. A run of removed lines and the added lines right after it share rows;
 * context shows on both sides.
 * @param {DiffLine[]} lines
 * @returns {SideRow[]}
 */
export function sideBySide(lines) {
  /** @type {SideRow[]} */
  const rows = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (line.kind === "hunk" || line.kind === "note") {
      rows.push({ kind: line.kind, text: line.text });
      i++;
    } else if (line.kind === "ctx") {
      rows.push({ kind: "pair", left: line, right: line });
      i++;
    } else {
      /** @type {DiffLine[]} */
      const dels = [];
      /** @type {DiffLine[]} */
      const adds = [];
      while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
      while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ kind: "pair", left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

/** @param {DiffLine} line */
function lineEl(line) {
  if (line.kind === "hunk" || line.kind === "note") return h("div", { class: "dl dl-" + line.kind }, h("span", { class: "dl-text" }, line.text));
  return h("div", { class: "dl dl-" + line.kind },
    h("span", { class: "dl-mark" }, MARKS[line.kind]),
    h("span", { class: "dl-text" }, line.text));
}

/** @param {DiffLine | null} line */
function cellEl(line) {
  return line === null ? h("div", { class: "dl dl-empty", "aria-hidden": "true" }) : lineEl(line);
}

/** @param {ChangedFile} file @param {boolean} wide */
function hunksEl(file, wide) {
  const lines = parsePatch(file.patch);
  if (!wide) return h("div", { class: "hunks" }, lines.map(lineEl));
  return h("div", { class: "hunks hunks-wide" }, sideBySide(lines).map((row) =>
    row.kind === "pair"
      ? h("div", { class: "sbs-row" }, cellEl(row.left), cellEl(row.right))
      : h("div", { class: "sbs-row sbs-span" }, lineEl({ kind: row.kind, text: row.text }))));
}

/** @param {ChangedFile} f */
function pathText(f) {
  return f.from !== null && f.from !== f.path ? `${f.from} → ${f.path}` : f.path;
}

/** @param {string} status */
function statusWord(status) {
  return /** @type {Record<string, string>} */ (copy.fileStatus)[status] ?? status;
}

/**
 * @param {Element} root
 * @param {Ctx} ctx
 */
export function mount(root, ctx) {
  const route = ctx.route;
  const machine = route.machine ? ctx.fleet.machine(route.machine) : undefined;
  const media = window.matchMedia(WIDE_QUERY);
  const panel = h("div", { class: "panel diff", "data-test": "diff" });
  root.replaceChildren(panel);

  /** @type {{repo?: boolean, staged?: ChangedFile[], unstaged?: ChangedFile[], untracked?: {path: string}[]} | null} */
  let data = null;
  /** The reply as text, so an unchanged reply never rebuilds the screen. */
  let lastKey = "";
  /** @type {string | null} */
  let failure = null;
  let gone = false;
  /** Files the person opened or closed, by section and path. @type {Map<string, boolean>} */
  const openState = new Map();
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  /** @param {string} text @param {string} [test] */
  const note = (text, test) => h("p", { class: "panel-note", ...(test ? { "data-test": test } : {}) }, text);

  /** @param {string} key @param {ChangedFile} file @param {boolean} wide @param {boolean} openAtStart */
  function fileRow(key, file, wide, openAtStart) {
    const summaryParts = [
      h("span", { class: "file-status" }, statusWord(file.status)),
      h("span", { class: "file-path" }, pathText(file)),
    ];
    if (file.binary) {
      return h("li", { class: "file file-plain", "data-test": "diff-file" },
        h("div", { class: "file-head" }, summaryParts),
        h("p", { class: "file-note" }, copy.binaryFile));
    }
    if (file.patch === "") {
      return h("li", { class: "file file-plain", "data-test": "diff-file" }, h("div", { class: "file-head" }, summaryParts));
    }
    const details = /** @type {HTMLDetailsElement} */ (h("details", { class: "file-details" },
      h("summary", {}, summaryParts),
      hunksEl(file, wide)));
    details.open = openState.get(key) ?? openAtStart;
    details.addEventListener("toggle", () => { openState.set(key, details.open); });
    return h("li", { class: "file", "data-test": "diff-file" }, details);
  }

  /** @param {string} title @param {string} id @param {ChangedFile[]} files @param {boolean} wide @param {boolean} openAtStart */
  function section(title, id, files, wide, openAtStart) {
    return h("section", { class: "diff-section", "data-test": "diff-section", "data-section": id },
      h("h2", { class: "section-title" }, title, " ", h("span", { class: "count" }, String(files.length))),
      h("ul", { class: "files" }, files.map((f) => fileRow(id + ":" + f.path, f, wide, openAtStart))));
  }

  function render() {
    if (stopped) return;
    if (gone) { panel.replaceChildren(note(copy.sessionGone)); return; }
    if (failure !== null) {
      panel.replaceChildren(...[
        note(copy.diffFailed, "diff-error"),
        failure !== copy.diffFailed ? h("p", { class: "panel-note panel-detail" }, copy.reasonLine(failure)) : null,
        h("button", { type: "button", class: "btn", "data-test": "diff-retry", on: { click: () => { void load(); } } }, copy.tryAgain),
      ].filter((n) => n !== null));
      return;
    }
    if (data === null) { panel.replaceChildren(note(copy.loading, "diff-loading")); return; }
    if (data.repo !== true) { panel.replaceChildren(note(copy.noRepo, "diff-norepo")); return; }
    /** @type {ChangedFile[]} */
    const staged = data.staged ?? [];
    /** @type {ChangedFile[]} */
    const unstaged = data.unstaged ?? [];
    /** @type {ChangedFile[]} */
    const fresh = (data.untracked ?? []).map((u) => ({ path: u.path, from: null, status: "?", binary: false, patch: "" }));
    const total = staged.length + unstaged.length + fresh.length;
    if (total === 0) { panel.replaceChildren(note(copy.noChanges, "diff-empty")); return; }
    const wide = media.matches;
    const openAtStart = total <= OPEN_BY_DEFAULT;
    panel.replaceChildren(...[
      staged.length > 0 ? section(copy.staged, "staged", staged, wide, openAtStart) : null,
      unstaged.length > 0 ? section(copy.notStaged, "unstaged", unstaged, wide, openAtStart) : null,
      fresh.length > 0 ? section(copy.newFiles, "untracked", fresh, wide, openAtStart) : null,
    ].filter((n) => n !== null));
  }

  async function load() {
    if (stopped) return;
    clearTimeout(timer);
    if (!machine || !route.sessionId) { gone = true; render(); return; }
    const r = await machine.api.get(`/v1/sessions/${encodeURIComponent(route.sessionId)}/diff`);
    if (stopped) return;
    if (r.ok) {
      const wasShowingNote = gone;
      failure = null;
      gone = false;
      const key = JSON.stringify(r.data);
      if (key !== lastKey || data === null || wasShowingNote) {
        lastKey = key;
        data = asObject(r.data);
        render();
      }
    } else if (r.status === 404) {
      gone = true;
      render();
    } else {
      failure = r.error;
      lastKey = "";
      data = null;
      render();
    }
    timer = setTimeout(() => { void load(); }, POLL_MS);
  }

  const onMedia = () => render();
  const onVisible = () => { if (document.visibilityState === "visible") void load(); };
  media.addEventListener("change", onMedia);
  document.addEventListener("visibilitychange", onVisible);
  render();
  void load();

  return {
    unmount() {
      stopped = true;
      clearTimeout(timer);
      media.removeEventListener("change", onMedia);
      document.removeEventListener("visibilitychange", onVisible);
      root.replaceChildren();
    },
  };
}

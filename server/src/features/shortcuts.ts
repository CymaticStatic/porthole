// GET|PUT /v1/shortcuts (SPEC 4.4): Ben's saved key sequences. Only stored here; the app sends them
// through /keys, which keeps the live-voice refusal in one place.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSteps } from "../deliver/keys";
import { asRecord } from "../json";
import { json, type FeatureFactory } from "../router";

export interface Shortcut { label: string; steps: string } // steps as Ben types them: "C-b, n"

const MAX_SHORTCUTS = 50;
const MAX_LABEL_CHARS = 40;

/**
 * Splits a typed step list. A comma separates two steps unless a backslash comes directly before it: `\,` becomes a literal
 * `,` inside the step, and any other backslash stays as typed (there is no `\\` escape, so a backslash followed by a comma is
 * always a literal comma). Every part is trimmed, so leading and trailing spaces inside a `text:` step are dropped
 * (`text:ls ` sends `ls`). Empty parts are kept (as ""), so the caller can refuse them.
 */
export function splitSteps(text: string): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === ",") {
      cur += ",";
      i += 1;
    } else if (c === ",") {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  parts.push(cur.trim());
  return parts;
}

function load(stateDir: string): Shortcut[] | null {
  const f = path.join(stateDir, "shortcuts.json");
  if (!existsSync(f)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(f, "utf8"));
    if (!Array.isArray(raw)) return null;
    const out: Shortcut[] = [];
    for (const item of raw) {
      const r = asRecord(item);
      if (typeof r.label !== "string" || typeof r.steps !== "string") return null;
      out.push({ label: r.label, steps: r.steps });
    }
    return out;
  } catch {
    return null;
  }
}

function save(stateDir: string, list: Shortcut[]): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const f = path.join(stateDir, "shortcuts.json");
  const tmp = f + ".tmp";
  writeFileSync(tmp, JSON.stringify(list, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, f);
}

/** The cleaned list, or the first problem as the 400 message. */
function validate(input: unknown): Shortcut[] | { error: string } {
  if (!Array.isArray(input)) return { error: "shortcuts must be a list" };
  if (input.length > MAX_SHORTCUTS) return { error: "at most " + MAX_SHORTCUTS + " shortcuts" };
  const seen = new Set<string>();
  const out: Shortcut[] = [];
  for (const [i, item] of input.entries()) {
    const r = asRecord(item);
    const { label, steps } = r;
    if (typeof label !== "string" || [...label].length < 1 || [...label].length > MAX_LABEL_CHARS) {
      return { error: "shortcut #" + (i + 1) + ": label must be 1 to " + MAX_LABEL_CHARS + " characters" };
    }
    const where = "shortcut " + JSON.stringify(label) + ": ";
    if (seen.has(label)) return { error: where + "the label is already used by another shortcut" };
    seen.add(label);
    if (typeof steps !== "string") return { error: where + "steps must be text such as \"C-b, n\"" };
    const parts = splitSteps(steps);
    if (parts.some((p) => p === "")) return { error: where + "a step is empty (check for a doubled or trailing comma)" };
    const parsed = parseSteps(parts);
    if ("error" in parsed) return { error: where + parsed.error };
    out.push({ label, steps });
  }
  return out;
}

export const shortcutsFeature: FeatureFactory = (deps) => ({
  routes: [
    {
      method: "GET",
      pattern: "/v1/shortcuts",
      handler() {
        const list = load(deps.config.stateDir);
        return list === null ? json({ error: "shortcuts.json cannot be read" }, 500) : json({ shortcuts: list });
      },
    },
    {
      method: "PUT",
      pattern: "/v1/shortcuts",
      async handler(req) {
        let body: Record<string, unknown>;
        try {
          const parsed: unknown = await req.json();
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ error: "the body must be a JSON object" }, 400);
          body = asRecord(parsed);
        } catch {
          return json({ error: "the body must be JSON" }, 400);
        }
        const list = validate(body.shortcuts);
        if ("error" in list) return json({ error: list.error }, 400);
        save(deps.config.stateDir, list);
        return json({ shortcuts: list });
      },
    },
  ],
  channels: [],
});

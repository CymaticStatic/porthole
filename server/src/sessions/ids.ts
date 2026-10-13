// Stable session ids (SPEC 5.2): tmux:<socket>:<session>:<window>.<pane>, herdr:<workspace>:<tab>:<pane>.
// Each part is URI-encoded so a ":" inside a name can never shift the fields.

export interface TmuxWhere { kind: "tmux"; socket: string; session: string; window: number; pane: number }
export interface HerdrWhere { kind: "herdr"; workspace: string; tab: string; pane: string }
export type Where = TmuxWhere | HerdrWhere;

function local(id: string, workspace: string): string {
  return id.startsWith(workspace + ":") ? id.slice(workspace.length + 1) : id;
}

export function sessionId(w: Where): string {
  if (w.kind === "tmux") {
    return ["tmux", encodeURIComponent(w.socket), encodeURIComponent(w.session), w.window + "." + w.pane].join(":");
  }
  return ["herdr", encodeURIComponent(w.workspace), encodeURIComponent(local(w.tab, w.workspace)), encodeURIComponent(local(w.pane, w.workspace))].join(":");
}

/** Exact-match target ("=" stops tmux from prefix-matching another session). */
export function tmuxTarget(w: TmuxWhere): string {
  return "=" + w.session + ":" + w.window + "." + w.pane;
}

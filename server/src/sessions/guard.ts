// One rule for "may we type into this session?" (SPEC 4.3), shared by send, keys and the terminal.

import type { SessionInfo } from "./registry";

/**
 * True when typing into the session must be refused: live voice is on, or its state is unknown
 * and the session could be an agent that live voice drives (an omp pane, or any herdr pane).
 * A plain shell pane stays writable when the live-voice check itself fails.
 */
export function liveVoiceBlocks(info: Pick<SessionInfo, "liveVoice" | "omp" | "kind">): boolean {
  return info.liveVoice === true || (info.liveVoice === null && (info.omp != null || info.kind === "herdr"));
}

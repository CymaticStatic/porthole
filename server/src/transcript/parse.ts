// One omp transcript line → zero or more chat items (SPEC 4.3; line shapes: Verified facts 13).

import { asArray, asRecord, asString } from "../json";

export interface ChatItem {
  cursor: number;                 // byte offset where the line starts
  id: string;
  at: string;
  kind: "user" | "assistant" | "tools";
  text: string;
  tools: string[];
  via: "typed" | "live-voice" | null;
  stopReason: string | null;      // assistant text items: omp's message stopReason ("stop" ends a turn, "toolUse" is followed by tool calls); null otherwise
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content).map(asRecord).filter((b) => b.type === "text").map((b) => asString(b.text)).join("\n\n");
}

export function parseLine(line: string, cursor: number): ChatItem[] {
  let e: Record<string, unknown>;
  try { e = asRecord(JSON.parse(line)); } catch { return []; }
  const id = asString(e.id);
  const at = asString(e.timestamp);
  if (e.type === "custom_message" && e.customType === "live-delegation") {
    const text = textOf(e.content).trim();
    return text ? [{ cursor, id, at, kind: "user", text, tools: [], via: "live-voice", stopReason: null }] : [];
  }
  if (e.type !== "message") return [];
  const msg = asRecord(e.message);
  if (msg.role === "user") {
    const text = textOf(msg.content).trim();
    return text ? [{ cursor, id, at, kind: "user", text, tools: [], via: "typed", stopReason: null }] : [];
  }
  if (msg.role !== "assistant") return [];
  const items: ChatItem[] = [];
  const text = textOf(msg.content).trim();
  const stopReason = typeof msg.stopReason === "string" ? msg.stopReason : null;
  if (text) items.push({ cursor, id: id + ":text", at, kind: "assistant", text, tools: [], via: null, stopReason });
  const tools = asArray(msg.content).map(asRecord).filter((b) => b.type === "toolCall").map((b) => asString(b.name));
  if (tools.length) items.push({ cursor, id: id + ":tools", at, kind: "tools", text: "", tools, via: null, stopReason: null });
  return items;
}

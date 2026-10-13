// Narrowing helpers for JSON read from other programs (herdr, pactl, tailscale, transcripts).

export function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

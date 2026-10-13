/** Everyday-word time and size formatting. Pure; `now` is always passed in (ms since epoch). */

const DAY_MONTH = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Last path segment, ignoring trailing slashes. "/work/porthole/" → "porthole". @param {string | null | undefined} path */
export function basename(path) {
  if (!path) return "";
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/**
 * "just now" | "3 min ago" | "2 h ago" | "yesterday" | "12 Oct" ("12 Oct 2025" when not this year).
 * "yesterday" is the previous local calendar day; hours count only up to 24 h.
 * @param {string} iso @param {number} now
 */
export function ago(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  const n = new Date(now);
  const startToday = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  const startYesterday = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1).getTime();
  if (t >= startYesterday && t < startToday) return "yesterday";
  const d = new Date(t);
  return (d.getFullYear() === n.getFullYear() ? DAY_MONTH : DAY_MONTH_YEAR).format(d);
}

/**
 * "resets in 2 h 10 min", "resets in 45 min", "resets in 3 d 4 h"; "resets now" once the time has passed.
 * @param {string} iso @param {number} now
 */
export function resetsIn(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const minutes = Math.ceil((t - now) / 60_000);
  if (minutes <= 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `resets in ${hours} h` : `resets in ${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? `resets in ${days} d` : `resets in ${days} d ${h} h`;
}

/** "512 bytes", "1.5 KB", "1.2 MB" (1024 steps, one decimal, no trailing ".0"). @param {number} n */
export function bytes(n) {
  if (n < 1024) return n === 1 ? "1 byte" : `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${units[unit]}`;
}

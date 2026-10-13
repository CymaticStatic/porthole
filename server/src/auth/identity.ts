// Which Tailscale device an address belongs to: `tailscale whois --json <ip>` (Verified facts 3-4).

import { run } from "../exec";
import { asRecord, asString } from "../json";

export interface Who { node: string; login: string }

const MAX_CACHE = 256;

export class Whois {
  private readonly cache = new Map<string, { who: Who | null; until: number }>();
  private readonly pending = new Map<string, Promise<Who | null>>();

  constructor(private readonly bin: string, private readonly ttlMs = 60_000, private readonly missTtlMs = 5_000) {}

  async lookup(ip: string): Promise<Who | null> {
    if (!/^[0-9a-fA-F:.]+$/.test(ip)) return null;
    const hit = this.cache.get(ip);
    if (hit && hit.until > Date.now()) return hit.who;
    let p = this.pending.get(ip);
    if (!p) {
      p = this.query(ip).finally(() => this.pending.delete(ip));
      this.pending.set(ip, p);
    }
    return p;
  }

  private async query(ip: string): Promise<Who | null> {
    const r = await run([this.bin, "whois", "--json", ip]);
    let who: Who | null = null;
    if (r.code === 0) {
      try {
        const j = asRecord(JSON.parse(r.stdout));
        const node = asString(asRecord(j.Node).Name).split(".")[0];
        const login = asString(asRecord(j.UserProfile).LoginName);
        if (node && login) who = { node, login };
      } catch { who = null; }
    }
    this.cache.delete(ip);
    this.cache.set(ip, { who, until: Date.now() + (who ? this.ttlMs : this.missTtlMs) });
    // Map iterates in insertion order: the first key is the oldest entry.
    while (this.cache.size > MAX_CACHE) this.cache.delete(this.cache.keys().next().value as string);
    return who;
  }
}

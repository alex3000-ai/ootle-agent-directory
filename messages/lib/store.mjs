// Local state for one identity: how far each shard has been scanned, chunks waiting for the rest of their message, and the
// inbox/sent logs. Everything stays on the agent's machine (mode 0600).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeMessage, fromHex, parseChunk, toHex } from "./message.mjs";

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "state.json");
    this.state = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { shards: {}, partial: {}, inbox: [], sent: [], rejected: 0 };
  }

  save() {
    writeFileSync(this.path, JSON.stringify(this.state, null, 1), { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }

  /** Feed decrypted memos in; returns newly completed, verified messages. */
  ingest(myAddress, memos) {
    const done = [];
    for (const { bytes } of memos) {
      const c = parseChunk(bytes);
      if (!c || this.state.inbox.some((m) => m.id === c.id)) continue;
      const p = (this.state.partial[c.id] ??= { total: c.total, parts: {} });
      if (p.total !== c.total) continue;
      p.parts[c.index] = toHex(c.data);
      if (Object.keys(p.parts).length < p.total) continue;
      delete this.state.partial[c.id];
      try {
        const parts = Object.fromEntries(Object.entries(p.parts).map(([i, h]) => [i, fromHex(h)]));
        const msg = { ...decodeMessage(myAddress, c.id, parts, p.total), received_at: new Date().toISOString(), read: false };
        this.state.inbox.push(msg);
        done.push(msg);
      } catch {
        this.state.rejected++; // forged, or signed for someone else
      }
    }
    return done;
  }
}

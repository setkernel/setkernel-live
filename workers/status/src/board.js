// Board: the one object that holds the read model. The control Worker's objects are one per
// item and can't be listed, so each publishes its view here after it changes (README.md,
// "Feeding it"); /status reads this one object instead of hundreds. Seats are no longer kept:
// a deployed object's old `seats` table stays, unread.
//
// SQLite storage, no alarms and no WebSockets, so it is idle between requests and bills no
// duration then. Old rows are pruned inside each publish, not by a timer.

import { DurableObject } from "cloudflare:workers";
import { DAY_MS, ENDED, LOGGED, checkBatch } from "./model.js";

export const BOARD_NAME = "org";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS items (
    ref TEXT PRIMARY KEY, repo TEXT NOT NULL, number INTEGER NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, rev INTEGER NOT NULL, seat TEXT, pr INTEGER, session_url TEXT,
    updated_at TEXT NOT NULL)`,
  // one row each time an item reaches merged or failed: the "last 24 h" list
  `CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, ref TEXT NOT NULL, repo TEXT NOT NULL,
    number INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, seat TEXT, pr INTEGER)`,
  "CREATE INDEX IF NOT EXISTS events_at ON events (at)",
];

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const s of SCHEMA) this.sql.exec(s);
    this.now = () => new Date();
  }

  // { items } (model.js checkBatch) -> { ok, applied, stale, rejected }. An item applies only
  // with a higher rev than the board holds, so a late or repeated publish changes nothing. Two
  // exceptions, both writes the control Worker makes without raising rev: a fired dispatch after the move to
  // dispatched, so at the same rev a session link the board doesn't hold yet still applies; and
  // another PR taking over (WorkItem.github()), so at the same rev a newer updated_at applies
  // too. Neither takes a held link away.
  async publish(batch) {
    const checked = checkBatch(batch);
    if (checked.error) return { ok: false, status: 400, error: checked.error };
    const now = this.now();
    const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
    let applied = 0;
    let stale = 0;
    this.ctx.storage.transactionSync(() => {
      for (const r of checked.items) {
        const held = this.sql.exec("SELECT rev, state, session_url, updated_at FROM items WHERE ref = ?", r.ref).toArray()[0];
        const same = held && held.rev === r.rev;
        const link = same && held.session_url == null && r.session_url != null;
        const newer = same && r.updated_at > held.updated_at;
        if (held && held.rev >= r.rev && !link && !newer) {
          stale++;
          continue;
        }
        const session = same ? r.session_url ?? held.session_url : r.session_url;
        this.sql.exec(
          `INSERT INTO items (ref, repo, number, kind, state, rev, seat, pr, session_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (ref) DO UPDATE SET kind = excluded.kind, state = excluded.state, rev = excluded.rev,
             seat = excluded.seat, pr = excluded.pr, session_url = excluded.session_url, updated_at = excluded.updated_at`,
          r.ref, r.repo, r.number, r.kind, r.state, r.rev, r.seat, r.pr, session, r.updated_at,
        );
        if (LOGGED.includes(r.state) && held?.state !== r.state) {
          this.sql.exec(
            "INSERT INTO events (at, ref, repo, number, kind, state, seat, pr) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            r.updated_at, r.ref, r.repo, r.number, r.kind, r.state, r.seat, r.pr,
          );
        }
        applied++;
      }
      // the page shows a day of merges and failures; ended items and events older than that go
      this.sql.exec("DELETE FROM events WHERE at < ?", cutoff);
      this.sql.exec(`DELETE FROM items WHERE state IN (${ENDED.map(() => "?").join(", ")}) AND updated_at < ?`, ...ENDED, cutoff);
    });
    return { ok: true, applied, stale, rejected: checked.rejected };
  }

  // Everything the board holds, in one call: the open items and a day of events, and
  // when they were read (the Worker reuses a snapshot for up to FRESH seconds).
  async snapshot() {
    const now = this.now();
    const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
    const items = this.sql.exec(
      `SELECT ref, repo, number, kind, state, rev, seat, pr, session_url, updated_at FROM items
       WHERE state NOT IN (${ENDED.map(() => "?").join(", ")}) ORDER BY ref`,
      ...ENDED,
    ).toArray();
    const events = this.sql.exec("SELECT at, ref, repo, number, kind, state, seat, pr FROM events WHERE at >= ? ORDER BY seq", cutoff).toArray();
    return { ok: true, at: now.toISOString(), items, events };
  }
}

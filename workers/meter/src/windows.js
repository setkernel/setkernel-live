// Usage windows. Monthly allowances reset on the account's billing day (BILLING_DAY, 1-28, read
// it from the dashboard's billing page); Workers AI's free neurons reset daily at 00:00 UTC.
// A "gauge" metric (storage) has no reset: it is read over the last day, and what is stored now
// is what the month will bill.

const DAY = 86400000;

// Required: with no [vars] in wrangler.toml it arrives through the Infisical sync, and a
// silent default would measure the wrong month.
export function billingDay(value) {
  if (value == null || value === "") throw new Error("BILLING_DAY is not set (Infisical sk-ctl-workers)");
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 28) throw new Error(`BILLING_DAY must be 1-28, got ${value}`);
  return n;
}

// The window containing `now`: { start, end } as Dates, end exclusive.
export function windowFor(kind, now, day = 1) {
  if (kind === "gauge") return { start: new Date(now.getTime() - DAY), end: now };
  if (kind === "day") {
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return { start, end: new Date(start.getTime() + DAY) };
  }
  if (kind !== "month") throw new Error(`unknown window ${kind}`);
  const m = now.getUTCMonth() - (now.getUTCDate() < day ? 1 : 0);
  const start = new Date(Date.UTC(now.getUTCFullYear(), m, day));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, day));
  return { start, end };
}

// Share of the window that has passed, 0..1.
export function elapsed(window, now) {
  const f = (now - window.start) / (window.end - window.start);
  return Math.min(1, Math.max(0, f));
}

// Test doubles: a namespace that hands out one object per name as the runtime does, and Access
// tokens signed by a key the test owns. fakeState is Durable Object storage on a real SQLite;
// memoryKV is sk-meter's.
import { DatabaseSync } from "node:sqlite";

export { memoryKV } from "../../meter/test/fakes.js";

// ctx.storage.sql.exec(query, ...bindings) returns a cursor; transactionSync rolls back on throw.
export function fakeState() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query, ...bindings) {
      const st = db.prepare(query);
      const rows = st.columns().length ? st.all(...bindings) : (st.run(...bindings), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
  // One alarm, as the runtime keeps it: setAlarm replaces it, and storage.alarm is the time it is
  // set for (epoch ms) or null. A test runs it with object.alarm().
  const storage = {
    sql,
    alarm: null,
    async setAlarm(at) { storage.alarm = typeof at === "number" ? at : at.getTime(); },
    async getAlarm() { return storage.alarm; },
    async deleteAlarm() { storage.alarm = null; },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const r = fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  // ctx.waitUntil: the promises it was given, for a test to await (waits)
  const waits = [];
  return { storage, db, waits, waitUntil: (p) => { waits.push(p); } };
}

// init(object) runs once on each new object, e.g. to point a Board's clock at the test's.
export function fakeNamespace(Class, env = {}, init = () => {}) {
  const objects = new Map();
  const ns = {
    objects,
    gets: 0,
    idFromName: (name) => ({ name, toString: () => name }),
    get(id) {
      ns.gets++;
      if (!objects.has(id.name)) {
        const o = new Class(fakeState(), env);
        init(o);
        objects.set(id.name, o);
      }
      return objects.get(id.name);
    },
  };
  return ns;
}

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

// An RS256 signer standing in for setkernel's Access: sign(claims) -> a token, getKeys -> its JWKS.
export async function fakeAccess({ kid = "k1" } = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid };
  return {
    getKeys: async () => [jwk],
    async sign(claims, header = { alg: "RS256", kid }) {
      const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
      const body = `${enc(header)}.${enc(claims)}`;
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(body));
      return `${body}.${b64url(new Uint8Array(sig))}`;
    },
  };
}

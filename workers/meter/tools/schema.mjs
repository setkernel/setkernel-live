// The schema check: every dataset, field and filter key src/usage.js asks for, looked up in the
// live GraphQL schema by introspection, so a wrong name is found by name before the first deploy
// rather than as a query error. Read-only; the token is never part of a message.

import { ENDPOINT, SOURCES, GATEWAYS } from "../src/usage.js";

// "sum { a b } dimensions { c } count" -> [["sum", "a"], ["sum", "b"], ["dimensions", "c"], ["count"]]
export function selectionPaths(fields) {
  const tokens = fields.match(/[{}]|\w+/g) ?? [];
  const out = [];
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "{") continue;
    if (t === "}") { stack.pop(); continue; }
    if (tokens[i + 1] === "{") stack.push(t);
    else out.push([...stack, t]);
  }
  return out;
}

// The filter keys a query uses: the window bounds plus the source's own (eventType, ...).
export function filterKeys(source) {
  const own = [...(source.filter ?? "").matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  return ["datetime_geq", "datetime_leq", ...own];
}

// LIST / NON_NULL wrappers down to the named type.
const named = (t) => { while (t?.ofType) t = t.ofType; return t?.name ?? null; };

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
const TYPE_QUERY = `query T($name: String!) { __type(name: $name) {
  name fields { name type { ${TYPE_REF} } args { name type { ${TYPE_REF} } } }
  inputFields { name type { ${TYPE_REF} } }
} }`;

export function introspector(env, fetchImpl = fetch) {
  const cache = new Map();
  async function ask(query, variables) {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`introspection: HTTP ${res.status}`);
    const body = await res.json();
    if (body.errors?.length) throw new Error(`introspection: ${String(body.errors[0].message).slice(0, 200)}`);
    return body.data;
  }
  return {
    async root() {
      return (await ask("{ __schema { queryType { name } } }")).__schema.queryType.name;
    },
    async type(name) {
      if (!cache.has(name)) cache.set(name, ask(TYPE_QUERY, { name }).then((d) => d.__type));
      return cache.get(name);
    },
  };
}

// Problems as { where, missing, has }: `where` is the dataset (or the account type) and the path
// that couldn't be found, `has` the names that type does offer, for the fix.
export async function checkSchema(schema, sources = [...SOURCES, GATEWAYS]) {
  const problems = [];
  const field = async (typeName, name) => (await schema.type(typeName))?.fields?.find((f) => f.name === name) ?? null;
  const names = async (typeName, key = "fields") => ((await schema.type(typeName))?.[key] ?? []).map((f) => f.name).sort();

  const viewer = await field(await schema.root(), "viewer");
  const accounts = viewer && (await field(named(viewer.type), "accounts"));
  if (!accounts) return [{ where: "viewer.accounts", missing: "accounts", has: [] }];
  const account = named(accounts.type);

  for (const s of sources) {
    const ds = await field(account, s.dataset);
    if (!ds) {
      problems.push({ where: s.dataset, missing: s.dataset, has: (await names(account)).filter((n) => /Groups$|Adaptive$/.test(n)) });
      continue;
    }
    const filterType = named(ds.args?.find((a) => a.name === "filter")?.type);
    const offered = filterType ? await names(filterType, "inputFields") : [];
    for (const key of filterKeys(s)) {
      if (!offered.includes(key)) problems.push({ where: `${s.dataset}(filter)`, missing: key, has: offered });
    }
    for (const path of selectionPaths(s.fields)) {
      let typeName = named(ds.type);
      for (const [i, step] of path.entries()) {
        const f = await field(typeName, step);
        if (!f) {
          problems.push({ where: [s.dataset, ...path.slice(0, i)].join("."), missing: step, has: await names(typeName) });
          break;
        }
        typeName = named(f.type);
      }
    }
  }
  return problems;
}

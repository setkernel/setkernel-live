// Loaded before the tests (package.json: node --import): `cloudflare:workers` exists only on the
// Workers runtime, so the tests resolve it to a stand-in with the same base classes.
import { registerHooks } from "node:module";

const STAND_IN = new URL("./cloudflare-workers.js", import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    return specifier === "cloudflare:workers" ? { url: STAND_IN, shortCircuit: true } : next(specifier, context);
  },
});

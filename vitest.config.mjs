// The Worker and its Durable Object, run in workerd from wrangler.jsonc (npm run test:worker).
// The pure modules stay on node --test (npm test).
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // a throwaway Nostr key (not a secret) so the Buzz alert can sign
      miniflare: { bindings: { BUZZ_PRIVATE_KEY: "11".repeat(32) } },
    })],
  test: { include: ["test/worker/**/*.test.js"] },
});

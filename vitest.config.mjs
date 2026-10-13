// The Worker and its Durable Object, run in workerd from wrangler.jsonc (npm run test:worker).
// The pure modules stay on node --test (npm test).
import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["test/worker/**/*.test.js"] },
});

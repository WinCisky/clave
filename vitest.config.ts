import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against the real bindings from wrangler.jsonc — the same runtime that
// serves production. A Node-based runner would have no Durable Objects, no R2 and no `connect()`,
// so it could not exercise the parts most likely to be wrong.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
});

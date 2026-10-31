import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["test/unit/**/*.test.ts"],
        },
      },
      {
        plugins: [
          cloudflareTest(async () => {
            const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
            return {
              wrangler: { configPath: "./wrangler.jsonc" },
              // ADMIN_TOKEN is a dummy for tests; the real one is a Worker secret.
              miniflare: { bindings: { TEST_MIGRATIONS: migrations, ADMIN_TOKEN: "test-admin-token" } },
            };
          }),
        ],
        test: {
          name: "worker",
          include: ["test/worker/**/*.test.ts"],
          setupFiles: ["test/worker/setup.ts"],
        },
      },
    ],
  },
});

import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  testMatch: "*.spec.js",
  timeout: 30_000,
  workers: 1,
  use: { trace: "retain-on-failure" },
});

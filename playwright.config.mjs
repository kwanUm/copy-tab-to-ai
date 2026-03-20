import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"]],
  workers: 1, // Extensions need separate Chrome instances, run serially
});

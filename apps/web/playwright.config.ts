import { defineConfig } from "@playwright/test";

import { E2E_BASE_URL } from "./e2e/constants";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../../test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: E2E_BASE_URL,
    browserName: "chromium",
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx e2e/server.ts",
    url: E2E_BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

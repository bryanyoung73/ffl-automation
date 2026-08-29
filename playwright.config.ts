import { defineConfig, devices } from "@playwright/test";
import "dotenv/config";

const headless = process.env.HEADLESS !== "false";

export default defineConfig({
  testDir: "tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "artifacts",
  use: {
    baseURL: process.env.YAHOO_BASE_URL ?? "https://football.fantasysports.yahoo.com",
    headless,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});

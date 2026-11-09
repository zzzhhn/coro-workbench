import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    channel: process.env.CORO_TEST_BROWSER === 'chrome' ? 'chrome' : undefined,
    baseURL: `http://127.0.0.1:${process.env.CORO_FRONTEND_PORT ?? 5173}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
  ],
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${process.env.CORO_FRONTEND_PORT ?? 5173} --strictPort`,
    url: `http://127.0.0.1:${process.env.CORO_FRONTEND_PORT ?? 5173}`,
    reuseExistingServer: true,
  },
});

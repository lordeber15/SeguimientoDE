import { defineConfig, devices } from '@playwright/test';

// Reutiliza el mismo .env raíz que usan Vite y el backend (ver vite.config.ts).
const port = Number(process.env.FRONTEND_PORT ?? 5177);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Si el dev server ya está corriendo (reuseExistingServer), Playwright lo usa tal cual;
  // si no, lo levanta él mismo antes de correr los tests.
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});

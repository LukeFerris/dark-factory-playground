// `vitest/config` re-exports Vite's defineConfig widened with the `test` key,
// so the config typechecks with tsc --noEmit.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/setupTests.ts'],
    css: false,
    // Unit tests only. Vitest's default pattern would also collect `e2e/*.spec.ts`
    // and run Playwright's specs under jsdom, where `test` means something else
    // entirely — `npm test` would fail on a suite it was never meant to run.
    // The end-to-end suite has its own runner: `npm run e2e`.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})

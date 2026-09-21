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
  },
})

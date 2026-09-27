import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Runs before each test file's imports. Keeps the suite out of the
    // repository's `.agent`, which may belong to a turn that is running right
    // now — see the file itself.
    setupFiles: ['./vitest.setup.ts'],
  },
})

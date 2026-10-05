import { defineConfig } from 'vitest/config'

// Both workspaces in one run, for the coverage gate. The pre-commit hook reads
// coverage/coverage-summary.json from the repository root and looks each staged
// file up by its absolute path, so the report has to cover every workspace and
// land here rather than in each workspace's own directory. Each project keeps
// its own config: `npm test` inside a workspace runs exactly as before.
export default defineConfig({
  test: {
    projects: ['app', 'factory'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['app/src/**', 'factory/src/**'],
    },
  },
})

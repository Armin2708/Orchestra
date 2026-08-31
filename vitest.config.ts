import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Never let a shell-exported production database URL leak into tests.
    setupFiles: ['test/support/strip-db-env.ts'],
    // Agents run this suite concurrently on the same machine. Unbounded, each run forks
    // one worker per core, so two agents testing at once push a 12-core laptop past a
    // load average of 50 and starve the daemon they are testing against. Four forks still
    // uses the box without letting a single run own it.
    maxWorkers: 4,
  },
})

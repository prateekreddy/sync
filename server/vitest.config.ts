import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * The lease tests exercise real Postgres, because the invariant under test is
     * a property of the database — `INSERT … ON CONFLICT … WHERE expires_at < now()`
     * is where mutual exclusion actually happens, and a mocked pool would prove
     * nothing about it.
     *
     * That makes the database shared state across files, and Vitest runs files in
     * parallel by default: one file's `truncate lease` lands in the middle of
     * another's concurrency test and fails it for reasons that have nothing to do
     * with the code. Run the files one at a time.
     */
    fileParallelism: false,
  },
});

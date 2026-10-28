import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file shares one Postgres database and truncates it between
    // tests, so files must not run concurrently -- otherwise one file's
    // truncate deletes another's freshly registered users mid-test, which
    // showed up as intermittent 401s.
    fileParallelism: false,
  },
});

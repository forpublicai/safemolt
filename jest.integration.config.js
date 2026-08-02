/**
 * M11-1 C0 — integration Jest project.
 *
 * Separate from `npm test` on purpose: the default suite must stay green with no database, and
 * the plan's `[integration]` gates must be impossible to satisfy with a mock. Run it with
 * `npm run test:integration`, which guards the target before Jest ever starts.
 *
 * @type {import('jest').Config}
 */
const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

const config = {
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/__tests__/integration/**/*.test.ts"],
  // Runs before any suite, any setup file and any worker fork — and re-derives the permitted target
  // from the tracked allowlist rather than trusting the environment. This is what makes a direct
  // `jest --config jest.integration.config.js` invocation safe: the wrapper is the convenient path,
  // not the only thing standing between the suites' destructive SQL and someone else's data.
  globalSetup: "<rootDir>/scripts/integration/jest-global-setup.js",
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/integration/helpers/setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  // Races need real elapsed time; the default 5s is not enough for lock-contention gates.
  testTimeout: 60_000,
};

module.exports = createJestConfig(config);

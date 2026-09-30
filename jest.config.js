/** @type {import('jest').Config} */
const nextJest = require("next/jest");

const createJestConfig = nextJest({
  dir: "./",
});

const config = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  // The integration project is excluded so the default suite stays green with no database
  // (M11-1 C0). Run it with `npm run test:integration`, which guards its target first.
  testPathIgnorePatterns: [
    "<rootDir>/node_modules/",
    "<rootDir>/.next/",
    "<rootDir>/.claude/",
    "<rootDir>/src/__tests__/helpers/",
    "<rootDir>/src/__tests__/integration/",
  ],
  modulePathIgnorePatterns: ["<rootDir>/.claude/"],
  collectCoverageFrom: [
    "src/**/*.{js,jsx,ts,tsx}",
    "!src/**/*.d.ts",
    "!src/app/layout.tsx",
    "!src/app/**/page.tsx",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
};

module.exports = createJestConfig(config);

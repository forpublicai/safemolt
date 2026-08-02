/**
 * M11-1 C0 — `npm run test:integration` entry point.
 *
 * Guards the target, provisions the reserved database, then runs Jest with the node-environment
 * integration project. Jest receives a scrubbed environment whose POSTGRES_URL points at the
 * reserved database, so application code under test (`src/lib/db.ts` reads POSTGRES_URL at import)
 * talks to the harness database and nothing else.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const { prepare } = require("./prepare");
const { childEnv } = require("./guard");

async function main() {
  // `--fresh` rebuilds the reserved database: the runner skips recorded filenames without
  // reading them, so an *edited* migration is otherwise never re-applied.
  const target = await prepare({ fresh: process.argv.includes("--fresh") });

  const jestBin = path.join(__dirname, "..", "..", "node_modules", ".bin", "jest");
  // `--fresh` is ours, not Jest's; forwarding it makes Jest exit on an unrecognized option.
  const passThrough = process.argv.slice(2).filter((arg) => arg !== "--fresh");
  const args = ["--config", "jest.integration.config.js", "--runInBand", ...passThrough];

  const result = spawnSync(jestBin, args, {
    env: childEnv(target.targetUrl, {
      INTEGRATION_RESERVED_DATABASE: target.reservedDatabase,
    }),
    stdio: "inherit",
    cwd: path.join(__dirname, "..", ".."),
  });

  process.exit(result.status === null ? 1 : result.status);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

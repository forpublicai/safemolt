/**
 * M11-1 C0 — `npm run build:integration`.
 *
 * `npm run build` runs `node scripts/migrate.js && next build`, so a store-touching chunk's build
 * gate migrates whatever POSTGRES_URL points at. Pointing it at "a DB URL" is exactly the
 * ambiguity C0 forbids: this wrapper routes the build through the same guarded disposable target
 * as the integration suite, so a build gate can never migrate a developer's database.
 */
const { spawnSync } = require("child_process");
const path = require("path");
const { childEnv, describeTarget } = require("./guard");
const { prepare } = require("./prepare");
const { withHarnessLock } = require("./lock");

// Provision through the same path the test runner uses. Resolving the target alone would leave a
// fresh per-run branch with no reserved database, and the build's own migrate step would fail to
// connect rather than create it.
//
// Under the harness lock, because it provisions. The build stays inside the lock as well rather
// than only `prepare()`: `npm run build` runs `scripts/migrate.js` before `next build`, so the
// migrating part is not finished when `prepare` returns.
withHarnessLock(async (target) => {
  await prepare({ target });
  console.log(`[integration] building against ${describeTarget(target.targetUrl)}`);
  const result = spawnSync("npm", ["run", "build"], {
    env: childEnv(target.targetUrl),
    stdio: "inherit",
    cwd: path.join(__dirname, "..", ".."),
  });
  return result.status === null ? 1 : result.status;
})
  .then((status) => process.exit(status))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });

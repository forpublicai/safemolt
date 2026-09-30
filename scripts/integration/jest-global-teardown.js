/**
 * Release the harness lock `jest-global-setup.js` took for this run, and fail the run if it did not
 * survive.
 *
 * Losing the release itself is not a correctness hole — Postgres releases a session advisory lock
 * when the session ends, and the session ends with this process. Releasing explicitly frees a
 * waiting run at once rather than when the socket is reaped.
 */
const { DIRECT_RUN_LOCK } = require("./lock");

module.exports = async function globalTeardown() {
  const lock = globalThis[DIRECT_RUN_LOCK];
  if (!lock) return;
  delete globalThis[DIRECT_RUN_LOCK];

  // Asked of the server before releasing, not read off `lost`. A disconnect that has not yet been
  // dispatched leaves `lost` null, and `release()` then sets `released` and suppresses the late
  // error — so the one signal that says these results are void would arrive after nobody is
  // listening.
  const lost = (await lock.stillHeld()) ? null : (lock.lost ?? new Error("the lock session was gone"));
  await lock.release();

  // A suite that ran on without its lock may have been racing another run the whole time, and its
  // green result would be the least trustworthy thing in the log. Fail the run on the cause.
  if (lost) {
    throw new Error(
      `[integration] the harness lock was lost during this run: ${lost.message}\n` +
        `Another run may have been provisioning against the same database. Treat these results as void.`
    );
  }
};

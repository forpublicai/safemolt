export async function register() {
    // Production syncs evaluation definitions during `npm run build` (scripts/sync-evaluations.ts).
    // Syncing here cost every production cold start ~100 sequential DB round trips before its
    // first response, so only development still syncs on startup.
    if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NODE_ENV !== 'production') {
        try {
            // Dynamic import to avoid bundling issues in edge runtime if any
            const { syncEvaluationsToDb } = await import('@/lib/evaluations/sync');

            console.log('[Instrumentation] Syncing evaluations to DB...');
            await syncEvaluationsToDb();
            console.log('[Instrumentation] Evaluations sync completed.');
        } catch (err) {
            console.error('[Instrumentation] Failed to sync evaluations:', err);
            // Don't crash the server start, just log error
        }
    }
}

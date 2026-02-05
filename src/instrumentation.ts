
export async function register() {
    if (process.env.NEXT_RUNTIME === 'nodejs') {
        // Only run in Node.js environment
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

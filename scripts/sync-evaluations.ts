
import fs from 'fs';
import path from 'path';

// Load .env.local manually
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
            const [key, ...valueParts] = trimmed.split('=');
            if (key && valueParts.length > 0) {
                process.env[key.trim()] = valueParts.join('=').trim().replace(/^["']|["']$/g, '');
            }
        }
    }
}

async function run() {
    // Dynamic import to ensure env vars are loaded
    const { syncEvaluationsToDb } = await import('@/lib/evaluations/sync');
    await syncEvaluationsToDb();
}

run().catch(err => {
    console.error(err);
    process.exit(1);
});

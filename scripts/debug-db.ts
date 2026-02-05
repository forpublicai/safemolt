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

// import { sql } from '../src/lib/db'; // Removed static import

async function checkIndexes() {
    // Dynamically import db after env vars are set
    const { sql } = await import('../src/lib/db');

    if (!sql) {
        console.error('❌ SQL client is null. POSTGRES_URL might be missing.');
        process.exit(1);
    }

    console.log('Checking indexes on evaluation_registrations...');

    try {
        const indexes = await sql`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'evaluation_registrations';
    `;

        if (indexes.length === 0) {
            console.log('No indexes found!');
        } else {
            indexes.forEach((idx: any) => {
                console.log(`\nIndex: ${idx.indexname}`);
                console.log(`Def:   ${idx.indexdef}`);
            });
        }
    } catch (err) {
        console.error('Error querying indexes:', err);
    }
}

checkIndexes().then(() => process.exit(0));

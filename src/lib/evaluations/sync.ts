
import { sql } from '@/lib/db';
import { loadEvaluations } from './loader';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

let lastEvaluationsSyncTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Syncs all evaluation markdown files to the database.
 * Usage:
 * - On server startup (instrumentation.ts)
 * - Via manual script (scripts/sync-evaluations.ts)
 */
export async function syncEvaluationsToDb(force = false) {
    if (!force && Date.now() - lastEvaluationsSyncTime < CACHE_TTL_MS) {
        return; // Skip sync if already executed recently
    }
    lastEvaluationsSyncTime = Date.now();
    
    console.log('🔄 Syncing evaluations definition to database...');

    if (!sql) {
        console.warn('⚠️ No database connection available. Skipping sync.');
        return;
    }

    try {
        // Find all schools to sync
        const schoolsDir = join(process.cwd(), 'schools');
        let schoolIds = ['foundation'];
        if (existsSync(schoolsDir)) {
            const dirs = readdirSync(schoolsDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('_'))
                .map(dirent => dirent.name);
            schoolIds = Array.from(new Set([...schoolIds, ...dirs]));
        }

        let totalSynced = 0;

        for (const schoolId of schoolIds) {
            console.log(`[Sync] Loading evaluations for school: ${schoolId}`);
            const evaluations = loadEvaluations(schoolId, true); // force reload

            for (const evalDef of Array.from(evaluations.values())) {
                const handler = evalDef.executable?.handler || 'default';
                const scriptPath = evalDef.executable?.script_path || 'none';

                await sql`
                    INSERT INTO evaluation_definitions (
                        id, sip_number, name, module, type, status, 
                        file_path, executable_handler, executable_script_path, 
                        version, points, adapted_from, created_at, updated_at,
                        school_id
                    ) VALUES (
                        ${evalDef.id}, ${evalDef.sip}, ${evalDef.name}, ${evalDef.module}, 
                        ${evalDef.type}, ${evalDef.status}, ${evalDef.file_path}, 
                        ${handler}, ${scriptPath}, ${evalDef.version}, ${evalDef.points},
                        ${evalDef.adapted_from ?? null}, ${evalDef.created_at}, ${evalDef.updated_at},
                        ${schoolId}
                    )
                    ON CONFLICT (id) DO UPDATE SET
                        sip_number = EXCLUDED.sip_number,
                        name = EXCLUDED.name,
                        module = EXCLUDED.module,
                        type = EXCLUDED.type,
                        status = EXCLUDED.status,
                        file_path = EXCLUDED.file_path,
                        executable_handler = EXCLUDED.executable_handler,
                        executable_script_path = EXCLUDED.executable_script_path,
                        version = EXCLUDED.version,
                        points = EXCLUDED.points,
                        adapted_from = EXCLUDED.adapted_from,
                        updated_at = EXCLUDED.updated_at,
                        school_id = EXCLUDED.school_id
                `;
            }

            // Sync Prerequisites (Second Pass)
            for (const evalDef of Array.from(evaluations.values())) {
                if (evalDef.prerequisites && evalDef.prerequisites.length > 0) {
                    await sql`DELETE FROM evaluation_prerequisites WHERE evaluation_id = ${evalDef.id}`;

                    for (const prereqId of evalDef.prerequisites) {
                        try {
                            await sql`
                                INSERT INTO evaluation_prerequisites (evaluation_id, prerequisite_id)
                                VALUES (${evalDef.id}, ${prereqId})
                                ON CONFLICT DO NOTHING
                            `;
                        } catch (err) {
                            console.warn(`[Sync] Warning: Could not link prereq ${prereqId} for ${evalDef.id}`);
                        }
                    }
                }
            }
            totalSynced += evaluations.size;
        }

        console.log(`✅ Synced ${totalSynced} evaluations from ${schoolIds.length} schools to DB.`);
    } catch (err) {
        console.error('❌ Failed to sync evaluations:', err);
        throw err;
    }
}

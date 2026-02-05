
import { sql } from '@/lib/db';
import { loadEvaluations } from './loader';

/**
 * Syncs all evaluation markdown files to the database.
 * Usage:
 * - On server startup (instrumentation.ts)
 * - Via manual script (scripts/sync-evaluations.ts)
 */
export async function syncEvaluationsToDb() {
    console.log('🔄 Syncing evaluations definition to database...');

    if (!sql) {
        console.warn('⚠️ No database connection available. Skipping sync.');
        return;
    }

    try {
        const evaluations = loadEvaluations(true); // force reload

        // We treat the MD files as the source of truth.
        // Upsert each evaluation into evaluation_definitions.

        for (const evalDef of Array.from(evaluations.values())) {
            const handler = evalDef.executable?.handler || 'default';
            const scriptPath = evalDef.executable?.script_path || 'none';

            // Use explicit type casting if needed or rely on template literal inference
            await sql`
        INSERT INTO evaluation_definitions (
          id, sip_number, name, module, type, status, 
          file_path, executable_handler, executable_script_path, 
          version, created_at, updated_at
        ) VALUES (
          ${evalDef.id}, ${evalDef.sip}, ${evalDef.name}, ${evalDef.module}, 
          ${evalDef.type}, ${evalDef.status}, ${evalDef.file_path}, 
          ${handler}, ${scriptPath}, ${evalDef.version}, 
          ${evalDef.created_at}, ${evalDef.updated_at}
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
          updated_at = EXCLUDED.updated_at
      `;
        }

        // Sync Prerequisites (Second Pass)
        for (const evalDef of Array.from(evaluations.values())) {
            if (evalDef.prerequisites && evalDef.prerequisites.length > 0) {
                // Simple clean slate approach for junction table
                await sql`DELETE FROM evaluation_prerequisites WHERE evaluation_id = ${evalDef.id}`;

                for (const prereqId of evalDef.prerequisites) {
                    // Use INSERT IGNORE/ON CONFLICT DO NOTHING to avoid race/order failure if prereq missing
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

        console.log(`✅ Synced ${evaluations.size} evaluations to DB.`);
    } catch (err) {
        console.error('❌ Failed to sync evaluations:', err);
        throw err;
    }
}


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

async function syncEvaluations() {
    console.log('🔄 Syncing evaluations from markdown to database...');

    // Dynamic imports
    const { sql } = await import('../src/lib/db');
    const { loadEvaluations } = await import('../src/lib/evaluations/loader');

    if (!sql) {
        console.error('❌ SQL client is null');
        process.exit(1);
    }

    try {
        const evaluations = loadEvaluations(true); // force reload
        console.log(`Found ${evaluations.size} evaluations in filesystem.`);

        for (const evalDef of evaluations.values()) {
            console.log(`Syncing ${evalDef.id} (SIP-${evalDef.sip})...`);

            const handler = evalDef.executable?.handler || 'default';
            const scriptPath = evalDef.executable?.script_path || 'none';

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

            // Handle prerequisites
            if (evalDef.prerequisites && evalDef.prerequisites.length > 0) {
                // Clear existing prerequisites for this eval
                await sql`DELETE FROM evaluation_prerequisites WHERE evaluation_id = ${evalDef.id}`;

                for (const prereqId of evalDef.prerequisites) {
                    // Verify prereq exists first (simple check)
                    // We can just use ON CONFLICT DO NOTHING in case of race/order issues
                    // But strict FK might fail if prereq not inserted yet. 
                    // Ideally we should do 2 passes or topological sort. 
                    // For now, simpler: we assume prereqs are already synced or we ignore error?
                    // Actually, if we just try insert, we might fail if order is wrong.
                    // Let's do prerequisites in a second pass?
                }
            }
        }

        // Second pass for prerequisites
        console.log('🔗 Linking prerequisites...');
        for (const evalDef of evaluations.values()) {
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
                        console.warn(`Warning: Could not link prereq ${prereqId} for ${evalDef.id}. Make sure it exists.`);
                    }
                }
            }
        }

        console.log('✅ Sync complete!');
    } catch (err) {
        console.error('❌ Sync failed:', err);
        process.exit(1);
    }
}

syncEvaluations().then(() => process.exit(0));

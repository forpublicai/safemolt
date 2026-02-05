
import { parseEvaluationFile } from '@/lib/evaluations/parser';
import fs from 'fs';
import path from 'path';

const filePath = path.join(process.cwd(), 'evaluations/SIP-6.md');
const content = fs.readFileSync(filePath, 'utf-8');

try {
    console.log('Parsing SIP-6.md...');
    const evalDef = parseEvaluationFile(content, 'SIP-6.md');
    console.log('✅ Parse successful!');
    console.log('SIP:', evalDef.sip);
    console.log('ID:', evalDef.id);
    console.log('Config present:', !!evalDef.config);

    if (evalDef.config) {
        console.log('Prompts count:', (evalDef.config.prompts as any[])?.length);
        console.log('Rubric count:', (evalDef.config.rubric as any[])?.length);
        console.log('Sample prompt ID:', (evalDef.config.prompts as any[])?.[0]?.id);

        if (!(evalDef.config.prompts as any[])?.length) {
            console.error('❌ Prompts array is empty or undefined!');
        }
    } else {
        console.error('❌ Config object is missing!');
    }

} catch (err) {
    console.error('❌ Parse failed:', err);
}

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ override: true });

async function applyMigrations() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_KEY;

    if (!url || !key) {
        console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY in .env');
        process.exit(1);
    }

    const supabase = createClient(url, key);
    // Fix path to point to root supabase/migrations from build/db/migrate.js
    const migrationsDir = path.join(__dirname, '../../supabase/migrations');

    // Get migration files
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    console.log(`🚀 Applying ${files.length} migrations...\n`);

    for (const file of files) {
        const filePath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(filePath, 'utf-8');

        console.log(`📄 ${file}...`);

        try {
            const { error } = await supabase.rpc('exec_sql', { sql_string: sql });

            if (error) {
                console.error(`❌ Failed: ${error.message}`);
                process.exit(1);
            }

            console.log(`✅ Applied successfully\n`);
        } catch (err: any) {
            console.error(`❌ Error: ${err.message}`);
            process.exit(1);
        }
    }

    console.log('✨ All migrations applied successfully!');
}

applyMigrations();

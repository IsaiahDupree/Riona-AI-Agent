import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config();

const url = process.env.SUPABASE_URL!;
const key = process.env.SUPABASE_KEY!;

console.log('URL:', url);
console.log('Key (first 50 chars):', key.substring(0, 50));
console.log('Key length:', key.length);

const supabase = createClient(url, key);

async function test() {
    const { data, error } = await supabase.from('accounts').select('count').limit(1);

    if (error) {
        console.error('❌ Error:', error);
    } else {
        console.log('✅ Success:', data);
    }
}

test();

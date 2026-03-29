import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

export async function createTable() {
  try {
    console.log('Table creation should be done in Supabase dashboard');
    console.log('Please create the following tables:');
    console.log('');
    console.log('1. Table: problems');
    console.log('- id (text, primary key)');
    console.log('- difficulty (int8, nullable)');
    console.log('- updated_at (timestamp, default now())');
    console.log('');
    console.log('2. Table: crawl_tasks (for background crawling)');
    console.log('- id (int8, primary key, auto increment)');
    console.log('- status (text, default "pending") - values: pending, running, completed, failed');
    console.log('- current_page (int8, default 0)');
    console.log('- total_pages (int8, default 0)');
    console.log('- current_type (text, nullable) - values: luogu, CF, SP, UVA, AT');
    console.log('- error_message (text, nullable)');
    console.log('- created_at (timestamp, default now())');
    console.log('- updated_at (timestamp, default now())');
  } catch (error) {
    console.error('Error in createTable:', error);
    throw error;
  }
}

export async function isDatabaseEmpty() {
  try {
    const { count, error } = await supabase
      .from('problems')
      .select('*', { count: 'exact', head: true });
    
    if (error) {
      throw error;
    }
    
    return count === 0;
  } catch (error) {
    console.error('Error checking if database is empty:', error);
    throw error;
  }
}

export async function getAllProblems() {
  try {
    const allProblems = [];
    const batchSize = 10000; // Supabase 最大支持 10000
    let offset = 0;
    
    while (true) {
      const { data, error, count } = await supabase
        .from('problems')
        .select('*', { count: 'exact' })
        .order('id', { ascending: true })
        .range(offset, offset + batchSize - 1);
      
      if (error) {
        throw error;
      }
      
      if (!data || data.length === 0) {
        break;
      }
      
      allProblems.push(...data);
      offset += batchSize;
      
      // 如果返回的数据少于 batchSize，说明已经取完
      if (data.length < batchSize) {
        break;
      }
    }
    
    return allProblems;
  } catch (error) {
    console.error('Error getting all problems:', error);
    throw error;
  }
}

export async function upsertProblems(problems) {
  if (!problems || problems.length === 0) {
    return;
  }

  try {
    const formattedProblems = problems.map(p => ({
      id: p.id,
      difficulty: p.difficulty || null,
      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase
      .from('problems')
      .upsert(formattedProblems, { onConflict: 'id' });
    
    if (error) {
      throw error;
    }
    
    console.log(`Upserted ${problems.length} problems`);
  } catch (error) {
    console.error('Error upserting problems:', error);
    throw error;
  }
}

export async function clearProblems() {
  try {
    const { error } = await supabase
      .from('problems')
      .delete()
      .neq('id', '');
    
    if (error) {
      throw error;
    }
    
    console.log('Cleared all problems from database');
  } catch (error) {
    console.error('Error clearing problems:', error);
    throw error;
  }
}

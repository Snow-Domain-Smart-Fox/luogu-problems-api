import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

const PROBLEM_TYPES = ['luogu', 'CF', 'SP', 'UVA', 'AT'];

export async function initCrawlTask(forceRefresh = false) {
  try {
    const now = new Date().toISOString();
    
    // 如果强制刷新，先删除旧任务
    if (forceRefresh) {
      const { error: deleteError } = await supabase
        .from('crawl_tasks')
        .delete()
        .neq('id', 0);
      
      if (deleteError) {
        console.error('Error deleting old tasks:', deleteError);
      }
    }
    
    const { data: existingTask, error: fetchError } = await supabase
      .from('crawl_tasks')
      .select('*')
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (existingTask && !fetchError) {
      console.log('Found existing task:', existingTask.id);
      return existingTask;
    }
    
    const { data, error } = await supabase
      .from('crawl_tasks')
      .insert([{
        status: 'pending',
        current_type: PROBLEM_TYPES[0],
        current_page: 0,
        total_pages: 0,
        problems_crawled: 0,
        type_page_totals: {}, // 缓存各题型的总页数
        crawled_pages: [], // 记录已爬取的页面
        created_at: now,
        updated_at: now
      }])
      .select()
      .single();
    
    if (error) throw error;
    console.log('Created new crawl task:', data.id);
    return data;
  } catch (error) {
    console.error('Error initializing crawl task:', error);
    throw error;
  }
}

export async function updateCrawlTask(taskId, updates) {
  try {
    // 获取当前任务数据
    const { data: currentTask } = await supabase
      .from('crawl_tasks')
      .select('type_page_totals, crawled_pages')
      .eq('id', taskId)
      .single();
    
    // 合并更新的数据
    const mergedUpdates = { ...updates };
    
    // 合并 type_page_totals
    if (updates.type_page_totals && currentTask?.type_page_totals) {
      mergedUpdates.type_page_totals = {
        ...currentTask.type_page_totals,
        ...updates.type_page_totals
      };
    }
    
    // 合并 crawled_pages
    if (updates.crawled_pages && currentTask?.crawled_pages) {
      mergedUpdates.crawled_pages = [
        ...new Set([...currentTask.crawled_pages, ...updates.crawled_pages])
      ];
    }
    
    const { data, error } = await supabase
      .from('crawl_tasks')
      .update({
        ...mergedUpdates,
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId)
      .select()
      .single();
    
    if (error) throw error;
    return data;
  } catch (error) {
    console.error('Error updating crawl task:', error);
    throw error;
  }
}

export async function getLatestCrawlTask() {
  try {
    const { data, error } = await supabase
      .from('crawl_tasks')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  } catch (error) {
    console.error('Error getting latest crawl task:', error);
    return null;
  }
}

export async function getNextTaskToProcess() {
  try {
    const { data, error } = await supabase
      .from('crawl_tasks')
      .select('*')
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: true })
      .limit(1)
      .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  } catch (error) {
    console.error('Error getting next task:', error);
    return null;
  }
}

export async function completeCrawlTask(taskId) {
  try {
    await supabase
      .from('crawl_tasks')
      .update({
        status: 'completed',
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId);
    
    console.log('Task completed:', taskId);
  } catch (error) {
    console.error('Error completing task:', error);
  }
}

export async function failCrawlTask(taskId, errorMessage) {
  try {
    await supabase
      .from('crawl_tasks')
      .update({
        status: 'failed',
        error_message: errorMessage,
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId);
    
    console.log('Task failed:', taskId, errorMessage);
  } catch (error) {
    console.error('Error failing task:', error);
  }
}

export async function startCrawlTask(taskId, type, page, totalPages) {
  try {
    await supabase
      .from('crawl_tasks')
      .update({
        status: 'running',
        current_type: type,
        current_page: page,
        total_pages: totalPages,
        updated_at: new Date().toISOString()
      })
      .eq('id', taskId);
    
    console.log(`Started crawling ${type} page ${page}/${totalPages} for task ${taskId}`);
  } catch (error) {
    console.error('Error starting crawl task:', error);
    throw error;
  }
}

export async function getCachedPageTotal(taskId, type) {
  try {
    const { data, error } = await supabase
      .from('crawl_tasks')
      .select('type_page_totals')
      .eq('id', taskId)
      .single();
    
    if (error || !data) return null;
    return data.type_page_totals?.[type] || null;
  } catch (error) {
    console.error('Error getting cached page total:', error);
    return null;
  }
}

export async function isPageCrawled(taskId, type, page) {
  try {
    const { data, error } = await supabase
      .from('crawl_tasks')
      .select('crawled_pages')
      .eq('id', taskId)
      .single();
    
    if (error || !data) return false;
    const pageKey = `${type}:${page}`;
    return data.crawled_pages?.includes(pageKey) || false;
  } catch (error) {
    console.error('Error checking if page crawled:', error);
    return false;
  }
}

export function getAllProblemTypes() {
  return PROBLEM_TYPES;
}

export function getNextType(currentType) {
  const currentIndex = PROBLEM_TYPES.indexOf(currentType);
  if (currentIndex === -1 || currentIndex === PROBLEM_TYPES.length - 1) {
    return null;
  }
  return PROBLEM_TYPES[currentIndex + 1];
}

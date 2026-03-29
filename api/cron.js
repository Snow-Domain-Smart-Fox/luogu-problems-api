import { createTable } from '../lib/db.js';
import { initCrawlTask, completeCrawlTask } from '../lib/crawl-tasks.js';

export default async function handler(request, response) {
  try {
    if (request.method !== 'GET') {
      return response.status(405).json({ error: 'Method not allowed' });
    }

    const isVercelCron = Boolean(request.headers['x-vercel-cron-schedule']);
    const cronSecret = request.headers['authorization'];
    const expectedSecret = process.env.CRON_SECRET;
    const isProduction = process.env.VERCEL === '1';
    
    if (isProduction) {
      if (!isVercelCron) {
        console.log('Cron job triggered by unknown source');
        console.log('Headers:', request.headers);
        return response.status(403).json({ error: 'Unauthorized - Cron header missing' });
      }
      if (expectedSecret && cronSecret !== "Bearer " + expectedSecret) {
        console.log('Cron job triggered with invalid secret');
        console.log('Headers:', request.headers);
        return response.status(403).json({ error: 'Unauthorized - Invalid secret' });
      }
    }
    
    console.log('=== Cron Job Triggered ===');
    console.log('Environment:', isProduction ? 'Production (Vercel)' : 'Local');
    console.log('Clear first:', request.query.clear === 'true');
    
    await createTable();
    
    const clearFirst = request.query.clear === 'true';
    const forceRefresh = request.query.force === 'true';
    
    if (clearFirst || forceRefresh) {
      console.log('Clearing existing tasks and starting fresh crawl...');
      const { clearProblems } = await import('../lib/db.js');
      await clearProblems();
    }
    
    const task = await initCrawlTask(forceRefresh);
    
    return response.status(200).json({ 
      message: 'Cron job initiated. Crawl will proceed page by page.',
      taskId: task.id,
      status: task.status,
      note: 'Use /api/crawl-status to check progress'
    });
  } catch (error) {
    console.error('Error in cron job:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

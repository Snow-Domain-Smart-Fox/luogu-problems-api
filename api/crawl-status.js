import { getLatestCrawlTask, getAllProblemTypes } from '../lib/crawl-tasks.js';
import { getAllProblems } from '../lib/db.js';

export default async function handler(request, response) {
  try {
    if (request.method !== 'GET') {
      return response.status(405).json({ error: 'Method not allowed' });
    }

    const task = await getLatestCrawlTask();
    const problems = await getAllProblems();

    if (!task) {
      return response.status(200).json({
        status: 'idle',
        message: 'No crawl tasks found',
        problemsCount: problems ? problems.length : 0
      });
    }

    const totalEstimatedPages = getAllProblemTypes().length * 50;
    const progress = task.total_pages > 0 
      ? Math.round((task.current_page / task.total_pages) * 100) 
      : 0;

    const statusData = {
      status: task.status,
      taskId: task.id,
      currentType: task.current_type,
      currentPage: task.current_page,
      totalPages: task.total_pages,
      problemsCrawled: task.problems_crawled || 0,
      totalProblemsInDb: problems ? problems.length : 0,
      progress: `${progress}%`,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      errorMessage: task.error_message,
      cache: {
        typePageTotals: task.type_page_totals || {},
        crawledPagesCount: task.crawled_pages?.length || 0
      }
    };

    if (task.status === 'completed') {
      const hoursSinceCompletion = (Date.now() - new Date(task.updated_at).getTime()) / 3600000;
      const daysSinceCompletion = Math.round(hoursSinceCompletion / 24);
      const daysRemaining = Math.max(0, 30 - daysSinceCompletion);
      
      statusData.message = `Crawl completed successfully! ${daysSinceCompletion} days ago.`;
      statusData.cooldown = {
        daysSinceCompletion,
        daysRemaining,
        nextAutoUpdate: daysRemaining > 0 
          ? `${daysRemaining} days` 
          : 'Ready for next update (30 days passed)'
      };
    } else if (task.status === 'failed') {
      statusData.message = `Crawl failed: ${task.error_message}`;
    } else if (task.status === 'running') {
      statusData.message = `Currently crawling ${task.current_type} page ${task.current_page}/${task.total_pages}`;
    } else if (task.status === 'pending') {
      statusData.message = 'Waiting to start crawl';
    }

    response.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate');
    return response.status(200).json(statusData);
  } catch (error) {
    console.error('Error in crawl-status:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

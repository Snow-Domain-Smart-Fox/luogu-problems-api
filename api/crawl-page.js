import { initCrawlTask, getNextTaskToProcess, getLatestCrawlTask } from '../lib/crawl-tasks.js';
import { crawlSinglePage, sleep } from '../lib/crawler.js';

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
        console.log('Crawl job triggered by unknown source');
        console.log('Headers:', request.headers);
        return response.status(403).json({ error: 'Unauthorized - Cron header missing' });
      }
      if (expectedSecret && cronSecret !== "Bearer " + expectedSecret) {
        console.log('Crawl job triggered with invalid secret');
        console.log('Headers:', request.headers);
        return response.status(403).json({ error: 'Unauthorized - Invalid secret' });
      }
    }

    console.log('=== Crawl Page Endpoint Triggered ===');
    
    const forceRefresh = request.query.force === 'true';
    
    if (forceRefresh) {
      console.log('Force refresh requested, clearing old tasks...');
    }
    
    // 先检查是否有已完成的任务及其冷却状态
    const completedTask = await getLatestCrawlTask();
    let inCooldown = false;
    let daysSinceCompletion = 0;
    
    if (completedTask && completedTask.status === 'completed' && !forceRefresh) {
      const hoursSinceCompletion = (Date.now() - new Date(completedTask.updated_at).getTime()) / 3600000;
      daysSinceCompletion = Math.round(hoursSinceCompletion / 24);
      
      // 如果完成不到 30 天，进入冷却期
      if (daysSinceCompletion < 30) {
        inCooldown = true;
        console.log(`Task completed ${daysSinceCompletion} days ago. In cooldown period (30 days).`);
      } else {
        console.log(`${daysSinceCompletion} days passed, starting periodic update...`);
      }
    }
    
    // 获取待处理任务（不包括已完成的任务）
    let task = await getNextTaskToProcess();
    
    // 如果没有待处理任务，且在冷却期内，直接返回
    if (!task && inCooldown) {
      return response.status(200).json({
        status: 'completed',
        message: `All problems crawled successfully. Completed ${daysSinceCompletion} days ago.`,
        completedAt: completedTask.updated_at,
        daysSinceCompletion,
        daysRemaining: 30 - daysSinceCompletion,
        nextCheck: '30 days after completion',
        note: 'Use ?force=true to start a new crawl immediately'
      });
    }
    
    // 没有任务（冷却期外或强制刷新），创建新任务
    if (!task) {
      console.log('No pending tasks, initializing new crawl task...');
      task = await initCrawlTask(forceRefresh);
    }
    
    if (!task) {
      return response.status(500).json({ error: 'Failed to initialize crawl task' });
    }
    
    console.log(`Processing task ${task.id}: ${task.current_type} page ${task.current_page}`);
    
    const type = task.current_type || 'luogu';
    const page = task.current_page || 1;
    
    const result = await crawlSinglePage(task.id, type, page, forceRefresh);
    
    if (result.success) {
      if (result.completed) {
        console.log('Crawl completed successfully!');
        console.log('Task:', task);
        console.log('Result:', result);
        return response.status(200).json({
          message: 'Crawl completed successfully!',
          taskId: task.id,
          completed: true,
          forceRefresh
        });
      } else {
        // 检查是否是自动连续触发模式
        const isAutoChain = request.query.auto === 'true';
        
        // 如果是自动连续触发模式且未跳过，等待 10 秒后触发下一个请求
        if (isAutoChain && !result.skipped) {
          console.log(`Auto-chaining: Will trigger page ${result.nextPage} in 10 seconds...`);
          
          try {
            // 等待 5 秒
            await sleep(50000);
            
            const baseUrl = request.headers.host 
              ? `https://${request.headers.host}/api/crawl-page?auto=true`
              : `/api/crawl-page?auto=true`;
            
            console.log(`Triggering next page: ${baseUrl}`);
            
            // 使用 fetch 触发下一个请求（生产环境）
            if (process.env.VERCEL === '1') {
              const fetchResponse = await fetch(baseUrl, {
                method: 'GET',
                headers: {
                  'x-vercel-cron-schedule': '1',
                  'authorization': "Bearer " + process.env.CRON_SECRET || ''
                }
              });
              
              if (!fetchResponse.ok) {
                console.error('Error: Next page request failed with status:', fetchResponse.status);
                const errorText = await fetchResponse.text();
                console.error('Error response:', errorText);
              } else {
                console.log('Next page triggered successfully!');
              }
            }
          } catch (err) {
            console.error('Error triggering next page:', err.message);
            console.error('Stack trace:', err.stack);
          }
        }
        
        // 准备响应数据
        const responseData = {
          message: result.skipped ? `Skipped ${type} page ${page} (already crawled)` : `Crawled ${type} page ${page} successfully`,
          taskId: task.id,
          completed: false,
          nextType: result.nextType,
          nextPage: result.nextPage,
          skipped: result.skipped || false,
          autoChain: isAutoChain && !result.skipped,
          // 告诉客户端应该等待多久后发起下一个请求（毫秒）
          nextTriggerDelay: isAutoChain && !result.skipped ? 10000 : null,
          // 下一个请求的 URL
          nextUrl: isAutoChain && !result.skipped 
            ? `/api/crawl-page?auto=true` 
            : null
        };
        
        return response.status(200).json(responseData);
      }
    } else {
      return response.status(500).json({
        error: 'Crawl failed',
        taskId: task.id,
        details: result.error
      });
    }
  } catch (error) {
    console.error('Error in crawl-page:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

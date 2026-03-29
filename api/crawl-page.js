import { initCrawlTask, getNextTaskToProcess, getLatestCrawlTask } from '../lib/crawl-tasks.js';
import { crawlSinglePage, sleep } from '../lib/crawler.js';
import { Client as QstashClient } from '@upstash/qstash';

// 初始化 QStash 客户端
const qstashClient = process.env.QSTASH_URL && process.env.QSTASH_TOKEN
  ? new QstashClient({
      url: process.env.QSTASH_URL,
      token: process.env.QSTASH_TOKEN
    })
  : null;

export default async function handler(request, response) {
  try {

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
        
        // 如果是自动连续触发模式且未跳过，使用 QStash 调度下一个请求
        if (isAutoChain && !result.skipped) {
          console.log(`Auto-chaining: Will schedule page ${result.nextPage} in 5 seconds via QStash...`);
          
          // 检查 QStash 配置
          const hasQStashConfig = !!(process.env.QSTASH_URL && process.env.QSTASH_TOKEN);
          console.log('QStash config check:', {
            hasURL: !!process.env.QSTASH_URL,
            hasToken: !!process.env.QSTASH_TOKEN,
            clientInitialized: !!qstashClient
          });
          
          if (qstashClient && hasQStashConfig) {
            console.log('Attempting to schedule via QStash...');
            
            // 使用 Promise.race 添加超时保护
            const schedulePromise = qstashClient.publishJSON({
              url: 'https://problems.amlg.top/api/crawl-page?auto=true',
              body: {},
              headers: {
                'x-vercel-cron-schedule': '1',
                'authorization': 'Bearer ' + process.env.CRON_SECRET || ''
              },
              delay: '5s' // 5 秒后执行
            });
            
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('QStash scheduling timeout (5s)')), 5000);
            });
            
            try {
              // 最多等待 5 秒
              const scheduleResult = await Promise.race([schedulePromise, timeoutPromise]);
              console.log('Next page scheduled via QStash:', scheduleResult);
            } catch (err) {
              console.error('Error scheduling next page via QStash:', err.message);
              if (err.stack) {
                console.error('Stack trace:', err.stack);
              }
              console.log('Continuing without auto-chain...');
            }
          } else {
            console.warn('QStash not configured properly, skipping auto-chain');
            console.warn('Please set QSTASH_URL and QSTASH_SIGNING_KEY environment variables');
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
          scheduledViaQStash: !!(qstashClient && isAutoChain && !result.skipped)
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

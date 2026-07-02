import { initCrawlTask, getNextTaskToProcess, failCrawlTask } from '../lib/crawl-tasks.js';
import { crawlSinglePage } from '../lib/crawler.js';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  try {
    console.log('Runner started');

    // 先尝试取出已有的未完成任务（pending / running）
    let task = await getNextTaskToProcess();
    if (task) {
      console.log('Found existing pending/running task — will continue:', task.id);
    } else {
      console.log('No pending task found, creating a new one...');
      task = await initCrawlTask(false); // 不删除旧任务
    }

    if (!task) {
      console.error('Failed to obtain or initialize a task. Exiting.');
      process.exit(1);
    }

    console.log('Processing task', task.id);

    // 持续推进直到该任务完成或发生不可恢复的错误
    let type = task.current_type || 'luogu';
    let page = task.current_page || 1;

    while (true) {
      console.log(`Crawling ${type} page ${page} for task ${task.id}`);
      const result = await crawlSinglePage(task.id, type, page, false);
      console.log('crawlSinglePage result:', JSON.stringify(result));

      if (!result.success) {
        console.error('Crawl failed for', type, page, 'error:', result.error);
        try {
          await failCrawlTask(task.id, result.error || 'crawl failed');
        } catch (e) {
          console.error('failCrawlTask failed:', e && e.message ? e.message : e);
        }
        process.exit(2);
      }

      if (result.completed) {
        console.log('Task completed:', task.id);
        break;
      }

      // advance to next page/type as returned
      type = result.nextType || type;
      page = result.nextPage || (page + 1);

      // polite delay
      await sleep(500);
    }

    console.log('Runner finished');
    process.exit(0);
  } catch (err) {
    console.error('Runner unexpected error:', err && err.stack ? err.stack : err);
    // 尝试把任务标记为失败（如果 task 可见）
    try {
      if (typeof task !== 'undefined' && task && task.id) {
        await failCrawlTask(task.id, err && err.message ? err.message : String(err));
      }
    } catch (e) {
      console.error('Marking task failed also failed:', e && e.message ? e.message : e);
    }
    process.exit(3);
  }
}

main();

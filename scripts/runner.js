import { initCrawlTask } from '../lib/crawl-tasks.js';
import { crawlSinglePage } from '../lib/crawler.js';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  try {
    console.log('Runner started');

    // 每次运行都创建一个新的 Supabase 任务（forceRefresh = true 会删除旧任务）
    console.log('Creating a fresh crawl task (forceRefresh=true)...');
    const task = await initCrawlTask(true);

    if (!task) {
      console.error('Failed to create a new crawl task. Exiting.');
      process.exit(1);
    }

    console.log('Processing new task', task.id);

    let type = task.current_type || 'luogu';
    let page = task.current_page || 1;

    // 一直运行直到该任务完成或出现不可恢复的错误
    while (true) {
      console.log(`Crawling ${type} page ${page} for task ${task.id}`);
      const result = await crawlSinglePage(task.id, type, page, false);
      console.log('crawlSinglePage result:', JSON.stringify(result));

      if (!result.success) {
        console.error('Crawl failed for', type, page, 'error:', result.error);
        // 标记失败并退出（Actions 将显示失败）
        process.exit(2);
      }

      if (result.completed) {
        console.log('Task completed:', task.id);
        break;
      }

      // advance to next page/type as returned
      type = result.nextType || type;
      page = result.nextPage || (page + 1);

      // small polite delay
      await sleep(500);
    }

    console.log('Runner finished');
    process.exit(0);
  } catch (err) {
    console.error('Runner unexpected error:', err && err.stack ? err.stack : err);
    process.exit(3);
  }
}

main();

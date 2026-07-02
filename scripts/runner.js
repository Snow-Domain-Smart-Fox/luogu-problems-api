import { initCrawlTask, getNextTaskToProcess, failCrawlTask } from '../lib/crawl-tasks.js';
import { crawlSinglePage } from '../lib/crawler.js';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isFirstDayInShanghai() {
  // 返回 Asia/Shanghai 时区的“日”是否为 1
  const dayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    day: '2-digit',
  }).format(new Date());
  return parseInt(dayStr, 10) === 1;
}

async function main() {
  let task;
  try {
    console.log('Runner started');

    const firstDay = isFirstDayInShanghai();
    if (firstDay) {
      console.log('Today is the first day of the month (Asia/Shanghai) — creating a new crawl task...');
      // 这里传 true/false 取决于 initCrawlTask 的语义；若需要删除旧任务请传 true。
      // 我这里使用 true 来确保创建全新的任务；如需改回不删除旧任务请告诉我。
      task = await initCrawlTask(true);
    } else {
      // 非每月第一天：只延续已有的任务；找不到则直接退出(0)
      console.log('Not the first day of month — attempting to continue an existing pending/running task...');
      task = await getNextTaskToProcess();
      if (!task) {
        console.log('No pending/running task found and today is not the first of the month — nothing to do. Exiting.');
        process.exit(0);
      } else {
        console.log('Found existing pending/running task — will continue:', task.id);
      }
    }

    if (!task) {
      console.error('Failed to obtain or initialize a task. Exiting with error.');
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

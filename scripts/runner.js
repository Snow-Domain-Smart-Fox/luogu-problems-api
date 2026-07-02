import { initCrawlTask, getNextTaskToProcess } from '../lib/crawl-tasks.js';
import { crawlSinglePage } from '../lib/crawler.js';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  try {
    console.log('Runner started');

    // Try to get an existing pending/running task
    let task = await getNextTaskToProcess();
    if (!task) {
      console.log('No pending task found, initializing a new one...');
      task = await initCrawlTask(false);
    }

    if (!task) {
      console.error('Failed to obtain or initialize a task. Exiting.');
      process.exit(1);
    }

    console.log('Processing task', task.id);

    // Process pages in a loop with a safety cap to avoid infinite runs in Actions
    const MAX_ITER = Number(process.env.MAX_CRAWL_ITER) || 500;
    let type = task.current_type || 'luogu';
    let page = task.current_page || 1;

    for (let i = 0; i < MAX_ITER; i++) {
      console.log(`Iteration ${i + 1}/${MAX_ITER} - Crawling ${type} page ${page} for task ${task.id}`);
      const result = await crawlSinglePage(task.id, type, page, false);
      console.log('crawlSinglePage result:', JSON.stringify(result));

      if (!result.success) {
        console.error('Crawl failed for', type, page, 'error:', result.error);
        // Exit non-zero to mark failure so you can investigate in Actions logs
        process.exit(2);
      }

      if (result.completed) {
        console.log('Task completed:', task.id);
        break;
      }

      // advance to next page/type as returned by the task
      type = result.nextType || type;
      page = result.nextPage || (page + 1);

      // a small delay to avoid hammering services
      await sleep(500);

      // refresh task from DB in case it was updated elsewhere
      const nextTask = await getNextTaskToProcess();
      if (nextTask && nextTask.id !== task.id) {
        console.log('Switching to a different task provided by queue:', nextTask.id);
        task = nextTask;
        type = task.current_type || 'luogu';
        page = task.current_page || 1;
      }
    }

    console.log('Runner finished');
    process.exit(0);
  } catch (err) {
    console.error('Runner unexpected error:', err && err.stack ? err.stack : err);
    process.exit(3);
  }
}

main();

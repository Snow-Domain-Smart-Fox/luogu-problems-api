import cf from 'cfscrape';
import * as cheerio from 'cheerio';
import { upsertProblems, clearProblems } from './db.js';
import { 
  updateCrawlTask, 
  completeCrawlTask, 
  failCrawlTask,
  startCrawlTask,
  getNextType,
  getAllProblemTypes,
  getCachedPageTotal,
  isPageCrawled
} from './crawl-tasks.js';

// 全局缓存cf会话，复用验证cookie
let scraperInstance = null;
const defaultHeaders = {
  'x-luogu-type': 'content-only',
  'x-lentille-request': 'content-only'
};

// 基础休眠
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 随机休眠 0.8~1.5s 防爬虫特征
export function randomSleep() {
  const ms = 800 + Math.floor(Math.random() * 700);
  return sleep(ms);
}

// 重建cfscrape会话（403拦截时调用）
function resetScraper() {
  scraperInstance = cf.create();
  // 固定UA，cfscrape会自动补充浏览器指纹
  scraperInstance.defaults.headers.common['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  Object.entries(defaultHeaders).forEach(([k, v]) => {
    scraperInstance.defaults.headers.common[k] = v;
  });
  scraperInstance.defaults.timeout = 30000;
  scraperInstance.defaults.maxRedirects = 5;
}

// 获取/初始化scraper
function getScraper() {
  if (!scraperInstance) resetScraper();
  return scraperInstance;
}

/**
 * 带CF验证的请求封装，自动处理人机挑战
 */
async function fetchContent(url, retry = 0, maxRetry = 3) {
  if (retry >= maxRetry) throw new Error(`请求${url}重试${maxRetry}次全部失败，被Cloudflare拦截`);
  const scraper = getScraper();
  try {
    console.log(`[${retry}/${maxRetry}] Fetching: ${url}`);
    const resp = await scraper.get(url);
    console.log(`Fetched: ${url}, status: ${resp.status}`);
    return resp;
  } catch (err) {
    // CF 403拦截/验证失败，重置会话重试
    if (err.statusCode === 403 || err.message.includes('cloudflare')) {
      console.warn(`Cloudflare 拦截，重置会话重试，等待${(retry + 1) * 1500}ms`);
      resetScraper();
      await sleep((retry + 1) * 1500);
      return fetchContent(url, retry + 1, maxRetry);
    }
    // 普通网络错误，指数退避
    const wait = Math.pow(2, retry) * 1000;
    console.error(`请求失败，等待${wait}ms重试: ${err.message}`);
    await sleep(wait);
    return fetchContent(url, retry + 1, maxRetry);
  }
}

/**
 * 获取某分类总页数
 */
async function fetchProblemTotal(type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=1`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const contextStr = $('#lentille-context').html();
  if (!contextStr) throw new Error('页面无lentille-context数据，被CF拦截或页面结构变更');
  const json = JSON.parse(contextStr);
  const totalCount = json.data.problems.count;
  const totalPage = Math.ceil(totalCount / 50);
  console.log(`${type} 总题目:${totalCount}, 总页数:${totalPage}`);
  return totalPage;
}

/**
 * 单页爬取题目列表
 */
async function fetchProblemPage(page, type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=${page}`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const contextStr = $('#lentille-context').html();
  if (!contextStr) throw new Error('页面无lentille-context数据');
  const json = JSON.parse(contextStr);
  const list = json.data.problems.result || [];
  console.log(`[${type}] page${page} 获取题目${list.length}条`);
  return list.map(i => ({
    id: i.pid,
    difficulty: i.difficulty,
  }));
}

/**
 * 全量爬取单个分类所有页面
 */
async function updateProblemSet(type) {
  const total = await fetchProblemTotal(type);
  for (let page = 1; page <= total; page++) {
    const problems = await fetchProblemPage(page, type);
    if (problems.length > 0) await upsertProblems(problems);
    console.log(`${type} 进度 ${page}/${total}，等待随机间隔...`);
    await randomSleep();
  }
}

/**
 * 单任务单页爬取（对外接口）
 */
export async function crawlSinglePage(taskId, type, page, forceRefresh = false) {
  try {
    // 跳过已爬页面
    if (!forceRefresh) {
      const crawled = await isPageCrawled(taskId, type, page);
      if (crawled) {
        console.log(`Task${taskId}: ${type} page${page}已爬取，跳过`);
        let total = await getCachedPageTotal(taskId, type);
        if (!total) {
          total = await fetchProblemTotal(type);
          await updateCrawlTask(taskId, { type_page_totals: { [type]: total } });
        }
        const nextPage = page + 1;
        if (nextPage > total) {
          const nextType = getNextType(type);
          if (nextType) {
            await updateCrawlTask(taskId, { current_type: nextType, current_page: 1 });
            return { success: true, completed: false, nextType, nextPage: 1, skipped: true };
          } else {
            await completeCrawlTask(taskId);
            return { success: true, completed: true, skipped: true };
          }
        }
        await updateCrawlTask(taskId, { current_page: nextPage });
        return { success: true, completed: false, nextType: type, nextPage, skipped: true };
      }
    }

    // 读取/缓存总页数
    let total = await getCachedPageTotal(taskId, type);
    if (!total) {
      console.log(`Task${taskId}: ${type}无缓存总页数，拉取`);
      total = await fetchProblemTotal(type);
      await updateCrawlTask(taskId, { type_page_totals: { [type]: total } });
    } else {
      console.log(`Task${taskId}: 使用缓存总页数 ${type} = ${total}`);
    }

    if (page > total) {
      console.log(`Task${taskId}: ${type} page${page}超出总页数${total}，切换下一类`);
      const nextType = getNextType(type);
      if (nextType) {
        await updateCrawlTask(taskId, { current_type: nextType, current_page: 1, total_pages: 0 });
        return { success: true, completed: false, nextType, nextPage: 1 };
      } else {
        await completeCrawlTask(taskId);
        return { success: true, completed: true };
      }
    }

    await startCrawlTask(taskId, type, page, total);
    const problems = await fetchProblemPage(page, type);
    if (problems.length) await upsertProblems(problems);

    // 标记已爬页面
    await updateCrawlTask(taskId, { crawled_pages: [`${type}:${page}`] });
    const addCount = problems.length || 0;

    const nextPage = page + 1;
    const finishType = nextPage > total;

    if (finishType) {
      const nextType = getNextType(type);
      if (nextType) {
        await updateCrawlTask(taskId, {
          current_type: nextType,
          current_page: 1,
          total_pages: 0,
          $inc: { problems_crawled: addCount }
        });
        console.log(`Task${taskId}: ${type}全部完成，切换${nextType}`);
        return { success: true, completed: false, nextType, nextPage: 1 };
      } else {
        await updateCrawlTask(taskId, { $inc: { problems_crawled: addCount } });
        await completeCrawlTask(taskId);
        console.log(`Task${taskId}: 全部分类爬取完毕`);
        return { success: true, completed: true };
      }
    } else {
      await updateCrawlTask(taskId, {
        current_page: nextPage,
        $inc: { problems_crawled: addCount }
      });
      console.log(`Task${taskId}: ${type} page${page}完成，下一页${nextPage}`);
      return { success: true, completed: false, nextType: type, nextPage };
    }
  } catch (error) {
    console.error(`Task${taskId} 爬取失败 ${type} page${page}:`, error.message);
    await updateCrawlTask(taskId, { error_message: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * 一次性全量爬取所有分类
 */
export async function crawlAllProblems(clearFirst = false) {
  try {
    if (clearFirst) await clearProblems();
    const types = getAllProblemTypes();
    for (const type of types) {
      await updateProblemSet(type);
      await randomSleep();
    }
    console.log('全部题目爬取完成');
  } catch (err) {
    console.error('全量爬取异常:', err);
    throw err;
  }
}

import cloudscraper from 'cloudscraper';
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

// 全局CF会话实例，复用验证Cookie
let scraperInstance = null;

const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'x-luogu-type': 'content-only',
  'x-lentille-request': 'content-only'
};

// 基础休眠
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 随机休眠 0.8~1.5s 降低爬虫特征
export function randomSleep() {
  const ms = 800 + Math.floor(Math.random() * 700);
  return sleep(ms);
}

// 重建cloudscraper实例（403拦截时调用）
function resetScraper() {
  scraperInstance = cloudscraper.createInstance({
    timeout: 30000,
    followAllRedirects: true
  });
}

// 获取/初始化scraper
function getScraper() {
  if (!scraperInstance) resetScraper();
  return scraperInstance;
}

/**
 * 带CF人机验证自动处理的请求封装
 * @param {string} url
 * @param {number} retry 当前重试次数
 * @param {number} maxRetry 最大重试次数
 * @returns {{data: string}}
 */
async function fetchContent(url, retry = 0, maxRetry = 3) {
  if (retry >= maxRetry) {
    throw new Error(`请求 ${url} 重试${maxRetry}次全部失败，持续被Cloudflare拦截`);
  }

  const req = getScraper();
  try {
    console.log(`[${retry}/${maxRetry}] Fetching: ${url}`);
    const html = await req.get(url, { headers: defaultHeaders });
    console.log(`Success fetch: ${url}`);
    return { data: html };
  } catch (err) {
    // CF 403拦截，重置会话后退避重试
    if (err.statusCode === 403 || err.message.toLowerCase().includes('cloudflare')) {
      const waitTime = (retry + 1) * 1500;
      console.warn(`Cloudflare 拦截，重置会话，等待${waitTime}ms后重试`);
      resetScraper();
      await sleep(waitTime);
      return fetchContent(url, retry + 1, maxRetry);
    }
    // 普通网络错误，指数退避
    const wait = Math.pow(2, retry) * 1000;
    console.error(`网络请求异常，等待${wait}ms重试: ${err.message}`);
    await sleep(wait);
    return fetchContent(url, retry + 1, maxRetry);
  }
}

/**
 * 获取指定分类总页数
 * @param {string} type
 * @returns {number} 总页数
 */
async function fetchProblemTotal(type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=1`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const contextRaw = $('#lentille-context').html();

  if (!contextRaw) throw new Error('页面缺失 #lentille-context 数据，被拦截或页面改版');

  const json = JSON.parse(contextRaw);
  const totalCount = json.data.problems.count;
  const totalPage = Math.ceil(totalCount / 50);
  console.log(`分类 ${type}：总题目${totalCount}，总分页${totalPage}`);
  return totalPage;
}

/**
 * 单页爬取题目列表
 * @param {number} page
 * @param {string} type
 * @returns {Array<{id: string, difficulty: number}>}
 */
async function fetchProblemPage(page, type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=${page}`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const contextRaw = $('#lentille-context').html();

  if (!contextRaw) throw new Error('页面缺失 #lentille-context 数据');

  const json = JSON.parse(contextRaw);
  const list = json.data.problems.result || [];
  console.log(`[${type}] 第${page}页，获取题目${list.length}条`);

  return list.map(item => ({
    id: item.pid,
    difficulty: item.difficulty
  }));
}

/**
 * 完整爬取单个分类所有分页
 * @param {string} type
 */
async function updateProblemSet(type) {
  const totalPages = await fetchProblemTotal(type);
  for (let page = 1; page <= totalPages; page++) {
    const problems = await fetchProblemPage(page, type);
    if (problems.length > 0) await upsertProblems(problems);

    console.log(`${type} 爬取进度 ${page}/${totalPages}，等待随机间隔...`);
    await randomSleep();
  }
}

/**
 * 单任务单页爬取（对外API）
 * @param {string} taskId
 * @param {string} type
 * @param {number} page
 * @param {boolean} forceRefresh
 * @returns {Object}
 */
export async function crawlSinglePage(taskId, type, page, forceRefresh = false) {
  try {
    // 非强制刷新，跳过已爬页面
    if (!forceRefresh) {
      const crawled = await isPageCrawled(taskId, type, page);
      if (crawled) {
        console.log(`Task${taskId}: ${type} page${page} 已爬取，直接跳过`);

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

    // 读取/缓存该分类总页数
    let total = await getCachedPageTotal(taskId, type);
    if (!total) {
      console.log(`Task${taskId}: ${type}无缓存总页数，发起请求拉取`);
      total = await fetchProblemTotal(type);
      await updateCrawlTask(taskId, { type_page_totals: { [type]: total } });
    } else {
      console.log(`Task${taskId}: 使用缓存总页数 ${type} = ${total}`);
    }

    // 当前分页超出总分页，切换下一个分类
    if (page > total) {
      console.log(`Task${taskId}: ${type} page${page} 超出总页数${total}，切换下一类`);
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

    // 标记当前页面已爬
    await updateCrawlTask(taskId, { crawled_pages: [`${type}:${page}`] });
    const addCount = problems.length || 0;
    const nextPage = page + 1;
    const isTypeFinish = nextPage > total;

    if (isTypeFinish) {
      const nextType = getNextType(type);
      if (nextType) {
        await updateCrawlTask(taskId, {
          current_type: nextType,
          current_page: 1,
          total_pages: 0,
          $inc: { problems_crawled: addCount }
        });
        console.log(`Task${taskId}: ${type}全部完成，切换分类 ${nextType}`);
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
      console.log(`Task${taskId}: ${type} page${page} 完成，下一页${nextPage}`);
      return { success: true, completed: false, nextType: type, nextPage };
    }
  } catch (error) {
    console.error(`Task${taskId} 爬取失败 ${type} page${page}:`, error.message);
    await updateCrawlTask(taskId, { error_message: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * 一次性全量爬取所有题目分类
 * @param {boolean} clearFirst 是否先清空数据库
 */
export async function crawlAllProblems(clearFirst = false) {
  try {
    if (clearFirst) await clearProblems();
    const allTypes = getAllProblemTypes();
    for (const t of allTypes) {
      await updateProblemSet(t);
      await randomSleep();
    }
    console.log('所有分类题目爬取完成！');
  } catch (err) {
    console.error('全量爬取整体异常：', err);
    throw err;
  }
}

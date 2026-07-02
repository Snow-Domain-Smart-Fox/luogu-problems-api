import axios from 'axios';
import * as cheerio from 'cheerio';
import { upsertProblems, clearProblems } from './db.js';
import {
  updateCrawlTask,
  completeCrawlTask,
  startCrawlTask,
  getNextType,
  getAllProblemTypes,
  getCachedPageTotal,
  isPageCrawled
} from './crawl-tasks.js';

// 请求头伪装真人浏览器
const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'x-luogu-type': 'content-only',
  'x-lentille-request': 'content-only',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
};

// 基础延时
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 随机1.5~3秒休眠，降低爬虫特征
export function randomSleep() {
  const ms = 1500 + Math.floor(Math.random() * 1500);
  return sleep(ms);
}

/**
 * 带CF 403自动重试的请求封装
 */
async function fetchContent(url, retry = 0, maxRetry = 4) {
  if (retry >= maxRetry) throw new Error(`多次访问Cloudflare拦截，终止请求：${url}`);
  try {
    console.log(`[${retry}/${maxRetry}] Fetch ${url}`);
    const res = await axios.get(url, {
      headers: defaultHeaders,
      timeout: 35000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    // 403 = CF人机验证拦截，延时重试
    if (res.status === 403) {
      const wait = (retry + 1) * 3000;
      console.warn(`CF 403拦截，等待${wait}ms后重试`);
      await sleep(wait);
      return fetchContent(url, retry + 1, maxRetry);
    }
    return res;
  } catch (err) {
    // 网络错误指数退避
    const wait = Math.pow(2, retry) * 1200;
    console.error(`请求异常，等待${wait}ms重试: ${err.message}`);
    await sleep(wait);
    return fetchContent(url, retry + 1, maxRetry);
  }
}

/**
 * 获取分类总页数
 */
async function fetchProblemTotal(type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=1`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const ctx = $('#lentille-context').html();
  if (!ctx) throw new Error('页面缺失lentille-context，被CF拦截');
  const json = JSON.parse(ctx);
  const totalCnt = json.data.problems.count;
  return Math.ceil(totalCnt / 50);
}

/**
 * 单页题目列表爬取
 */
async function fetchProblemPage(page, type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=${page}`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const ctx = $('#lentille-context').html();
  if (!ctx) throw new Error('页面缺失lentille-context数据');
  const json = JSON.parse(ctx);
  const list = json.data.problems.result || [];
  return list.map(item => ({
    id: item.pid,
    difficulty: item.difficulty
  }));
}

/**
 * 完整爬取单个分类所有页面
 */
async function updateProblemSet(type) {
  const total = await fetchProblemTotal(type);
  for (let p = 1; p <= total; p++) {
    const arr = await fetchProblemPage(p, type);
    if (arr.length) await upsertProblems(arr);
    await randomSleep();
  }
}

/**
 * 单任务单页爬取对外接口（给QStash worker调用）
 */
export async function crawlSinglePage(taskId, type, page, forceRefresh = false) {
  try {
    // 跳过已爬页面
    if (!forceRefresh) {
      const crawled = await isPageCrawled(taskId, type, page);
      if (crawled) {
        let total = await getCachedPageTotal(taskId, type) || await fetchProblemTotal(type);
        const nextPage = page + 1;
        if (nextPage > total) {
          const nt = getNextType(type);
          if (nt) {
            await updateCrawlTask(taskId, { current_type: nt, current_page: 1 });
            return { success: true, completed: false, nextType: nt, nextPage: 1, skipped: true };
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
      total = await fetchProblemTotal(type);
      await updateCrawlTask(taskId, { type_page_totals: { [type]: total } });
    }

    // 当前分页超出总页数，切换下一个分类
    if (page > total) {
      const nt = getNextType(type);
      if (nt) {
        await updateCrawlTask(taskId, { current_type: nt, current_page: 1 });
        return { success: true, completed: false, nextType: nt, nextPage: 1 };
      } else {
        await completeCrawlTask(taskId);
        return { success: true, completed: true };
      }
    }

    await startCrawlTask(taskId, type, page, total);
    const list = await fetchProblemPage(page, type);
    if (list.length) await upsertProblems(list);
    await updateCrawlTask(taskId, { crawled_pages: [`${type}:${page}`] });
    const add = list.length;
    const nextPage = page + 1;

    // 判断分类是否爬完
    if (nextPage > total) {
      const nt = getNextType(type);
      if (nt) {
        await updateCrawlTask(taskId, { current_type: nt, current_page: 1, $inc: { problems_crawled: add } });
        return { success: true, completed: false, nextType: nt, nextPage: 1 };
      } else {
        await updateCrawlTask(taskId, { $inc: { problems_crawled: add } });
        await completeCrawlTask(taskId);
        return { success: true, completed: true };
      }
    } else {
      await updateCrawlTask(taskId, { current_page: nextPage, $inc: { problems_crawled: add } });
      return { success: true, completed: false, nextType: type, nextPage };
    }
  } catch (err) {
    console.error(`Task${taskId} 爬取失败 ${type}/${page}:`, err.message);
    await updateCrawlTask(taskId, { error_message: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * 一次性全量爬取所有分类
 */
export async function crawlAllProblems(clearFirst = false) {
  try {
    if (clearFirst) await clearProblems();
    const types = getAllProblemTypes();
    for (const t of types) {
      await updateProblemSet(t);
      await randomSleep();
    }
    console.log('全部分类题目爬取完成');
  } catch (err) {
    console.error('全量爬取异常：', err);
    throw err;
  }
}

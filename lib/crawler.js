import puppeteer from 'puppeteer-core';
import chrome from 'chrome-aws-lambda';
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

let browserInstance = null;
const defaultHeaders = {
  'x-luogu-type': 'content-only',
  'x-lentille-request': 'content-only'
};

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function randomSleep() {
  const ms = 1000 + Math.floor(Math.random() * 1000);
  return sleep(ms);
}

// 复用浏览器实例，减少冷启动开销
async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  const executablePath = await chrome.executablePath;
  browserInstance = await puppeteer.launch({
    executablePath,
    args: chrome.args,
    headless: chrome.headless,
    defaultViewport: chrome.defaultViewport,
    ignoreHTTPSErrors: true
  });
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

/**
 * 无头浏览器访问页面，自动等待CF验证完成，返回HTML
 */
async function fetchContent(url, retry = 0, maxRetry = 3) {
  if (retry >= maxRetry) throw new Error(`请求${url}重试${maxRetry}次仍被Cloudflare拦截`);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders(defaultHeaders);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log(`[${retry}/${maxRetry}] Visiting: ${url}`);
    // 访问页面，等待网络空闲，自动完成CF五秒验证
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    console.log(`Loaded page ok: ${url}`);
    await page.close();
    return { data: html };
  } catch (err) {
    await page.close().catch(() => {});
    console.warn(`页面访问失败，重试 ${retry+1}: ${err.message}`);
    await sleep((retry + 1) * 2000);
    return fetchContent(url, retry + 1, maxRetry);
  }
}

async function fetchProblemTotal(type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=1`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const contextRaw = $('#lentille-context').html();
  if (!contextRaw) throw new Error('页面缺失lentille-context数据');
  const json = JSON.parse(contextRaw);
  const totalCount = json.data.problems.count;
  const totalPage = Math.ceil(totalCount / 50);
  console.log(`分类 ${type} 总题数:${totalCount}, 总页数:${totalPage}`);
  return totalPage;
}

async function fetchProblemPage(page, type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=${page}`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const contextRaw = $('#lentille-context').html();
  if (!contextRaw) throw new Error('页面缺失lentille-context数据');
  const json = JSON.parse(contextRaw);
  const list = json.data.problems.result || [];
  console.log(`[${type}] page${page} 获取题目${list.length}条`);
  return list.map(item => ({
    id: item.pid,
    difficulty: item.difficulty
  }));
}

async function updateProblemSet(type) {
  const totalPages = await fetchProblemTotal(type);
  for (let page = 1; page <= totalPages; page++) {
    const problems = await fetchProblemPage(page, type);
    if (problems.length > 0) await upsertProblems(problems);
    console.log(`${type} 进度 ${page}/${totalPages}`);
    await randomSleep();
  }
}

export async function crawlSinglePage(taskId, type, page, forceRefresh = false) {
  try {
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

    let total = await getCachedPageTotal(taskId, type);
    if (!total) {
      console.log(`Task${taskId}: 拉取${type}总页数`);
      total = await fetchProblemTotal(type);
      await updateCrawlTask(taskId, { type_page_totals: { [type]: total } });
    }

    if (page > total) {
      console.log(`Task${taskId}: ${type}分页超出，切换下一类`);
      const nextType = getNextType(type);
      if (nextType) {
        await updateCrawlTask(taskId, { current_type: nextType, current_page: 1 });
        return { success: true, completed: false, nextType, nextPage: 1 };
      } else {
        await completeCrawlTask(taskId);
        return { success: true, completed: true };
      }
    }

    await startCrawlTask(taskId, type, page, total);
    const problems = await fetchProblemPage(page, type);
    if (problems.length) await upsertProblems(problems);
    await updateCrawlTask(taskId, { crawled_pages: [`${type}:${page}`] });
    const addCount = problems.length || 0;
    const nextPage = page + 1;
    const typeFinished = nextPage > total;

    if (typeFinished) {
      const nextType = getNextType(type);
      if (nextType) {
        await updateCrawlTask(taskId, {
          current_type: nextType,
          current_page: 1,
          $inc: { problems_crawled: addCount }
        });
        return { success: true, completed: false, nextType, nextPage: 1 };
      } else {
        await updateCrawlTask(taskId, { $inc: { problems_crawled: addCount } });
        await completeCrawlTask(taskId);
        return { success: true, completed: true };
      }
    } else {
      await updateCrawlTask(taskId, {
        current_page: nextPage,
        $inc: { problems_crawled: addCount }
      });
      return { success: true, completed: false, nextType: type, nextPage };
    }
  } catch (error) {
    console.error(`Task${taskId}爬取失败 ${type}/${page}:`, error.message);
    await updateCrawlTask(taskId, { error_message: error.message });
    return { success: false, error: error.message };
  }
}

export async function crawlAllProblems(clearFirst = false) {
  try {
    if (clearFirst) await clearProblems();
    const allTypes = getAllProblemTypes();
    for (const t of allTypes) {
      await updateProblemSet(t);
      await randomSleep();
    }
    console.log('全部题目爬取完成');
  } catch (err) {
    console.error('全量爬取异常:', err);
    throw err;
  } finally {
    await closeBrowser();
  }
}

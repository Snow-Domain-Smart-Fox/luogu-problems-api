import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
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

async function getBrowser() {
  if (browserInstance && browserInstance.connected) return browserInstance;
  const isVercel = !!process.env.VERCEL;
  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process'
  ];
  const launchOptions = {
    ignoreHTTPSErrors: true,
    args: launchArgs
  };
  if (isVercel) {
    launchOptions.executablePath = await chromium.executablePath();
    launchOptions.args = [...chromium.args, ...launchArgs];
    launchOptions.headless = chromium.headless;
    launchOptions.defaultViewport = chromium.defaultViewport;
  } else {
    launchOptions.headless = true;
  }
  browserInstance = await puppeteer.launch(launchOptions);
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

async function fetchContent(url, retry = 0, maxRetry = 3) {
  if (retry >= maxRetry) throw new Error(`请求${url}重试${maxRetry}次被CF拦截`);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setExtraHTTPHeaders(defaultHeaders);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
    console.log(`[${retry}/${maxRetry}] Visit ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('#lentille-context', { timeout: 8000 });
    const html = await page.content();
    await page.close();
    return { data: html };
  } catch (err) {
    await page.close().catch(() => {});
    await sleep((retry + 1) * 2000);
    return fetchContent(url, retry + 1, maxRetry);
  }
}

async function fetchProblemTotal(type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=1`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const ctx = $('#lentille-context').html();
  if (!ctx) throw new Error('Missing lentille-context');
  const data = JSON.parse(ctx);
  const total = data.data.problems.count;
  return Math.ceil(total / 50);
}

async function fetchProblemPage(page, type) {
  const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=${page}`;
  const html = (await fetchContent(url)).data;
  const $ = cheerio.load(html);
  const ctx = $('#lentille-context').html();
  if (!ctx) throw new Error('Missing lentille-context');
  const data = JSON.parse(ctx);
  const list = data.data.problems.result || [];
  return list.map(item => ({
    id: item.pid,
    difficulty: item.difficulty
  }));
}

async function updateProblemSet(type) {
  const total = await fetchProblemTotal(type);
  for (let p = 1; p <= total; p++) {
    const arr = await fetchProblemPage(p, type);
    if (arr.length) await upsertProblems(arr);
    await randomSleep();
  }
}

export async function crawlSinglePage(taskId, type, page, forceRefresh = false) {
  try {
    if (!forceRefresh) {
      const crawled = await isPageCrawled(taskId, type, page);
      if (crawled) {
        let total = await getCachedPageTotal(taskId, type);
        if (!total) {
          total = await fetchProblemTotal(type);
          await updateCrawlTask(taskId, { type_page_totals: { [type]: total } });
        }
        const next = page + 1;
        if (next > total) {
          const nt = getNextType(type);
          if (nt) {
            await updateCrawlTask(taskId, { current_type: nt, current_page: 1 });
            return { success: true, completed: false, nextType: nt, nextPage: 1, skipped: true };
          } else {
            await completeCrawlTask(taskId);
            return { success: true, completed: true, skipped: true };
          }
        }
        await updateCrawlTask(taskId, { current_page: next });
        return { success: true, completed: false, nextType: type, nextPage: next, skipped: true };
      }
    }
    let total = await getCachedPageTotal(taskId, type);
    if (!total) {
      total = await fetchProblemTotal(type);
      await updateCrawlTask(taskId, { type_page_totals: { [type]: total } });
    }
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
    const next = page + 1;
    if (next > total) {
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
      await updateCrawlTask(taskId, { current_page: next, $inc: { problems_crawled: add } });
      return { success: true, completed: false, nextType: type, nextPage: next };
    }
  } catch (e) {
    await updateCrawlTask(taskId, { error_message: e.message });
    return { success: false, error: e.message };
  }
}

export async function crawlAllProblems(clearFirst = false) {
  try {
    if (clearFirst) await clearProblems();
    const types = getAllProblemTypes();
    for (const t of types) {
      await updateProblemSet(t);
      await randomSleep();
    }
  } catch (e) {
    console.error(e);
    throw e;
  } finally {
    await closeBrowser();
  }
}

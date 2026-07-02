// 主要改动：移除 axios，fetchContent 直接使用浏览器渲染（fetchWithBrowser）并实现 retry/backoff

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

// Supabase client (用于在本文件内实现 problems_crawled 的展开更新，避免发送 $inc)
import { createClient } from '@supabase/supabase-js';
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// 使用 playwright-core + @sparticuz/chromium 以适配 serverless 环境或远端浏览器
import { chromium as chromiumCore } from 'playwright-core';
import chromiumBinary from '@sparticuz/chromium';

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
 * Helper: 在本文件内对 problems_crawled 做 read->update（展开 $inc）
 */
async function incrementProblemsCrawled(taskId, delta = 0) {
  try {
    const { data: row, error: selErr } = await supabase
      .from('crawl_tasks')
      .select('problems_crawled')
      .eq('id', taskId)
      .single();

    if (selErr) {
      console.warn('incrementProblemsCrawled: select error', selErr);
      const { error: fallbackErr } = await supabase
        .from('crawl_tasks')
        .update({ problems_crawled: delta })
        .eq('id', taskId);
      if (fallbackErr) console.error('incrementProblemsCrawled fallback update error', fallbackErr);
      return;
    }

    const current = (row && typeof row.problems_crawled !== 'undefined') ? Number(row.problems_crawled) : 0;
    const newVal = current + Number(delta || 0);

    const { error: updErr } = await supabase
      .from('crawl_tasks')
      .update({ problems_crawled: newVal, updated_at: new Date().toISOString() })
      .eq('id', taskId);

    if (updErr) {
      console.error('incrementProblemsCrawled update error', updErr);
    }
  } catch (err) {
    console.error('incrementProblemsCrawled unexpected error', err);
  }
}

/**
 * 浏览器单例（支持远端 connect 与本地 sparticuz 二进制）
 */
let _browser = null;
let _browserLaunching = null;

async function getBrowser() {
  const wsEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;
  if (wsEndpoint) {
    try {
      if (!_browser) {
        console.log('Connecting to remote browser via PLAYWRIGHT_WS_ENDPOINT');
        _browser = await chromiumCore.connect({ wsEndpoint });
        _browser.on && _browser.on('disconnected', () => {
          console.warn('Remote browser disconnected. Clearing browser instance.');
          _browser = null;
          _browserLaunching = null;
        });
        console.log('Connected to remote browser');
      }
      return _browser;
    } catch (err) {
      console.error('Failed to connect to remote browser:', err && err.message ? err.message : err);
      _browser = null;
      throw err;
    }
  }

  if (_browser) return _browser;
  if (_browserLaunching) return _browserLaunching;

  _browserLaunching = (async () => {
    try {
      const executablePath = await chromiumBinary.executablePath();
      const args = chromiumBinary.args || ['--no-sandbox', '--disable-dev-shm-usage'];
      console.log('Launching chromium via @sparticuz/chromium executablePath:', executablePath);
      const browser = await chromiumCore.launch({
        executablePath,
        args,
        headless: true,
      });
      _browser = browser;
      _browser.on && _browser.on('disconnected', () => {
        console.warn('Local chromium process disconnected. Clearing browser instance.');
        _browser = null;
        _browserLaunching = null;
      });
      _browserLaunching = null;
      console.log('Chromium launched (sparticuz)');
      await sleep(300);
      return _browser;
    } catch (err) {
      _browser = null;
      _browserLaunching = null;
      if (err && err.message && err.message.includes('Executable')) {
        err.message += '\nPlaywright binary issue. If running locally, run: npx playwright install chromium\nIf running in serverless, consider using PLAYWRIGHT_WS_ENDPOINT (remote browser)';
      }
      throw err;
    }
  })();

  return _browserLaunching;
}

/**
 * 使用浏览器渲染并返回 HTML（兼容原来 axios 返回结构）
 */
async function fetchWithBrowser(url, options = {}, _retried = false) {
  const timeout = options.timeout || 35000;
  try {
    const browser = await getBrowser();

    let context, page;
    try {
      context = await browser.newContext({
        userAgent: defaultHeaders['User-Agent'],
        locale: 'zh-CN'
      });
      page = await context.newPage();
    } catch (ctxErr) {
      const msg = (ctxErr && ctxErr.message) ? ctxErr.message : String(ctxErr);
      console.warn('Failed to create context/page:', msg);

      if (!_retried) {
        console.warn('Attempting to clear browser instance and retry creating a new browser (one retry).');
        try {
          _browser = null;
          _browserLaunching = null;
          const freshBrowser = await getBrowser();
          context = await freshBrowser.newContext({
            userAgent: defaultHeaders['User-Agent'],
            locale: 'zh-CN'
          });
          page = await context.newPage();
        } catch (retryErr) {
          console.error('Retry to create context/page failed:', retryErr && retryErr.message ? retryErr.message : retryErr);
          throw retryErr;
        }
      } else {
        throw ctxErr;
      }
    }

    // 阻止图片/样式/字体/媒体等资源以节省内存与带宽
    await page.route('**/*', (route) => {
      const rt = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(rt)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.setExtraHTTPHeaders({
      'Accept-Language': defaultHeaders['Accept-Language'],
      'Accept': defaultHeaders['Accept']
    });

    await page.goto(url, { waitUntil: 'networkidle', timeout });

    try {
      await page.waitForSelector('#lentille-context', { timeout: 8000 });
    } catch (e) {
      // 继续，即使没有找到也返回渲染后的 HTML
    }

    const content = await page.content();

    await page.close();
    await context.close();

    return {
      status: 200,
      headers: {},
      data: content
    };
  } catch (err) {
    console.error('fetchWithBrowser error:', err && err.message ? err.message : err);
    _browser = null;
    _browserLaunching = null;
    if (!_retried) {
      await sleep(500);
      return fetchWithBrowser(url, options, true);
    }
    throw err;
  }
}

/**
 * 现在直接使用浏览器抓取内容（不再使用 axios）
 * 内置重试/backoff
 */
async function fetchContent(url, retry = 0, maxRetry = 6) {
  if (retry >= maxRetry) throw new Error(`多次访问被拦截或失败，终止请求：${url}`);
  try {
    console.log(`[${retry}/${maxRetry}] Fetch ${url} via browser`);
    const res = await fetchWithBrowser(url, { timeout: 35000 });
    const body = res.data && typeof res.data === 'string' ? res.data : '';

    if (!body.includes('lentille-context') && !body.includes('#lentille-context')) {
      const wait = Math.min((retry + 1) * 3000, 30000);
      console.warn(`页面缺失 lentille-context（可能被 Cloudflare）或未正确渲染，等待 ${wait}ms 后重试（retry=${retry})`);
      await sleep(wait);
      return fetchContent(url, retry + 1, maxRetry);
    }

    return res;
  } catch (err) {
    const wait = Math.min(Math.pow(2, retry) * 1200, 30000);
    console.error(`fetchContent 异常，等待 ${wait}ms 重试: ${err && err.message ? err.message : err}`);
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
  if (!ctx) throw new Error('页面缺失lentille-context，被CF拦截或解析失败');
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

    // 使用 helper 更新 crawled_pages 与 problems_crawled（避免 $inc）
    await updateCrawlTask(taskId, { crawled_pages: [`${type}:${page}`] });
    const add = list.length;
    const nextPage = page + 1;

    // 判断分类是否爬完
    if (nextPage > total) {
      const nt = getNextType(type);
      if (nt) {
        await updateCrawlTask(taskId, { current_type: nt, current_page: 1 });
        await incrementProblemsCrawled(taskId, add);
        return { success: true, completed: false, nextType: nt, nextPage: 1 };
      } else {
        await incrementProblemsCrawled(taskId, add);
        await completeCrawlTask(taskId);
        return { success: true, completed: true };
      }
    } else {
      await incrementProblemsCrawled(taskId, add);
      await updateCrawlTask(taskId, { current_page: nextPage });
      return { success: true, completed: false, nextType: type, nextPage };
    }
  } catch (err) {
    console.error(`Task${taskId} 爬取失败 ${type}/${page}:`, err && err.message ? err.message : err);
    await updateCrawlTask(taskId, { error_message: err && err.message ? err.message : String(err) });
    return { success: false, error: err && err.message ? err.message : String(err) };
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

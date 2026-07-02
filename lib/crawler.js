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

// Playwright 用于处理需要 JS 渲染 / Cloudflare 正常人机校验的回退
import { chromium } from 'playwright';

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
 * Playwright 单例浏览器
 * - 保持 browser 实例以避免频繁启动
 * - 在需要时创建新的 context / page 并在完成后关闭它们
 */
let _browserPromise = null;
async function getBrowser() {
  if (!_browserPromise) {
    _browserPromise = chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    }).catch(err => {
      // 如果启动失败，清理 promise 以便后续重试
      _browserPromise = null;
      throw err;
    });
  }
  return _browserPromise;
}

/**
 * 使用 Playwright 抓取并返回 HTML 内容
 * - 尽量复用 browser 实例
 * - 返回对象结构与 axios.get 的返回兼容：{ status, headers, data }
 */
async function fetchWithBrowser(url, options = {}) {
  const timeout = options.timeout || 35000;
  const headless = options.headless !== undefined ? options.headless : true;
  let browser;
  try {
    browser = await getBrowser();
    const context = await (await browser).newContext({
      userAgent: defaultHeaders['User-Agent'],
      locale: 'zh-CN'
    });
    const page = await context.newPage();

    await page.setExtraHTTPHeaders({
      'Accept-Language': defaultHeaders['Accept-Language'],
      'Accept': defaultHeaders['Accept']
    });

    // 导航并等待 networkidle，以尽量确保 JS 执行完成
    await page.goto(url, { waitUntil: 'networkidle', timeout });

    // 等待 lentille-context 出现（如果页面使用该元素承载数据）
    try {
      await page.waitForSelector('#lentille-context', { timeout: 10000 });
    } catch (e) {
      // 继续，可能页面以不同方式渲染数据
    }

    const content = await page.content();

    // 取 response headers（可选，从最后一个请求提取）
    let respHeaders = {};
    try {
      const responses = page.context()._existingPages?.() || [];
      // 上述 internal API 仅为示意：Playwright 并没有直接返回整套 headers 的简单方法
      // 如果需要 headers，可以在 page.route 或 page.on('response') 时捕获
    } catch (e) {
      // ignore
    }

    await page.close();
    await context.close();

    return {
      status: 200,
      headers: respHeaders,
      data: content
    };
  } catch (err) {
    // 在启动或抓取出现异常时，不关闭全局 browser（由 getBrowser 管理），但如果需要可以手动关闭
    // 若 browser 实例已损坏，则清除单例，下一次尝试会重建
    _browserPromise = null;
    throw err;
  }
}

/**
 * 带 CF 403 / JS challenge 回退浏览器抓取的请求封装
 * - 优先使用 axios（轻量）
 * - 遇到 403 或解析不到 #lentille-context 时使用浏览器回退
 * - 内置指数退避与重试
 */
async function fetchContent(url, retry = 0, maxRetry = 4) {
  if (retry >= maxRetry) throw new Error(`多次访问被拦截或失败，终止请求：${url}`);
  try {
    console.log(`[${retry}/${maxRetry}] Fetch ${url} via axios`);
    const res = await axios.get(url, {
      headers: defaultHeaders,
      timeout: 35000,
      maxRedirects: 5,
      validateStatus: () => true,
    });

    // 403 = 可能被 Cloudflare 阻断（显示验证页面）
    if (res.status === 403) {
      console.warn(`HTTP 403 - 可能是 Cloudflare 校验页面，尝试浏览器渲染回退抓取（retry=${retry})`);
      try {
        const browserRes = await fetchWithBrowser(url);
        return browserRes;
      } catch (err) {
        const wait = (retry + 1) * 3000;
        console.warn(`浏览器回退失败，等待 ${wait}ms 后重试 axios：${err.message}`);
        await sleep(wait);
        return fetchContent(url, retry + 1, maxRetry);
      }
    }

    // res.data 可能不是字符串（axios 在某些情况下），确保是字符串
    const body = res.data && typeof res.data === 'string' ? res.data : '';

    // 如果返回页面缺少关键 #lentille-context，可能仍是 Cloudflare 的 challenge（JS 未执行）
    if (!body.includes('lentille-context') && !body.includes('#lentille-context')) {
      console.warn('页面缺失 lentille-context，可能被 Cloudflare JS 校验或页面未被正常渲染，尝试浏览器回退抓取');
      try {
        const browserRes = await fetchWithBrowser(url);
        if (browserRes.data && browserRes.data.includes('lentille-context')) {
          return browserRes;
        } else {
          const wait = (retry + 1) * 3000;
          console.warn(`浏览器抓取也未取得 lentille-context，等待 ${wait}ms 后重试 axios`);
          await sleep(wait);
          return fetchContent(url, retry + 1, maxRetry);
        }
      } catch (err) {
        const wait = (retry + 1) * 3000;
        console.warn(`浏览器回退抓取失败：${err.message}，等待 ${wait}ms 后重试 axios`);
        await sleep(wait);
        return fetchContent(url, retry + 1, maxRetry);
      }
    }

    return res;
  } catch (err) {
    const wait = Math.min(Math.pow(2, retry) * 1200, 30000);
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

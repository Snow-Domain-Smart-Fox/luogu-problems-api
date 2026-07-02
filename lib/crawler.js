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
 * 浏览器单例（支持远端 connect 与本地 sparticuz 二进制）
 */
let _browser = null;
let _browserLaunching = null;

async function getBrowser() {
  // 优先使用远端浏览器（Playwright Cloud / Browserless / ZenRows 等）
  const wsEndpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;
  if (wsEndpoint) {
    try {
      if (!_browser) {
        console.log('Connecting to remote browser via PLAYWRIGHT_WS_ENDPOINT');
        _browser = await chromiumCore.connect({ wsEndpoint });
        console.log('Connected to remote browser');
      }
      return _browser;
    } catch (err) {
      console.error('Failed to connect to remote browser:', err.message);
      // 允许后续回退到本地 sparticuz
      _browser = null;
      throw err;
    }
  }

  // 否则使用 @sparticuz/chromium（适配 serverless）
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
      _browserLaunching = null;
      console.log('Chromium launched (sparticuz)');
      return _browser;
    } catch (err) {
      // 清理单例以便后续重试或切换策略
      _browser = null;
      _browserLaunching = null;

      // 更友好的提示（常见错误：二进制不存在或不兼容）
      if (err && err.message && err.message.includes('Executable')) {
        err.message += '\nPlaywright binary issue. If running locally, run: npx playwright install chromium\nIf running in serverless, consider using PLAYWRIGHT_WS_ENDPOINT (remote browser) or ensure @sparticuz/chromium is installed correctly.';
      }
      throw err;
    }
  })();

  return _browserLaunching;
}

/**
 * 使用浏览器渲染并返回 HTML（兼容 axios.get 返回结构）
 */
async function fetchWithBrowser(url, options = {}) {
  const timeout = options.timeout || 35000;
  try {
    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent: defaultHeaders['User-Agent'],
      locale: 'zh-CN'
    });
    const page = await context.newPage();

    // 降低内存/带宽：阻止图片/样式/字体/媒体等非必要资源
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

    // 导航并等待 networkidle
    await page.goto(url, { waitUntil: 'networkidle', timeout });

    // 尝试等待 lentille-context 出现（如果页面使用该元素承载数据）
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
    // 若本地二进制损坏或启动失败，清理单例以便后续重试或切换到远端
    console.error('fetchWithBrowser error:', err.message);
    _browser = null;
    _browserLaunching = null;
    throw err;
  }
}

/**
 * 带 CF 403 / JS challenge 回退浏览器抓取的请求封装
 * - 优先使用 axios（轻量）
 * - 遇到 403 或页面未渲染出 #lentille-context 时回退到浏览器渲染
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

    // res.data 可能不是字符串，确保是字符串
    const body = res.data && typeof res.data === 'string' ? res.data : '';

    // 如果返回页面缺少关键 #lentille-context，可能是 CF JS challenge（JS 未执行）
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

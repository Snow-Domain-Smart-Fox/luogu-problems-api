import axios from 'axios';
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

const defaultHeaders = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/98.0.4758.102 Safari/537.36',
  'x-luogu-type': 'content-only'
};

const frontendFetchConfig = {
  maxRedirects: 0,
  validateStatus: () => true,
  timeout: 30000
};

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchContent(url, headers = {}) {
  console.log(`Fetching: ${url}`);
  const h = { ...defaultHeaders, ...headers };
  
  let resp;
  try {
    resp = await axios.get(url, {
      ...frontendFetchConfig,
      headers: h
    });
  } catch (err) {
    console.error(`Network request failed: ${err.message || err.code}`);
    throw err;
  }
  
  if (resp.status === 302 && resp.headers.location) {
    const setCookie = resp.headers['set-cookie'];
    if (setCookie) {
      const cookies = setCookie.map(c => c.split(';')[0]).join('; ');
      h.Cookie = cookies;
    }
    try {
      resp = await axios.get(url, {
        ...frontendFetchConfig,
        headers: h
      });
    } catch (err) {
      console.error(`Network request failed: ${err.message || err.code}`);
      throw err;
    }
  }
  
  console.log(`Fetched: ${url}, status: ${resp.status}`);
  return resp;
}

async function fetchProblemTotal(type, retry = 0) {
  if (retry >= 3) return 0;
  
  if (retry > 0) await sleep(1000 * retry);
  
  try {
    const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=1`;
    const html = (await fetchContent(url)).data;
    const $ = cheerio.load(html);
    const json = JSON.parse($('#lentille-context').html());
    const total = json.data.problems.count;
    console.log(`${type} total problems: ${total}`);
    return Math.ceil(total / 50);
  } catch (e) {
    console.log(`Error fetching total pages for ${type} (attempt ${retry + 1}): ${e.message}`);
    return fetchProblemTotal(type, retry + 1);
  }
}

async function fetchProblemPage(page, type, retry = 0) {
  if (retry >= 3) return [];
  
  if (retry > 0) await sleep(1000 * retry);
  
  try {
    const url = `https://www.luogu.com.cn/problem/list?type=${type}&page=${page}`;
    const html = (await fetchContent(url)).data;
    const $ = cheerio.load(html);
    const json = JSON.parse($('#lentille-context').html());
    console.log(`Fetched ${type} page ${page}, found ${json.data.problems.result.length} problems`);
    return json.data.problems.result.map(i => ({
      id: i.pid,
      difficulty: i.difficulty,
    }));
  } catch (e) {
    console.log(`Error fetching ${type} page ${page} (attempt ${retry + 1}): ${e.message}`);
    return fetchProblemPage(page, type, retry + 1);
  }
}

async function updateProblemSet(type) {
  const total = await fetchProblemTotal(type);
  
  for (let page = 1; page <= total; page++) {
    const problems = await fetchProblemPage(page, type);
    
    if (problems.length > 0) {
      await upsertProblems(problems);
    }
    
    console.log(`${type} crawled ${page}/${total}, waiting 0.5 seconds...`);
    await sleep(500);
  }
}

export async function crawlSinglePage(taskId, type, page, forceRefresh = false) {
  try {
    // 检查是否已爬取（除非强制刷新）
    if (!forceRefresh) {
      const alreadyCrawled = await isPageCrawled(taskId, type, page);
      if (alreadyCrawled) {
        console.log(`Task ${taskId}: ${type} page ${page} already crawled, skipping`);
        
        // 获取总页数（使用缓存）
        let total = await getCachedPageTotal(taskId, type);
        if (!total) {
          total = await fetchProblemTotal(type);
          await updateCrawlTask(taskId, {
            type_page_totals: { [type]: total }
          });
        }
        
        const nextPage = page + 1;
        if (nextPage > total) {
          const nextType = getNextType(type);
          if (nextType) {
            await updateCrawlTask(taskId, {
              current_type: nextType,
              current_page: 1
            });
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
    
    // 获取总页数（优先使用缓存）
    let total = await getCachedPageTotal(taskId, type);
    if (!total) {
      console.log(`Task ${taskId}: Cache miss for ${type} total pages, fetching...`);
      total = await fetchProblemTotal(type);
      await updateCrawlTask(taskId, {
        type_page_totals: { [type]: total }
      });
      console.log(`Task ${taskId}: Cached total pages for ${type}: ${total}`);
    } else {
      console.log(`Task ${taskId}: Using cached total pages for ${type}: ${total}`);
    }
    
    if (page > total) {
      console.log(`Task ${taskId}: ${type} page ${page} exceeds total ${total}, moving to next type`);
      const nextType = getNextType(type);
      if (nextType) {
        await updateCrawlTask(taskId, {
          current_type: nextType,
          current_page: 1,
          total_pages: 0
        });
        return { success: true, completed: false, nextType, nextPage: 1 };
      } else {
        await completeCrawlTask(taskId);
        return { success: true, completed: true };
      }
    }
    
    await startCrawlTask(taskId, type, page, total);
    
    const problems = await fetchProblemPage(page, type);
    
    if (problems.length > 0) {
      await upsertProblems(problems);
    }
    
    // 记录已爬取的页面
    await updateCrawlTask(taskId, {
      crawled_pages: [`${type}:${page}`]
    });
    
    const nextPage = page + 1;
    const shouldMoveToNextType = nextPage > total;
    
    if (shouldMoveToNextType) {
      const nextType = getNextType(type);
      if (nextType) {
        await updateCrawlTask(taskId, {
          current_type: nextType,
          current_page: 1,
          total_pages: 0,
          problems_crawled: (await updateCrawlTask(taskId, {})).problems_crawled + problems.length
        });
        console.log(`Task ${taskId}: Completed ${type}, moving to ${nextType}`);
        return { success: true, completed: false, nextType, nextPage: 1 };
      } else {
        await updateCrawlTask(taskId, {
          problems_crawled: (await updateCrawlTask(taskId, {})).problems_crawled + problems.length
        });
        await completeCrawlTask(taskId);
        console.log(`Task ${taskId}: All types completed!`);
        return { success: true, completed: true };
      }
    } else {
      await updateCrawlTask(taskId, {
        current_page: nextPage,
        problems_crawled: (await updateCrawlTask(taskId, {})).problems_crawled + problems.length
      });
      console.log(`Task ${taskId}: Completed ${type} page ${page}, next is page ${nextPage}`);
      return { success: true, completed: false, nextType: type, nextPage };
    }
  } catch (error) {
    console.error(`Task ${taskId}: Error crawling ${type} page ${page}:`, error);
    // 失败时不更新状态，保持 pending/running 状态，这样下次会继续处理当前页面
    // 只在任务中记录错误信息
    await updateCrawlTask(taskId, {
      error_message: error.message
    });
    return { success: false, error: error.message };
  }
}

export async function crawlAllProblems(clearFirst = false) {
  try {
    if (clearFirst) {
      await clearProblems();
    }
    
    const types = getAllProblemTypes();
    for (const type of types) {
      await updateProblemSet(type);
    }
    
    console.log('All problems crawled successfully!');
  } catch (error) {
    console.error('Error during crawl:', error);
    throw error;
  }
}

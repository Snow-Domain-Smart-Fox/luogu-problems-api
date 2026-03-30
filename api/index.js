export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'public, s-maxage=2678400, stale-while-revalidate=2678400');
  response.status(200).json({
    message: 'Luogu Problems API',
    description: 'Programming problems API with auto-resume crawl capability',
    endpoints: {
      'GET /api/all': 'Get all problems',
      'GET /api/crawl-status': 'Get crawl progress and status',
      'GET /api/cron': 'Start/reset crawl job (Cron only)',
      'GET /api/crawl-page': 'Crawl single page (Cron auto-trigger)',
      'GET /api/health': 'Health check'
    },
    features: [
      'Auto-resume on timeout',
      'Page-by-page crawling',
      'Progress tracking',
      'No duplicate crawling'
    ]
  });
}

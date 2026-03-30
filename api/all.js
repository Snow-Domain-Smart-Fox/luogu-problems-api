import { getAllProblems } from '../lib/db.js';

export default async function handler(request, response) {
  try {
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }
    
    const problems = await getAllProblems();
    
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'public, s-maxage=2678400, stale-while-revalidate=2678400');
    response.setHeader('X-Cache-Status', 'HIT');
    response.end(JSON.stringify(problems));
  } catch (error) {
    console.error('Error in /api/all:', error);
    response.statusCode = 500;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: 'Internal server error' }));
  }
}

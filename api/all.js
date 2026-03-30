import { getAllProblems } from '../lib/db.js';

export default async function handler(request, response) {
  try {
    if (request.method !== 'GET') {
      return response.status(405).json({ error: 'Method not allowed' });
    }
    
    const problems = await getAllProblems();
    response.setHeader('Cache-Control', 'public, s-maxage=2678400, stale-while-revalidate');
    return response.status(200).json(problems);
  } catch (error) {
    console.error('Error in /api/all:', error);
    return response.status(500).json({ error: 'Internal server error' });
  }
}

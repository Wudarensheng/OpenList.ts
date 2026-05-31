import { Env } from '../types';

export async function handleStaticFile(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  let path = url.pathname;

  // Try to fetch from ASSETS binding
  if (env.ASSETS) {
    try {
      // First try to get the exact file
      const response = await env.ASSETS.fetch(request);
      if (response.status === 200) {
        return response;
      }
      
      // If not found, serve index.html for SPA routing (all paths without file extensions)
      if (!path.includes('.') || path === '/') {
        const indexUrl = new URL('/index.html', request.url);
        const indexResponse = await env.ASSETS.fetch(new Request(indexUrl.toString(), {
          method: 'GET',
          headers: request.headers,
        }));
        if (indexResponse.status === 200) {
          return new Response(indexResponse.body, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-cache',
            },
          });
        }
      }
    } catch (e) {
      console.error('ASSETS fetch error:', e);
    }
  }

  return new Response('Not Found', { status: 404 });
}

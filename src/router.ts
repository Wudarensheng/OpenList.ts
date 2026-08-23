import { Env } from './types';
import { handleApiRequest } from './routes/api';
import { handleStaticFile } from './routes/static';
import { handleDownloadRequest } from './routes/download';

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  }

  // Handle API requests
  if (path.startsWith('/api/')) {
    return handleApiRequest(request, env);
  }

  // Handle manifest.json
  if (path === '/manifest.json') {
    return handleManifest();
  }

  // Handle direct link / proxy download routes (/d/<path>, /p/<path>)
  if (path.startsWith('/d/') || path.startsWith('/p/')) {
    return handleDownloadRequest(request, env);
  }

  // Handle static files
  return handleStaticFile(request, env);
}

function handleManifest(): Response {
  return new Response(JSON.stringify({
    name: 'OpenList',
    short_name: 'OpenList',
    description: 'A file list program',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1890ff',
    icons: [
      {
        src: 'https://res.oplist.org/logo/logo.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: 'https://res.oplist.org/logo/logo.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

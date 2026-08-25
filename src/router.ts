import { Env } from './types';
import { handleApiRequest } from './routes/api';
import { handleStaticFile } from './routes/static';
import { handleDownloadRequest } from './routes/download';
import { handleShareDownload } from './routes/share';

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

  // Handle share download routes (/sd/<sid>/<path>)
  if (path.startsWith('/sd/')) {
    return handleShareDownload(request, env);
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
        src: '/images/logo.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: '/images/logo.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}

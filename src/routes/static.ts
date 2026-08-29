import { AssetProvider, Env } from '../types';

// Try an asset provider, applying the SPA fallback (serve index.html for
// extension-less paths) exactly like the original ASSETS flow.
async function tryProvider(provider: AssetProvider, request: Request): Promise<Response | null> {
  try {
    const response = await provider.fetch(request);
    if (response && response.status === 200) {
      return response;
    }

    const url = new URL(request.url);
    if (!url.pathname.includes('.') || url.pathname === '/') {
      const indexUrl = new URL('/index.html', request.url);
      const indexResponse = await provider.fetch(
        new Request(indexUrl.toString(), {
          method: 'GET',
          headers: request.headers,
        })
      );
      if (indexResponse && indexResponse.status === 200) {
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
    console.error('Asset provider error:', e);
  }
  return null;
}

// Wrap an external static-server base URL with the standard fetch API.
function externalAssets(baseUrl: string): AssetProvider {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      return fetch(base + url.pathname, {
        method: 'GET',
        headers: { Accept: request.headers.get('Accept') || '*/*' },
      });
    },
  };
}

export async function handleStaticFile(request: Request, env: Env): Promise<Response> {
  // 1. Cloudflare ASSETS binding (Workers platform)
  if (env.ASSETS) {
    const res = await tryProvider(env.ASSETS, request);
    if (res) return res;
  }

  // 2. External static server (cross-cloud, plain standard fetch)
  if (env.STATIC_BASE) {
    const res = await tryProvider(externalAssets(env.STATIC_BASE), request);
    if (res) return res;
  }

  // 3. Local file provider injected by the cross-platform entry (src/server.ts)
  if (env.LOCAL_STATIC) {
    const res = await tryProvider(env.LOCAL_STATIC, request);
    if (res) return res;
  }

  return new Response('Not Found', { status: 404 });
}

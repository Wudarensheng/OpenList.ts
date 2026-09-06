export function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store', // dynamic API data must never be edge-cached
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}

// Headers for file-stream endpoints that are fetched by cross-origin in-app
// viewers (pdf.js at res.oplist.org.cn etc.). pdf.js issues ranged GETs, so
// the Range request header (and the Content-Range response header) must be
// allowed/exposed through CORS.
export const STREAM_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition',
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: STREAM_CORS_HEADERS });
}

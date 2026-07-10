import { Env } from '../types';
import { getDriverNames, getDriverInfoMap, getDriverInfo } from '../drivers/registry';
import { jsonResponse } from '../utils/response';

export async function handleDriverRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // GET /api/admin/driver/names
  if (path === '/api/admin/driver/names' && request.method === 'GET') {
    return jsonResponse({
      code: 200,
      message: 'success',
      data: await getDriverNames()
    });
  }

  // GET /api/admin/driver/list - returns Record<string, DriverInfo>
  if (path === '/api/admin/driver/list' && request.method === 'GET') {
    return jsonResponse({
      code: 200,
      message: 'success',
      data: await getDriverInfoMap()
    });
  }

  // GET /api/admin/driver/info?driver=xxx
  if (path === '/api/admin/driver/info' && request.method === 'GET') {
    const driverName = url.searchParams.get('driver') || url.searchParams.get('name');
    if (!driverName) {
      return jsonResponse({ code: 400, message: 'Driver name is required' }, 400);
    }

    const info = await getDriverInfo(driverName);
    if (!info) {
      return jsonResponse({ code: 404, message: `driver [${driverName}] not found` }, 404);
    }

    return jsonResponse({
      code: 200,
      message: 'success',
      data: info
    });
  }

  return jsonResponse({ code: 404, message: 'Not Found' }, 404);
}



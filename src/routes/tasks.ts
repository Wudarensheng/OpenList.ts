import { Env } from '../types';

// Task state constants matching tache library
const TaskState = {
  Pending: 0,
  Running: 1,
  Canceling: 2,
  Canceled: 3,
  Errored: 4,
  Failing: 5,
  Failed: 6,
  Succeeded: 7,
  WaitingRetry: 8,
  BeforeRetry: 9
};

export async function handleTaskRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // GET /api/task/{type}/undone
  if (path.includes('/undone')) {
    return jsonResponse({
      code: 200,
      message: 'success',
      data: []
    });
  }

  // GET /api/task/{type}/done
  if (path.includes('/done')) {
    return jsonResponse({
      code: 200,
      message: 'success',
      data: []
    });
  }

  // POST /api/task/{type}/info
  if (path.includes('/info')) {
    const tid = url.searchParams.get('tid');
    if (!tid) {
      return jsonResponse({ code: 400, message: 'tid is required' }, 400);
    }
    return jsonResponse({ code: 404, message: 'task not found' }, 404);
  }

  // POST /api/task/{type}/cancel
  if (path.includes('/cancel')) {
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/delete
  if (path.includes('/delete')) {
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/retry
  if (path.includes('/retry')) {
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/cancel_some
  if (path.includes('/cancel_some')) {
    return jsonResponse({ code: 200, message: 'success', data: {} });
  }

  // POST /api/task/{type}/delete_some
  if (path.includes('/delete_some')) {
    return jsonResponse({ code: 200, message: 'success', data: {} });
  }

  // POST /api/task/{type}/retry_some
  if (path.includes('/retry_some')) {
    return jsonResponse({ code: 200, message: 'success', data: {} });
  }

  // POST /api/task/{type}/clear_done
  if (path.includes('/clear_done')) {
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/clear_succeeded
  if (path.includes('/clear_succeeded')) {
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/retry_failed
  if (path.includes('/retry_failed')) {
    return jsonResponse({ code: 200, message: 'success' });
  }

  return jsonResponse({ code: 200, message: 'success', data: [] });
}

function jsonResponse(data: any, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

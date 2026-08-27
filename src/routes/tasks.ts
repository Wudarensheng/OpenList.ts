import { Env } from '../types';
import { jsonResponse } from '../utils/response';

// Task state constants matching the frontend's tache library
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

interface TaskRow {
  id: number;
  type: string;
  name: string;
  state: number;
  status: string;
  progress: number;
  error: string;
  extra: string;
  creator_id: number;
  created_at: string;
  updated_at: string;
}

function rowToTask(row: any): Record<string, any> {
  return {
    id: (row as any).id,
    name: (row as any).name || '',
    state: (row as any).state ?? 0,
    status: (row as any).status || '',
    progress: (row as any).progress ?? 0,
    error: (row as any).error || '',
    type: (row as any).type,
    creator: (row as any).creator_id || 0,
    // extra is opaque to the frontend for generic tasks
    extra: {},
    created_at: (row as any).created_at,
    updated_at: (row as any).updated_at,
  };
}

function taskTypeFromPath(path: string): string {
  const parts = path.split('/'); // /api/task/<type>/<action>
  if (parts.length >= 4) return parts[3];
  return '';
}

export async function handleTaskRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  const type = taskTypeFromPath(path);

  // GET /api/task/{type}/undone
  if (path.endsWith('/undone')) {
    const rows = await env.DB.prepare(
      `SELECT * FROM tasks WHERE type = ? AND state IN (?, ?) ORDER BY id DESC`
    ).bind(type || '%', TaskState.Pending, TaskState.Running).all();
    return jsonResponse({
      code: 200,
      message: 'success',
      data: (rows.results || []).map(rowToTask)
    });
  }

  // GET /api/task/{type}/done
  if (path.endsWith('/done')) {
    const rows = await env.DB.prepare(
      `SELECT * FROM tasks WHERE type = ? AND state IN (?, ?, ?, ?) ORDER BY id DESC`
    ).bind(type || '%', TaskState.Errored, TaskState.Canceled, TaskState.Failed, TaskState.Succeeded).all();
    return jsonResponse({
      code: 200,
      message: 'success',
      data: (rows.results || []).map(rowToTask)
    });
  }

  // POST /api/task/{type}/info
  if (path.endsWith('/info')) {
    const tid = url.searchParams.get('tid');
    if (!tid) {
      return jsonResponse({ code: 400, message: 'tid is required' }, 400);
    }
    const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(tid).first();
    if (!row) {
      return jsonResponse({ code: 404, message: 'task not found' }, 404);
    }
    return jsonResponse({ code: 200, message: 'success', data: rowToTask(row) });
  }

  // POST /api/task/{type}/cancel
  if (path.endsWith('/cancel')) {
    const tid = url.searchParams.get('tid');
    if (tid) {
      await env.DB.prepare(
        'UPDATE tasks SET state = ?, status = ? WHERE id = ?'
      ).bind(TaskState.Canceled, 'canceled', tid).run();
    }
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/delete
  if (path.endsWith('/delete')) {
    const tid = url.searchParams.get('tid');
    if (tid) {
      await env.DB.prepare('DELETE FROM tasks WHERE id = ?').bind(tid).run();
    }
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/retry
  if (path.endsWith('/retry')) {
    const tid = url.searchParams.get('tid');
    if (tid) {
      await env.DB.prepare(
        'UPDATE tasks SET state = ?, status = ?, error = ? WHERE id = ?'
      ).bind(TaskState.Pending, 'pending', '', tid).run();
    }
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/cancel_some
  if (path.endsWith('/cancel_some')) {
    return jsonResponse({ code: 200, message: 'success', data: {} });
  }

  // POST /api/task/{type}/delete_some
  if (path.endsWith('/delete_some')) {
    return jsonResponse({ code: 200, message: 'success', data: {} });
  }

  // POST /api/task/{type}/retry_some
  if (path.endsWith('/retry_some')) {
    return jsonResponse({ code: 200, message: 'success', data: {} });
  }

  // POST /api/task/{type}/clear_done
  if (path.endsWith('/clear_done')) {
    await env.DB.prepare(
      `DELETE FROM tasks WHERE type = ? AND state IN (?, ?, ?, ?)`
    ).bind(type || '%', TaskState.Errored, TaskState.Canceled, TaskState.Failed, TaskState.Succeeded).run();
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/clear_succeeded
  if (path.endsWith('/clear_succeeded')) {
    await env.DB.prepare(
      'DELETE FROM tasks WHERE type = ? AND state = ?'
    ).bind(type || '%', TaskState.Succeeded).run();
    return jsonResponse({ code: 200, message: 'success' });
  }

  // POST /api/task/{type}/retry_failed
  if (path.endsWith('/retry_failed')) {
    await env.DB.prepare(
      'UPDATE tasks SET state = ?, status = ? WHERE type = ? AND state IN (?, ?)'
    ).bind(TaskState.Pending, 'pending', type || '%', TaskState.Errored, TaskState.Failed).run();
    return jsonResponse({ code: 200, message: 'success' });
  }

  return jsonResponse({ code: 200, message: 'success', data: [] });
}

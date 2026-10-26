import { clearSession, readSession } from './session';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: { message?: string } & Record<string, unknown>) {
    super(body.message ?? `HTTP ${status}`);
  }
}

export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = readSession();
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined && { 'content-type': 'application/json' }),
      ...(session && { authorization: `Bearer ${session.token}`, 'x-workspace-id': session.workspaceId }),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : {};
  if (res.status === 401 && session) {
    clearSession();
    window.location.assign('/login');
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

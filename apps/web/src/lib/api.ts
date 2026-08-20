/**
 * ÚNICO lugar com fetch (ARCHITECTURE §10). Sessão por cookies httpOnly:
 * - credentials: include em tudo;
 * - mutações levam x-csrf-token lido do cookie legível veyra_csrf;
 * - 401 dispara UM refresh compartilhado (deduplicado) e repete a request;
 * - nada de token em localStorage, nunca.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

function csrfToken(): string {
  return /(?:^|; )veyra_csrf=([^;]+)/.exec(document.cookie)?.[1] ?? '';
}

let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-csrf-token': csrfToken() },
  })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    });
  return refreshing;
}

async function run<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  const isMutation = method !== 'GET';
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(isMutation ? { 'x-csrf-token': csrfToken() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retried && !path.startsWith('/api/auth/login')) {
    if (await tryRefresh()) return run<T>(method, path, body, true);
  }
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as {
      message?: string | string[];
      issues?: { path: string; message: string }[];
    } | null;
    const message = Array.isArray(payload?.message)
      ? payload.message.join('; ')
      : (payload?.message ?? `Erro ${res.status}`);
    throw new ApiError(res.status, message, payload?.issues);
  }
  return (await res.json()) as T;
}

/**
 * Upload é o único caminho que NÃO manda JSON: o browser precisa montar o
 * boundary do multipart sozinho, então não definimos Content-Type aqui.
 */
async function upload<T>(path: string, file: File, retried = false): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'x-csrf-token': csrfToken() },
    body: form,
  });
  if (res.status === 401 && !retried && (await tryRefresh())) return upload<T>(path, file, true);
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new ApiError(res.status, payload?.message ?? `Erro ${res.status}`);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => run<T>('GET', path),
  upload,
  post: <T>(path: string, body?: unknown) => run<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => run<T>('PATCH', path, body),
  delete: <T>(path: string) => run<T>('DELETE', path),
};

export function toQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages from the backend's Zod validation errors. */
  get fieldErrors(): Record<string, string> {
    if (!Array.isArray(this.details)) return {};
    const out: Record<string, string> = {};
    for (const issue of this.details as { path?: string; message?: string }[]) {
      if (issue.path && issue.message && !out[issue.path]) out[issue.path] = issue.message;
    }
    return out;
  }
}

/**
 * The access token lives in a module-scoped variable, never in localStorage or
 * sessionStorage. An XSS payload can still call the API as the user, but it
 * cannot exfiltrate a token that outlives the page.
 */
let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Registered by AuthProvider so a failed refresh can clear user state. */
export function setAuthLostHandler(handler: (() => void) | null): void {
  onAuthLost = handler;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Set for the refresh call itself, to stop it recursing on its own 401. */
  skipRefresh?: boolean;
  signal?: AbortSignal;
}

async function parse(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function rawRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    headers,
    // Required so the httpOnly refresh and cart cookies travel with the request.
    credentials: 'include',
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  const payload = await parse(res);

  if (!res.ok) {
    const err = (payload as { error?: { code: string; message: string; details?: unknown } })?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with status ${res.status}`,
      err?.details,
    );
  }

  return payload as T;
}

/**
 * Single-flight refresh.
 *
 * If several requests expire at once they must not each fire their own refresh:
 * the backend rotates the token on every use, so concurrent refreshes would
 * look like token reuse and revoke the whole session. Instead the first caller
 * performs the refresh and the rest await the same promise.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const data = await rawRequest<{ accessToken: string }>('/auth/refresh', {
        method: 'POST',
        skipRefresh: true,
      });
      accessToken = data.accessToken;
      return true;
    } catch {
      accessToken = null;
      onAuthLost?.();
      return false;
    } finally {
      // Cleared in a microtask so every queued caller sees the same result
      // before the next refresh can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  try {
    return await rawRequest<T>(path, options);
  } catch (err) {
    const expired =
      err instanceof ApiError &&
      err.status === 401 &&
      (err.code === 'TOKEN_EXPIRED' || err.code === 'UNAUTHORIZED' || err.code === 'TOKEN_INVALID');

    if (!expired || options.skipRefresh) throw err;

    const refreshed = await refreshAccessToken();
    if (!refreshed) throw err;

    return rawRequest<T>(path, options);
  }
}

export function buildQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

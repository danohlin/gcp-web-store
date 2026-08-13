import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, request, setAccessToken, setAuthLostHandler } from './client';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function unauthorized(code = 'TOKEN_EXPIRED'): Response {
  return jsonResponse(401, { error: { code, message: 'Access token expired' } });
}

describe('api client', () => {
  beforeEach(() => {
    setAccessToken(null);
    setAuthLostHandler(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the access token and credentials', async () => {
    setAccessToken('token-abc');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await request('/cart');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/cart');
    expect(init.headers.Authorization).toBe('Bearer token-abc');
    // Cookies must ride along or the refresh and cart cookies never arrive.
    expect(init.credentials).toBe('include');
  });

  it('surfaces the backend error code and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(409, {
          error: { code: 'INSUFFICIENT_STOCK', message: 'Only 2 left', details: { available: 2 } },
        }),
      ),
    );

    await expect(request('/cart/items')).rejects.toMatchObject({
      status: 409,
      code: 'INSUFFICIENT_STOCK',
      message: 'Only 2 left',
    });
  });

  it('refreshes once and replays the original request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh-token' }))
      .mockResolvedValueOnce(jsonResponse(200, { items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await request<{ items: unknown[] }>('/orders');

    expect(result).toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/auth/refresh');
    // The replayed request carries the new token.
    expect(fetchMock.mock.calls[2]![1].headers.Authorization).toBe('Bearer fresh-token');
  });

  it('issues only one refresh for several requests failing at once', async () => {
    let refreshCalls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/refresh') {
          refreshCalls += 1;
          // A real refresh is not instant; the delay is what would let a
          // second refresh slip through if the single-flight guard were wrong.
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResponse(200, { accessToken: 'fresh-token' });
        }
        return refreshCalls === 0 ? unauthorized() : jsonResponse(200, { ok: true });
      }),
    );

    await Promise.all([request('/orders'), request('/cart'), request('/auth/me')]);

    // The backend rotates refresh tokens, so a second concurrent refresh would
    // look like token reuse and revoke the whole session.
    expect(refreshCalls).toBe(1);
  });

  it('gives up and notifies when the refresh itself fails', async () => {
    const onAuthLost = vi.fn();
    setAuthLostHandler(onAuthLost);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/auth/refresh' ? unauthorized('REFRESH_TOKEN_INVALID') : unauthorized(),
      ),
    );

    await expect(request('/orders')).rejects.toBeInstanceOf(ApiError);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
  });

  it('does not try to refresh a failed refresh', async () => {
    const fetchMock = vi.fn().mockResolvedValue(unauthorized('REFRESH_TOKEN_INVALID'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('/auth/refresh', { method: 'POST', skipRefresh: true })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps validation issues to field errors', () => {
    const err = new ApiError(422, 'VALIDATION_ERROR', 'Validation failed', [
      { path: 'email', message: 'Enter a valid email address' },
      { path: 'password', message: 'Too short' },
    ]);

    expect(err.fieldErrors).toEqual({
      email: 'Enter a valid email address',
      password: 'Too short',
    });
  });
});

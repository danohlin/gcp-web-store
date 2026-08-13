import type { CookieOptions, Response } from 'express';
import { config } from '../config/index.js';

export const REFRESH_COOKIE = 'refresh_token';
export const CART_COOKIE = 'cart_token';

function baseOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    // Lax rather than Strict: the cookie must survive a top-level navigation
    // back from an external page, which a future real payment redirect needs.
    sameSite: 'lax',
    secure: config.cookieSecure,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, baseOptions(config.refreshTokenTtlDays * 24 * 60 * 60 * 1000));
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, { ...baseOptions(0), maxAge: undefined });
}

export function setCartCookie(res: Response, token: string): void {
  res.cookie(CART_COOKIE, token, baseOptions(config.guestCartTtlDays * 24 * 60 * 60 * 1000));
}

export function clearCartCookie(res: Response): void {
  res.clearCookie(CART_COOKIE, { ...baseOptions(0), maxAge: undefined });
}

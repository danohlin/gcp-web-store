import type { Request, RequestHandler, Response } from 'express';
import { CART_COOKIE, REFRESH_COOKIE, clearCartCookie, clearRefreshCookie, setRefreshCookie } from '../../lib/cookies.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { body } from '../../middleware/validate.js';
import { mergeGuestCart } from '../cart/cart.service.js';
import * as authService from './auth.service.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.schemas.js';

function context(req: Request): authService.AuthContext {
  return { userAgent: req.get('user-agent') ?? undefined, ip: req.ip };
}

/**
 * The refresh token travels only as an httpOnly cookie; the access token is
 * returned in the body for the SPA to hold in memory. Neither is written to
 * localStorage, so an XSS payload cannot lift a long-lived credential.
 */
async function completeSignIn(
  req: Request,
  res: Response,
  result: authService.AuthResult,
  status: number,
): Promise<void> {
  const guestCartToken = req.cookies?.[CART_COOKIE];
  if (guestCartToken) {
    await mergeGuestCart(guestCartToken, result.user.id);
    // The cart is now keyed by user id, so the guest cookie is dead weight.
    clearCartCookie(res);
  }

  setRefreshCookie(res, result.refreshToken);
  res.status(status).json({ user: result.user, accessToken: result.accessToken });
}

export const register: RequestHandler = async (req, res) => {
  const result = await authService.register(body(req, registerSchema), context(req));
  await completeSignIn(req, res, result, 201);
};

export const login: RequestHandler = async (req, res) => {
  const result = await authService.login(body(req, loginSchema), context(req));
  await completeSignIn(req, res, result, 200);
};

export const refresh: RequestHandler = async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw new UnauthorizedError('No refresh token provided', 'REFRESH_TOKEN_MISSING');

  try {
    const result = await authService.refresh(token, context(req));
    setRefreshCookie(res, result.refreshToken);
    res.json({ user: result.user, accessToken: result.accessToken });
  } catch (err) {
    // A dead token should not linger in the browser.
    clearRefreshCookie(res);
    throw err;
  }
};

export const logout: RequestHandler = async (req, res) => {
  await authService.logout(req.cookies?.[REFRESH_COOKIE]);
  clearRefreshCookie(res);
  res.status(204).send();
};

export const me: RequestHandler = async (req, res) => {
  const user = await authService.getById(req.user!.id);
  if (!user) throw new UnauthorizedError();
  res.json({ user });
};

export const forgotPassword: RequestHandler = async (req, res) => {
  const { email } = body(req, forgotPasswordSchema);
  const result = await authService.forgotPassword(email);

  // Identical response whether or not the address is registered.
  res.json({
    message: 'If an account exists for that address, a reset link has been sent.',
    ...(result.devToken ? { devToken: result.devToken } : {}),
  });
};

export const resetPassword: RequestHandler = async (req, res) => {
  const { token, password } = body(req, resetPasswordSchema);
  await authService.resetPassword(token, password);
  clearRefreshCookie(res);
  res.json({ message: 'Password updated. Please sign in again.' });
};

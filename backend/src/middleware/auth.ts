import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/tokens.js';

function extractBearer(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return undefined;
  return token;
}

/** Rejects the request unless a valid access token is present. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) {
    next(new UnauthorizedError());
    return;
  }
  const payload = verifyAccessToken(token);
  req.user = { id: payload.sub, email: payload.email, role: payload.role };
  next();
};

/**
 * Attaches the user when a valid token is present but never fails. Used by
 * endpoints that serve both guests and signed-in users, such as the cart.
 */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractBearer(req);
  if (!token) {
    next();
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
  } catch {
    // An expired or bogus token degrades to guest rather than blocking access.
  }
  next();
};

export const requireAdmin: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.user) {
    next(new UnauthorizedError());
    return;
  }
  if (req.user.role !== 'ADMIN') {
    next(new ForbiddenError('Administrator access required'));
    return;
  }
  next();
};

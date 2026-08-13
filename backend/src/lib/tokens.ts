import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { config } from '../config/index.js';
import { UnauthorizedError } from './errors.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  role: Role;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.jwtAccessSecret, {
    expiresIn: config.accessTokenTtl as jwt.SignOptions['expiresIn'],
    issuer: 'web-store',
    audience: 'web-store-api',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret, {
      issuer: 'web-store',
      audience: 'web-store-api',
    });
    if (typeof decoded === 'string') throw new Error('unexpected token form');
    return { sub: decoded.sub as string, email: decoded.email, role: decoded.role };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Access token expired', 'TOKEN_EXPIRED');
    }
    throw new UnauthorizedError('Invalid access token', 'TOKEN_INVALID');
  }
}

/**
 * Refresh and password-reset tokens are opaque random strings, not JWTs. Only a
 * SHA-256 digest is persisted, so a database leak does not hand out usable
 * tokens. SHA-256 is appropriate here (unlike for passwords) because the input
 * already has 256 bits of entropy and cannot be brute-forced.
 */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Session identifier for guest carts. Not a credential, just a lookup key. */
export function generateSessionToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function generateOrderNumber(): string {
  const now = new Date();
  const datePart =
    `${now.getUTCFullYear()}` +
    `${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(now.getUTCDate()).padStart(2, '0')}`;
  // 5 random base32-ish chars: enough to avoid collisions at this scale while
  // staying short enough to read over the phone.
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 5);
  return `WS-${datePart}-${randomPart}`;
}

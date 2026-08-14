import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { config } from '../../config/index.js';
import { logger } from '../../lib/logger.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import { generateOpaqueToken, hashOpaqueToken, signAccessToken } from '../../lib/tokens.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

export interface AuthContext {
  userAgent?: string;
  ip?: string;
}

export interface PublicUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: User['role'];
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    createdAt: user.createdAt,
  };
}

/**
 * A precomputed hash of a random string. Verifying against it when no user
 * exists keeps login timing roughly constant, so response latency cannot be
 * used to enumerate registered email addresses.
 */
let decoyHash: string | undefined;
async function getDecoyHash(): Promise<string> {
  decoyHash ??= await hashPassword(`decoy-${Math.random()}`);
  return decoyHash;
}

async function issueTokens(user: User, ctx: AuthContext): Promise<AuthResult> {
  const accessToken = signAccessToken({ sub: user.id, email: user.email, role: user.role });
  const { token: refreshToken, hash } = generateOpaqueToken();

  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000),
      userAgent: ctx.userAgent?.slice(0, 500),
      ip: ctx.ip,
    },
  });

  return { user: toPublicUser(user), accessToken, refreshToken };
}

export async function register(input: RegisterInput, ctx: AuthContext): Promise<AuthResult> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) {
    throw new ConflictError('An account with that email already exists', 'EMAIL_TAKEN');
  }

  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash: await hashPassword(input.password),
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
    },
  });

  logger.info({ userId: user.id }, 'user registered');
  return issueTokens(user, ctx);
}

export async function login(input: LoginInput, ctx: AuthContext): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  const valid = user
    ? await verifyPassword(user.passwordHash, input.password)
    : await verifyPassword(await getDecoyHash(), input.password);

  // One message for both "no such account" and "wrong password".
  if (!user || !valid) {
    throw new UnauthorizedError('Incorrect email or password', 'INVALID_CREDENTIALS');
  }

  return issueTokens(user, ctx);
}

/**
 * Rotates a refresh token. Presenting a token that was already rotated means
 * either a stolen token or a replay, so the whole family is revoked and the
 * user must sign in again.
 */
export async function refresh(rawToken: string, ctx: AuthContext): Promise<AuthResult> {
  const tokenHash = hashOpaqueToken(rawToken);
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored) {
    throw new UnauthorizedError('Invalid refresh token', 'REFRESH_TOKEN_INVALID');
  }

  if (stored.revokedAt) {
    logger.warn({ userId: stored.userId }, 'refresh token reuse detected; revoking all sessions');
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new UnauthorizedError('Refresh token has been revoked', 'REFRESH_TOKEN_REUSED');
  }

  if (stored.expiresAt <= new Date()) {
    throw new UnauthorizedError('Refresh token has expired', 'REFRESH_TOKEN_EXPIRED');
  }

  const result = await issueTokens(stored.user, ctx);

  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: {
      revokedAt: new Date(),
      replacedBy: { connect: { tokenHash: hashOpaqueToken(result.refreshToken) } },
    },
  });

  return result;
}

export async function logout(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  // updateMany rather than update: logging out twice must not 404.
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashOpaqueToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export interface ForgotPasswordResult {
  /**
   * Only populated outside production. Transactional email is deferred, so this
   * is how the reset link is obtained in local development and tests.
   */
  devToken?: string;
}

export async function forgotPassword(email: string): Promise<ForgotPasswordResult> {
  const user = await prisma.user.findUnique({ where: { email } });

  // Always report success: whether an address is registered is not public.
  if (!user) {
    logger.info({ email }, 'password reset requested for unknown address');
    return {};
  }

  // Invalidate outstanding tokens so only the newest link works.
  await prisma.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  const { token, hash } = generateOpaqueToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: new Date(Date.now() + config.passwordResetTtlMinutes * 60 * 1000),
    },
  });

  // TODO(email): send via an email provider once a verified sender domain exists.
  logger.info({ userId: user.id }, 'password reset token issued (delivery not yet wired)');

  return config.nodeEnv === 'production' ? {} : { devToken: token };
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashOpaqueToken(rawToken) },
  });

  if (!stored || stored.usedAt || stored.expiresAt <= new Date()) {
    throw new UnauthorizedError('This reset link is invalid or has expired', 'RESET_TOKEN_INVALID');
  }

  const passwordHash = await hashPassword(newPassword);

  await prisma.$transaction([
    prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: stored.id }, data: { usedAt: new Date() } }),
    // A password change signs out every existing session.
    prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  logger.info({ userId: stored.userId }, 'password reset completed');
}

export async function getById(userId: string): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  return user ? toPublicUser(user) : null;
}

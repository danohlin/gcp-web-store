import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Secret resolution.
 *
 * In Kubernetes the Secrets Store CSI driver mounts each secret as a file under
 * SECRETS_DIR. Reading from files (rather than injecting env vars) keeps
 * secrets out of manifests, out of `kubectl describe pod`, and out of any child
 * process environment.
 *
 * Precedence: file under SECRETS_DIR -> environment variable -> undefined.
 * Locally SECRETS_DIR is unset, so everything falls through to .env.
 */
const secretsDir = process.env.SECRETS_DIR;

function resolve(name: string): string | undefined {
  if (secretsDir) {
    try {
      const value = fs.readFileSync(path.join(secretsDir, name), 'utf8').trim();
      if (value.length > 0) return value;
    } catch {
      // Not mounted; fall back to the environment.
    }
  }
  return process.env[name];
}

/**
 * The RDS-managed secret in AWS Secrets Manager is a JSON document. The CSI
 * driver splits it into one file per key, so the connection string is assembled
 * here rather than being stored as a whole. A directly supplied DATABASE_URL
 * (local dev, CI) always wins.
 */
function resolveDatabaseUrl(): string | undefined {
  const direct = resolve('DATABASE_URL');
  if (direct) return direct;

  const host = resolve('DB_HOST');
  const password = resolve('DB_PASSWORD');
  if (!host || !password) return undefined;

  const user = resolve('DB_USER') ?? 'webstore';
  const port = resolve('DB_PORT') ?? '5432';
  const name = resolve('DB_NAME') ?? 'webstore';
  const sslMode = resolve('DB_SSLMODE') ?? 'require';

  // Credentials may contain characters that are not URL-safe.
  return (
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${name}?schema=public&sslmode=${sslMode}`
  );
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  port: z.coerce.number().int().positive().default(4000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  databaseUrl: z.string().min(1, 'DATABASE_URL (or DB_HOST + DB_PASSWORD) must be provided'),

  jwtAccessSecret: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  jwtRefreshSecret: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  accessTokenTtl: z.string().default('15m'),
  refreshTokenTtlDays: z.coerce.number().int().positive().default(30),
  guestCartTtlDays: z.coerce.number().int().positive().default(30),
  passwordResetTtlMinutes: z.coerce.number().int().positive().default(60),

  corsOrigins: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  cookieSecure: booleanish.default(false),
  trustProxy: booleanish.default(false),

  paymentProvider: z.enum(['mock']).default('mock'),

  shippingFlatCents: z.coerce.number().int().nonnegative().default(599),
  freeShippingThresholdCents: z.coerce.number().int().nonnegative().default(5000),
  taxRateBasisPoints: z.coerce.number().int().nonnegative().default(875),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse({
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    logLevel: process.env.LOG_LEVEL,

    databaseUrl: resolveDatabaseUrl(),

    jwtAccessSecret: resolve('JWT_ACCESS_SECRET'),
    jwtRefreshSecret: resolve('JWT_REFRESH_SECRET'),
    accessTokenTtl: process.env.ACCESS_TOKEN_TTL,
    refreshTokenTtlDays: process.env.REFRESH_TOKEN_TTL_DAYS,
    guestCartTtlDays: process.env.GUEST_CART_TTL_DAYS,
    passwordResetTtlMinutes: process.env.PASSWORD_RESET_TTL_MINUTES,

    corsOrigins: process.env.CORS_ORIGINS,
    cookieSecure: process.env.COOKIE_SECURE,
    trustProxy: process.env.TRUST_PROXY,

    paymentProvider: process.env.PAYMENT_PROVIDER,

    shippingFlatCents: process.env.SHIPPING_FLAT_CENTS,
    freeShippingThresholdCents: process.env.FREE_SHIPPING_THRESHOLD_CENTS,
    taxRateBasisPoints: process.env.TAX_RATE_BASIS_POINTS,
  });

  if (!parsed.success) {
    // Fail fast and loudly: a misconfigured pod should crash-loop visibly
    // rather than start up in a half-working state.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const config = parsed.data;

  if (config.nodeEnv === 'production') {
    const weak = ['dev-only-access-secret-change-me', 'dev-only-refresh-secret-change-me'];
    if (weak.includes(config.jwtAccessSecret) || weak.includes(config.jwtRefreshSecret)) {
      throw new Error('Refusing to start in production with development JWT secrets.');
    }
  }

  return config;
}

export const config = load();

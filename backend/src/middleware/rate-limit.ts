import rateLimit, { type Options } from 'express-rate-limit';
import { TooManyRequestsError } from '../lib/errors.js';
import { config } from '../config/index.js';

// Limits are process-local. With several replicas the effective ceiling is
// per-pod; a shared Redis store would be the fix if that becomes a problem.
function make(options: Partial<Options>) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Disable entirely under test so fixtures are not throttled.
    skip: () => config.nodeEnv === 'test',
    handler: (_req, _res, next) => next(new TooManyRequestsError()),
    ...options,
  });
}

/** Broad ceiling for the API as a whole. */
export const generalLimiter = make({ limit: 600 });

/** Credential endpoints: tight, to blunt password spraying. */
export const authLimiter = make({ limit: 10, skipSuccessfulRequests: true });

/** Account creation and password-reset requests. */
export const sensitiveLimiter = make({ limit: 5 });

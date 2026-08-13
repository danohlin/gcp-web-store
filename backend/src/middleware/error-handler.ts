import type { ErrorRequestHandler, RequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError, NotFoundError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/index.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    stack?: string;
  };
}

/**
 * Single place where an exception becomes an HTTP response. Express 5 forwards
 * rejected promises here automatically, so controllers need no try/catch.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'An unexpected error occurred';
  let details: unknown;

  if (err instanceof AppError) {
    ({ status, code, message } = err);
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 422;
    code = 'VALIDATION_ERROR';
    message = 'Validation failed';
    details = err.issues;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002':
        status = 409;
        code = 'DUPLICATE';
        message = 'A record with those details already exists';
        details = { fields: err.meta?.target };
        break;
      case 'P2025':
        status = 404;
        code = 'NOT_FOUND';
        message = 'Resource not found';
        break;
      case 'P2003':
        status = 409;
        code = 'FOREIGN_KEY_VIOLATION';
        message = 'Referenced record does not exist';
        break;
      default:
        break;
    }
  } else if (err instanceof SyntaxError && 'body' in err) {
    status = 400;
    code = 'MALFORMED_JSON';
    message = 'Request body is not valid JSON';
  }

  // 5xx means we broke something: log the full error. 4xx is the caller's
  // problem and only worth a debug line.
  const log = { err, requestId: req.headers['x-request-id'], path: req.path, method: req.method };
  if (status >= 500) logger.error(log, message);
  else logger.debug(log, message);

  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  if (config.nodeEnv !== 'production' && status >= 500 && err instanceof Error) {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
};

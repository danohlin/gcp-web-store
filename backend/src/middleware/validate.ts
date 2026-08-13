import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { ValidationError } from '../lib/errors.js';

interface Schemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function formatIssues(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

/**
 * Parses request input against Zod schemas and stores the result on
 * `req.validated`. Controllers read from there, never from the raw request, so
 * unvalidated input cannot reach a service by accident.
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.validated = {
        body: schemas.body ? schemas.body.parse(req.body) : undefined,
        query: schemas.query ? schemas.query.parse(req.query) : undefined,
        params: schemas.params ? schemas.params.parse(req.params) : undefined,
      };
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new ValidationError(formatIssues(err)));
        return;
      }
      next(err);
    }
  };
}

/** Typed accessors so controllers avoid scattering `as` casts. */
export function body<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.validated?.body as z.infer<T>;
}

export function query<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.validated?.query as z.infer<T>;
}

export function params<T extends ZodTypeAny>(req: Request, _schema: T): z.infer<T> {
  return req.validated?.params as z.infer<T>;
}

import type { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Populated by `requireAuth` / `optionalAuth`. */
      user?: { id: string; email: string; role: Role };
      /**
       * Output of the `validate` middleware. Express 5 makes `req.query` a
       * read-only getter, so parsed input is collected here instead of being
       * written back onto the request.
       */
      validated?: { body?: unknown; query?: unknown; params?: unknown };
    }
  }
}

export {};

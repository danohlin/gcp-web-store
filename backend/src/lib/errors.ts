/**
 * Application errors carry an HTTP status and a stable machine-readable code so
 * the frontend can branch on `error.code` instead of parsing messages.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Validation failed') {
    super(422, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict', code = 'CONFLICT', details?: unknown) {
    super(409, code, message, details);
  }
}

/** Raised when a cart line exceeds what is physically in stock. */
export class InsufficientStockError extends ConflictError {
  constructor(productName: string, available: number) {
    super(
      available > 0
        ? `Only ${available} of "${productName}" ${available === 1 ? 'is' : 'are'} left in stock`
        : `"${productName}" is out of stock`,
      'INSUFFICIENT_STOCK',
      { productName, available },
    );
  }
}

export class PaymentDeclinedError extends AppError {
  constructor(message = 'Payment was declined', failureCode = 'card_declined') {
    super(402, 'PAYMENT_DECLINED', message, { failureCode });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests, please try again later') {
    super(429, 'TOO_MANY_REQUESTS', message);
  }
}

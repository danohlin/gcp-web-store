import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter, sensitiveLimiter } from '../../middleware/rate-limit.js';
import * as controller from './auth.controller.js';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.schemas.js';

export const authRouter = Router();

authRouter.post(
  '/register',
  sensitiveLimiter,
  validate({ body: registerSchema }),
  controller.register,
);

authRouter.post('/login', authLimiter, validate({ body: loginSchema }), controller.login);

authRouter.post('/refresh', controller.refresh);
authRouter.post('/logout', controller.logout);

authRouter.get('/me', requireAuth, controller.me);

authRouter.post(
  '/forgot-password',
  sensitiveLimiter,
  validate({ body: forgotPasswordSchema }),
  controller.forgotPassword,
);

authRouter.post(
  '/reset-password',
  sensitiveLimiter,
  validate({ body: resetPasswordSchema }),
  controller.resetPassword,
);

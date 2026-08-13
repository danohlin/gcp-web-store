import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { generalLimiter } from './middleware/rate-limit.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { catalogRouter } from './modules/catalog/catalog.routes.js';
import { cartRouter } from './modules/cart/cart.routes.js';
import { checkoutRouter } from './modules/checkout/checkout.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';

/**
 * Builds the Express application without binding a port, so integration tests
 * can drive it through supertest in-process.
 */
export function createApp(): Express {
  const app = express();

  // Behind an ALB, the client IP and protocol arrive in X-Forwarded-*. Without
  // this, rate limiting would bucket every request under the load balancer.
  if (config.trustProxy) app.set('trust proxy', true);

  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API serves JSON only; CSP is enforced by the frontend's nginx.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.use(
    cors({
      origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
      // Required for the refresh and cart cookies to be sent cross-origin.
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(cookieParser());

  app.use(
    pinoHttp({
      logger,
      autoLogging: {
        // Probes would otherwise dominate the log volume.
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
      },
    }),
  );

  // ---- probes (outside /api so the ALB can reach them directly) ----------

  // Liveness: process is up. Must not touch the database, or a brief DB blip
  // would cause Kubernetes to kill otherwise-healthy pods.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Readiness: can this pod actually serve traffic?
  app.get('/readyz', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ready' });
    } catch (err) {
      logger.error({ err }, 'readiness check failed');
      res.status(503).json({ status: 'not-ready', reason: 'database unreachable' });
    }
  });

  // ---- api --------------------------------------------------------------

  app.use('/api', generalLimiter);
  app.use('/api/auth', authRouter);
  app.use('/api', catalogRouter);
  app.use('/api/cart', cartRouter);
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/orders', ordersRouter);
  app.use('/api/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

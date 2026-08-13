import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';

const app = createApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.nodeEnv }, 'web-store api listening');
});

/**
 * Kubernetes sends SIGTERM and then removes the pod from the Service endpoints.
 * Draining in-flight requests before exiting avoids 502s during a rollout.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');

  const force = setTimeout(() => {
    logger.error('graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, 15_000);
  force.unref();

  server.close(async (err) => {
    if (err) logger.error({ err }, 'error closing http server');
    try {
      await prisma.$disconnect();
    } catch (disconnectErr) {
      logger.error({ err: disconnectErr }, 'error disconnecting prisma');
    }
    clearTimeout(force);
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});

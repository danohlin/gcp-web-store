import { PrismaClient } from '@prisma/client';
import { config } from '../config/index.js';
import { logger } from './logger.js';

export const prisma = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
  log:
    config.logLevel === 'debug' || config.logLevel === 'trace'
      ? [{ emit: 'event', level: 'query' }]
      : [],
});

if (config.logLevel === 'debug' || config.logLevel === 'trace') {
  prisma.$on('query' as never, (e: { query: string; params: string; duration: number }) => {
    logger.debug({ query: e.query, durationMs: e.duration }, 'prisma query');
  });
}

export type PrismaTransaction = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

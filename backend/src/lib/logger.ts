import { pino } from 'pino';
import { config } from '../config/index.js';

export const logger = pino({
  level: config.logLevel,
  // Structured JSON in production so CloudWatch/Loki can parse it; pretty
  // output locally is left to `pino-pretty` piped in the dev script if wanted.
  base: { service: 'web-store-backend' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.token',
      '*.refreshToken',
      '*.cardNumber',
      '*.cvc',
    ],
    censor: '[redacted]',
  },
  transport:
    config.nodeEnv === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});

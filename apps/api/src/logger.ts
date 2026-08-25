import pino, { type Logger } from 'pino';

/**
 * Structured logging.
 *
 * Redaction is deliberately aggressive: this process handles OAuth tokens,
 * cookies and vault material, and logs are the easiest place to leak them.
 */
export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-metaclaude-csrf"]',
        'res.headers["set-cookie"]',
        'password',
        'passwordHash',
        'token',
        'oauthToken',
        'apiKey',
        'secret',
        'totpSecret',
        '*.password',
        '*.token',
        '*.apiKey',
        '*.secret',
      ],
      censor: '[redacted]',
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export type { Logger };

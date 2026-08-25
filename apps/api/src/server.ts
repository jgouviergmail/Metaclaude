/**
 * HTTP server assembly.
 *
 * Plugin order matters and is deliberate:
 *   helmet → cookie → rate limit → websocket → guards → routes → static SPA
 *
 * The guard hook runs before every route handler, so a new route is protected
 * by default and must be added to the public allow-list to become reachable
 * without a session.
 */

import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { LogController, type FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import type { App } from './http/types.js';
import { authenticate, isPublicPath, requestIp, sendError, verifyCsrf } from './http/guards.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFileRoutes } from './routes/files.js';
import { registerLearningRoutes } from './routes/learning.js';
import { registerRegistryRoutes } from './routes/registry.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerWebSocket } from './routes/ws.js';

/**
 * Set a header on whatever `@fastify/static` hands its `setHeaders` callback.
 *
 * The plugin's types say `FastifyReply`, but older releases passed the raw
 * `ServerResponse`. Handling both keeps caching correct across either, instead
 * of silently throwing inside a stream callback.
 */
function setCacheControl(target: unknown, value: string): void {
  const candidate = target as Partial<ServerResponse> & {
    header?: (name: string, value: string) => unknown;
  };
  if (typeof candidate.header === 'function') {
    candidate.header('cache-control', value);
  } else if (typeof candidate.setHeader === 'function') {
    candidate.setHeader('cache-control', value);
  }
}

export async function buildServer(context: AppContext): Promise<App> {
  const isProduction = context.config.env === 'production';

  /**
   * Per-request logging policy.
   *
   * The container healthcheck polls `/api/health` every 30 seconds; logging it
   * would bury everything else. In production the rest of the per-request noise
   * is dropped too — the audit log is the record that matters, and errors are
   * logged explicitly by the error handler.
   */
  class MetaclaudeLogController extends LogController {
    override isLogDisabled(request: FastifyRequest): boolean {
      if (request.url === '/api/health') return true;
      return isProduction;
    }
  }

  const app = Fastify({
    loggerInstance: context.log,
    trustProxy: context.config.trustProxy,
    // Transcripts and file writes are the large payloads here.
    bodyLimit: 8 * 1024 * 1024,
    // Reject a request whose id header we did not generate.
    genReqId: () => globalThis.crypto.randomUUID(),
    // Fastify expects an instance here, not the class.
    logController: new MetaclaudeLogController(),
  });

  /* ------------------------------ Security ------------------------------ */

  await app.register(helmet, {
    // The SPA is self-hosted and self-contained: no external scripts, styles,
    // fonts or frames. `'unsafe-inline'` for styles is required by the CSS-in-JS
    // that Vite emits for critical styles; scripts stay strictly self-hosted.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    crossOriginEmbedderPolicy: false,
    // Referrers would leak workspace and session ids to any external link.
    referrerPolicy: { policy: 'no-referrer' },
    hsts: context.config.secureCookies
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: false }
      : false,
  });

  await app.register(cookie, {
    // Cookies are unsigned by design: the session token is already a
    // full-entropy random value verified against a stored hash, so a signature
    // would add a key to manage without adding security.
    parseOptions: { sameSite: 'strict', path: '/' },
  });

  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => requestIp(context, request),
    // Health checks come from the container runtime on a tight loop.
    allowList: (request) => request.url === '/api/health',
    errorResponseBuilder: () => ({ error: 'Too many requests.', code: 'rate_limited' }),
  });

  await app.register(websocket, {
    options: {
      maxPayload: 64 * 1024,
      // The client sends small JSON frames; compression would cost more CPU
      // than it saves bandwidth, and permessage-deflate has a memory-growth
      // footgun on long-lived sockets.
      perMessageDeflate: false,
    },
  });

  /* ------------------------------- Guards ------------------------------- */

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';

    // Non-API paths are the SPA shell and its assets; they carry no data.
    if (!path.startsWith('/api/')) return;

    // The WebSocket route authenticates inside its own handler, where it can
    // close with a protocol-specific code instead of returning HTTP.
    if (path === '/api/ws') return;

    if (isPublicPath(path)) return;

    authenticate(context, request);
    verifyCsrf(context, request);
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) {
      context.log.error({ err: error, url: request.url }, 'request failed');
    }
    return sendError(reply, error);
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found.', code: 'not_found' });
    }
    // Client-side routing: any non-API path falls through to the SPA shell.
    return reply.sendFile('index.html');
  });

  /* ------------------------------- Routes ------------------------------- */

  registerSystemRoutes(app, context);
  registerAuthRoutes(app, context);
  registerWorkspaceRoutes(app, context);
  registerFileRoutes(app, context);
  registerLearningRoutes(app, context);
  registerRegistryRoutes(app, context);
  registerWebSocket(app, context);

  /* ------------------------------- Static ------------------------------- */

  if (existsSync(join(context.config.webDir, 'index.html'))) {
    const staticPlugin = (await import('@fastify/static')).default;
    await app.register(staticPlugin, {
      root: context.config.webDir,
      prefix: '/',
      // Hashed asset filenames can be cached hard; the shell and the service
      // worker must not be, or a deploy would never reach an open tab.
      setHeaders: (reply, path) => {
        const value =
          path.endsWith('index.html') || path.endsWith('sw.js')
            ? 'no-cache, must-revalidate'
            : /\.[0-9a-f]{8,}\./.test(path)
              ? 'public, max-age=31536000, immutable'
              : null;
        if (value) setCacheControl(reply, value);
      },
    });
    context.log.info(`serving the web app from ${context.config.webDir}`);
  } else {
    context.log.warn(
      `no built web app at ${context.config.webDir}; the API is running headless`,
    );
  }

  return app;
}

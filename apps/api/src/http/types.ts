/**
 * Server type aliases.
 *
 * Passing a concrete pino instance to Fastify parameterises `FastifyInstance`
 * on that logger type. Route modules must use the same parameterisation or
 * TypeScript treats them as different instance types, so the alias lives here
 * and every module imports it rather than writing `FastifyInstance` bare.
 */

import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyTypeProviderDefault } from 'fastify';
import type { Logger } from 'pino';

// `@fastify/static` augments FastifyReply with `sendFile`. The import is
// type-only but must be present for that augmentation to apply.
import type {} from '@fastify/static';

export type App = FastifyInstance<
  Server,
  IncomingMessage,
  ServerResponse,
  Logger,
  FastifyTypeProviderDefault
>;

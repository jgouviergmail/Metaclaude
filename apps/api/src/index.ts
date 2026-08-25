/**
 * Entry point.
 *
 * Boot order: config → context (database, subsystems) → bootstrap owner →
 * server → scheduler → janitor. Shutdown reverses it, draining in-flight runs
 * before closing the database.
 */

import { loadConfig } from './config.js';
import { createAppContext } from './context.js';
import { createLogger } from './logger.js';
import { startJanitor } from './janitor.js';
import { buildServer } from './server.js';
import { WeakPasswordError } from './security/auth.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.logLevel, config.env !== 'production');

  log.info(
    {
      env: config.env,
      dataDir: config.dataDir,
      workspacesDir: config.workspacesDir,
      authMode: config.claude.authMode,
      maxConcurrentRuns: config.maxConcurrentRuns,
    },
    'Metaclaude starting',
  );

  if (config.claude.authMode === 'none') {
    log.warn(
      'No Claude credentials found. Set CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token` on a machine ' +
        'where you are signed in) to use your subscription, or ANTHROPIC_API_KEY for pay-as-you-go. ' +
        'Agent runs will fail until one is present.',
    );
  }

  const context = await createAppContext(config, log);

  /* ------------------------- First-run bootstrap ------------------------- */

  if (context.auth.countUsers() === 0) {
    if (config.bootstrap) {
      try {
        const user = await context.auth.createUser({
          username: config.bootstrap.username,
          password: config.bootstrap.password,
          role: 'owner',
        });
        context.audit.record({ actor: 'system', action: 'user.bootstrap', target: user.username });
        log.info(`created the owner account "${user.username}" from the bootstrap environment`);
      } catch (error) {
        if (error instanceof WeakPasswordError) {
          log.error(`bootstrap failed: ${error.message}`);
        } else {
          throw error;
        }
      }
    } else {
      log.warn(
        'No accounts exist yet. Set METACLAUDE_BOOTSTRAP_USER and METACLAUDE_BOOTSTRAP_PASSWORD ' +
          '(at least 12 characters) and restart to create the owner account.',
      );
    }
  }

  /* -------------------------------- Serve -------------------------------- */

  const app = await buildServer(context);
  await app.listen({ host: config.host, port: config.port });
  log.info(`listening on http://${config.host}:${config.port}`);

  context.scheduler.start();
  const stopJanitor = startJanitor(context);

  /* ------------------------------ Shutdown ------------------------------- */

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);

    // Give in-flight runs a bounded chance to finish writing their transcripts,
    // then close regardless. A hung CLI must not block the container forever.
    const forceExit = setTimeout(() => {
      log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 20_000);
    forceExit.unref();

    try {
      stopJanitor();
      await app.close();
      await context.shutdown();
      log.info('shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // An unhandled rejection is a bug, but it must not take down a server that
    // is mid-run for the operator. Log it loudly and keep serving.
    log.error({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception, shutting down');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so this path uses stderr directly.
  process.stderr.write(`Metaclaude failed to start: ${(error as Error).stack ?? error}\n`);
  process.exit(1);
});

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
    },
    'Metaclaude starting',
  );

  const context = await createAppContext(config, log);

  // After the context, not before it: an owner may have overridden these from
  // the settings screen, and a boot line naming the environment's value would
  // be the first thing to disagree with the screen that changed it.
  log.info(
    {
      maxConcurrentRuns: context.runtimeSettings.number('maxConcurrentRuns'),
      runTimeoutMs: context.runtimeSettings.number('runTimeoutMs'),
      idleTimeoutMs: context.runtimeSettings.number('idleTimeoutMs'),
    },
    'run ceilings in force',
  );

  /*
   * The credential, as *resolved* rather than as configured.
   *
   * `config.claude.authMode` only knows the two environment variables, so a
   * deployment paired from the interface or signed in with `claude auth login`
   * was logged as `authMode: "none"` on every boot while it worked perfectly.
   * Read alongside the entrypoint's warning, that was two lines agreeing on
   * something false — which is how a real one comes to be ignored.
   */
  const credential = context.claudeCredentials.status();
  log.info(
    {
      mode: credential.mode,
      source: credential.source,
      signInEndsAt: credential.cliLogin?.signInEndsAt ?? null,
    },
    'Claude credential in force',
  );
  // The warning this replaces fired on `config.claude.authMode`, which reads
  // only the two environment variables — so it fired on every boot of a
  // deployment paired from the interface. Now it fires when the resolution
  // that runs actually found nothing, which is when it is true.
  if (credential.mode === 'none') {
    log.warn(
      'No Claude credential resolved — not in the vault, the environment, or the CLI’s own ' +
        'store. Pair one from Settings → System, or run `claude setup-token` on a machine where ' +
        'you are signed in. Agent runs will fail to authenticate until one exists.',
    );
  }

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

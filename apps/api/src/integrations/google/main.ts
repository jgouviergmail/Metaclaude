/**
 * Entry point for the Google MCP server, spawned as
 * `node dist/integrations/google/main.js --grants gmail.read,…`.
 *
 * One line on purpose: everything testable lives in `server.ts`, and a file
 * with a top-level side effect cannot be imported by a test without starting
 * a stdio transport.
 */

import { main } from './server.js';

main().catch((error: Error) => {
  // stdout carries the protocol; diagnostics must not touch it.
  process.stderr.write(`metaclaude-google: ${error.message}\n`);
  process.exit(1);
});

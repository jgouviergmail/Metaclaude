/**
 * Live end-to-end check.
 *
 * Boots the real server and drives the real HTTP + WebSocket API, including a
 * real agent run through the Claude CLI. Unlike the unit suites this needs a
 * working CLI login (`claude setup-token`, or an authenticated `claude` on the
 * PATH), so it is not part of `pnpm test` — run it deliberately:
 *
 *     pnpm --filter @metaclaude/api build
 *     pnpm --filter @metaclaude/api check:e2e
 *
 * Every assertion here corresponds to something the README or the docs claim.
 */

import WebSocket from 'ws';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client, PASSWORD, Results, startServer, until } from './harness.mjs';

const results = new Results();
const server = await startServer();
const api = new Client(server.baseUrl);
const { context, config } = server;

const { parseWireFrame, sessionTopic } = await import('@metaclaude/shared');

/* -------------------------------------------------------------------------- */

results.section('authentication');
{
  results.check('an unauthenticated request is refused', (await api.call('/api/workspaces')).status === 401);

  // Fastify normalises the URL before routing and `onRequest` runs after it, so
  // a guard reading the raw target would wave this through.
  const encoded = await fetch(`${server.baseUrl}/%61pi/workspaces`);
  results.check('a percent-encoded /api path is still guarded', encoded.status === 401);

  const login = await api.login();
  results.check('login succeeds', login.status === 200, `status ${login.status}`);
  results.check('a CSRF token is issued', api.csrfToken.length > 20);

  const noCsrf = await fetch(`${server.baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: { cookie: api.cookieHeader, 'content-type': 'application/json' },
    body: '{}',
  });
  results.check('a write without the CSRF header is refused', noCsrf.status === 403);
}

results.section('two-factor enrolment');
{
  const { totpCode } = await import(new URL('../dist/security/totp.js', import.meta.url).href);

  results.check(
    'enrolment needs a password',
    (await api.call('/api/auth/totp/begin', { method: 'POST', body: {} })).status === 400,
  );
  results.check(
    'enrolment rejects the wrong password',
    (await api.call('/api/auth/totp/begin', { method: 'POST', body: { password: 'nope' } })).status === 403,
  );

  const begun = await api.call('/api/auth/totp/begin', { method: 'POST', body: { password: PASSWORD } });
  results.check('enrolment starts with the right password', begun.status === 200 && Boolean(begun.body.secret));
  results.check(
    'starting an enrolment does not switch 2FA off',
    (await api.call('/api/auth/me')).body.user.totpEnabled === false,
  );

  const confirmed = await api.call('/api/auth/totp/confirm', {
    method: 'POST',
    body: { code: totpCode(begun.body.secret, Date.now()) },
  });
  results.check(
    'confirming enables it and issues recovery codes',
    confirmed.status === 200 && confirmed.body.recoveryCodes.length === 10,
  );

  // The regression that mattered: this used to disable the working factor.
  await api.call('/api/auth/totp/begin', { method: 'POST', body: { password: PASSWORD } });
  results.check(
    're-enrolling leaves the existing factor on',
    (await api.call('/api/auth/me')).body.user.totpEnabled === true,
  );
  await api.call('/api/auth/totp/cancel', { method: 'POST' });
  results.check(
    'disabling with the password works',
    (await api.call('/api/auth/totp/disable', { method: 'POST', body: { password: PASSWORD } })).status === 200,
  );
}

results.section('workspace, files and git');
let workspaceId;
{
  const created = await api.call('/api/workspaces', {
    method: 'POST',
    body: { name: 'E2E Lab', description: 'end-to-end' },
  });
  results.check('a workspace is created', created.status === 201, created.text.slice(0, 120));
  workspaceId = created.body.workspace.id;

  results.check(
    'a file is written',
    (
      await api.call(`/api/workspaces/${workspaceId}/file`, {
        method: 'PUT',
        body: { path: 'notes/hello.txt', content: 'bonjour' },
      })
    ).status === 200,
  );
  const read = await api.call(
    `/api/workspaces/${workspaceId}/file?path=${encodeURIComponent('notes/hello.txt')}`,
  );
  results.check('and read back', read.body?.content === 'bonjour');

  results.check(
    'a traversal is refused',
    (
      await api.call(`/api/workspaces/${workspaceId}/file?path=${encodeURIComponent('../../etc/passwd')}`)
    ).status === 403,
  );
  results.check(
    '.git is not addressable',
    (await api.call(`/api/workspaces/${workspaceId}/file?path=${encodeURIComponent('.git/config')}`)).status === 403,
  );
  // `Number('abc')` is NaN, and NaN silently defeats every downstream cap.
  results.check(
    'a junk limit does not break the search',
    (await api.call(`/api/workspaces/${workspaceId}/search?q=hello&limit=abc`)).status === 200,
  );

  const git = await api.call(`/api/workspaces/${workspaceId}/git/status`);
  results.check('git status answers', git.status === 200 && typeof git.body.isRepo === 'boolean');
}

results.section('additionalDirectories policy');
{
  const grant = (directories) =>
    api.call(`/api/workspaces/${workspaceId}`, {
      method: 'PATCH',
      body: { settings: { additionalDirectories: directories } },
    });

  results.check('the data directory cannot be granted', (await grant([config.dataDir])).status === 400);
  results.check('the filesystem root cannot be granted', (await grant(['/'])).status === 400);

  const sibling = join(config.workspacesDir, 'shared-refs');
  mkdirSync(sibling, { recursive: true });
  results.check('a sibling under the workspaces root is allowed', (await grant([sibling])).status === 200);
  await grant([]);
}

results.section('MCP credentials');
{
  const created = await api.call('/api/mcp', {
    method: 'POST',
    body: {
      workspaceId,
      name: 'remote-tools',
      transport: 'http',
      url: 'https://mcp.example.test/v1',
      headers: { Authorization: 'Bearer e2e-super-secret' },
    },
  });
  results.check('an MCP server is created', created.status === 201, created.text.slice(0, 140));
  results.check('the response carries no header value', !JSON.stringify(created.body).includes('e2e-super-secret'));
  results.check('but does carry the header name', created.body.server.headerKeys.includes('Authorization'));
  results.check(
    'nor does the list',
    !(await api.call(`/api/mcp?workspaceId=${workspaceId}`)).text.includes('e2e-super-secret'),
  );

  // A blank value on re-save means "keep what is stored".
  await api.call('/api/mcp', {
    method: 'POST',
    body: {
      id: created.body.server.id,
      workspaceId,
      name: 'remote-tools-renamed',
      transport: 'http',
      url: 'https://mcp.example.test/v1',
      headers: { Authorization: '' },
    },
  });
  results.check(
    'renaming keeps the credential',
    context.registry.getMcpServer(created.body.server.id).headerKeys.includes('Authorization'),
  );

  const phantom = await api.call('/api/mcp', {
    method: 'POST',
    body: {
      id: 'mcp_does_not_exist',
      workspaceId,
      name: 'ghost',
      transport: 'stdio',
      command: 'x',
      env: { LEAKED: 'nope' },
    },
  });
  results.check('a phantom update is a 404', phantom.status === 404);
  results.check('and orphans no secrets', context.vault.listKeys('mcp:mcp_does_not_exist').length === 0);

  await api.call(`/api/mcp/${created.body.server.id}`, { method: 'DELETE' });
}

results.section('websocket: handshake, a live run, and resume');
let sessionId;
{
  const session = await api.call('/api/sessions', { method: 'POST', body: { workspaceId } });
  results.check('a session is created', session.status === 201);
  sessionId = session.body.session.id;
  const topic = sessionTopic(sessionId);

  const open = async () => {
    const socket = new WebSocket(server.wsUrl, { headers: { cookie: api.cookieHeader } });
    const seen = [];
    socket.on('message', (raw) => {
      const wire = parseWireFrame(JSON.parse(raw.toString('utf8')));
      if (wire) seen.push(wire);
    });
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'hello', csrfToken: api.csrfToken }));
    await until(() => seen.find((entry) => entry.frame.type === 'ready'), { what: 'ready' });
    return { socket, seen };
  };

  const first = await open();
  first.socket.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
  await until(() => first.seen.find((entry) => entry.frame.type === 'subscribed'), { what: 'subscribed' });

  console.log('  …  running a real agent through the Claude CLI');
  const started = Date.now();
  const submitted = await api.call(`/api/sessions/${sessionId}/runs`, {
    method: 'POST',
    body: { prompt: 'Reply with exactly the word MARQUEUR-E2E and nothing else.' },
  });
  results.check('the run is accepted', submitted.status === 202, submitted.text.slice(0, 200));

  const finished = await until(
    () =>
      first.seen
        .filter((entry) => entry.frame.type === 'run')
        .map((entry) => entry.frame.run)
        .find((run) => ['succeeded', 'failed', 'interrupted'].includes(run.status)),
    { timeoutMs: 240_000, everyMs: 200, what: 'the run to finish' },
  ).catch(() => null);

  results.check(
    `the run reaches a terminal state (${finished?.status ?? 'none'}, ${Math.round((Date.now() - started) / 1000)}s)`,
    finished !== null && finished.status !== 'failed',
    finished?.error ?? '',
  );

  const transcripts = first.seen.filter((entry) => entry.frame.type === 'transcript');
  results.check('transcript frames arrive over the socket', transcripts.length > 0);
  results.check('text streams as deltas', first.seen.some((entry) => entry.frame.type === 'delta'));
  results.check('every published frame carries a sequence', transcripts.every((entry) => entry.seq !== null));

  const cursor = Math.max(...first.seen.filter((entry) => entry.seq !== null).map((entry) => entry.seq));
  first.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Something happens while nobody is listening.
  context.bus.publish(topic, {
    type: 'notification',
    topic,
    level: 'info',
    title: 'while-you-were-out',
    message: 'x',
    href: null,
  });

  const second = await open();
  second.socket.send(JSON.stringify({ type: 'subscribe', topics: [topic], since: String(cursor) }));
  const subscribed = await until(
    () => second.seen.find((entry) => entry.frame.type === 'subscribed')?.frame,
    { what: 'subscribed' },
  );
  results.check('a reconnect replays the missed frame', subscribed.replayed === 1, `replayed=${subscribed.replayed}`);
  results.check(
    'and it is the right one',
    second.seen.some((entry) => entry.frame.title === 'while-you-were-out'),
  );
  second.socket.close();

  const fetched = await api.call(`/api/sessions/${sessionId}`);
  results.check('the reply is persisted', JSON.stringify(fetched.body.events).includes('MARQUEUR-E2E'));
  results.check('the session is no longer running', fetched.body.isRunning === false);
}

results.section('learning');
{
  const run = (await api.call(`/api/runs?workspaceId=${workspaceId}`)).body.runs[0];
  results.check('the run was recorded', Boolean(run));

  if (run) {
    results.check(
      'a run can be rated',
      (await api.call(`/api/runs/${run.id}/rate`, { method: 'POST', body: { rating: 1 } })).status === 200,
    );
  }

  const memory = await api.call('/api/memory', {
    method: 'POST',
    body: {
      workspaceId,
      kind: 'semantic',
      title: 'E2E convention',
      content: 'The end-to-end marker for this suite is MARQUEUR-E2E.',
    },
  });
  results.check('a memory can be stored', memory.status === 201, memory.text.slice(0, 120));
  results.check(
    'and retrieved by meaning',
    (await api.call(`/api/memory/search?q=${encodeURIComponent('end-to-end marker')}`)).body.results.length > 0,
  );

  const preview = await api.call('/api/policy/preview', {
    method: 'POST',
    body: { prompt: 'Fix the failing test in the parser', workspaceId },
  });
  results.check(
    'the policy preview explains its choice',
    preview.status === 200 && typeof preview.body.classification.category === 'string',
  );
}

results.section('automations');
{
  const created = await api.call('/api/automations', {
    method: 'POST',
    body: {
      workspaceId,
      name: 'E2E nightly',
      prompt: 'Say OK.',
      trigger: { type: 'cron', expression: '0 3 * * *' },
    },
  });
  results.check('an automation is created', created.status === 201, created.text.slice(0, 140));
  results.check('with its next run computed', typeof created.body.automation.nextRunAt === 'number');
  results.check(
    'and the model left to the learner',
    created.body.automation.policy.model === 'default',
  );
  results.check(
    'an invalid cron is rejected',
    (
      await api.call('/api/automations', {
        method: 'POST',
        body: { workspaceId, name: 'broken', prompt: 'x', trigger: { type: 'cron', expression: 'not a cron' } },
      })
    ).status === 400,
  );
}

results.section('audit');
{
  const audit = await api.call('/api/audit?limit=100');
  results.check('the owner can read it', audit.status === 200);
  const actions = audit.body.entries.map((entry) => entry.action);
  results.check('a login is recorded', actions.includes('auth.login'));
  results.check('a 2FA enrolment is recorded', actions.includes('auth.totp.begin'));
  results.check('a workspace creation is recorded', actions.includes('workspace.create'));
  results.check('the hash chain verifies', (await api.call('/api/audit/verify')).body.ok === true);
  results.check(
    'junk pagination does not 500',
    (await api.call('/api/audit?limit=abc&before=yesterday')).status === 200,
  );
}

const code = results.finish();
await server.stop();
process.exit(code);

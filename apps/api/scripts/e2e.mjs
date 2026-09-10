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
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_CHECKS_ENABLED, Client, PASSWORD, Results, startServer, until } from './harness.mjs';

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

  if (AGENT_CHECKS_ENABLED) {
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
  } else {
    results.skip('a live agent run', 'no Claude credentials (METACLAUDE_E2E_NO_AGENT)');
    // The resume check below needs a cursor, so give it something real to
    // resume from. This exercises the same code path the run would have.
    context.bus.publish(topic, {
      type: 'notification',
      topic,
      level: 'info',
      title: 'before-the-drop',
      message: 'x',
      href: null,
    });
    await until(() => first.seen.some((entry) => entry.frame.type === 'notification'), {
      what: 'the seed frame',
    });
  }

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
  if (AGENT_CHECKS_ENABLED) {
    results.check('the reply is persisted', JSON.stringify(fetched.body.events).includes('MARQUEUR-E2E'));
  }
  results.check('the session is no longer running', fetched.body.isRunning === false);
}

results.section('learning');
{
  const run = (await api.call(`/api/runs?workspaceId=${workspaceId}`)).body.runs[0];
  if (AGENT_CHECKS_ENABLED) {
    results.check('the run was recorded', Boolean(run));
    if (run) {
      results.check(
        'a run can be rated',
        (await api.call(`/api/runs/${run.id}/rate`, { method: 'POST', body: { rating: 1 } })).status === 200,
      );
    }
  } else {
    results.skip('run recording and rating', 'no run was performed');
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

/**
 * What a run did with what it was given.
 *
 * The "only observable end to end" case, and the reason this section exists at
 * all: the tool the CLI calls to open a skill is undeclared by the SDK — its
 * `ToolInputSchemas` union has an entry for every other built-in and none for
 * `Skill` — and the tool it calls to delegate is `Agent`, not the `Task` this
 * repository believed in for four releases. Both names were *measured*, and a
 * unit test can only ever re-assert the measurement: it drives a fixture built
 * from the same belief. If a CLI renames either, nothing but a real run will
 * say so, and the whole of loop four goes quietly blind.
 *
 * So: a skill this workspace offers, a prompt that names it, and a row that
 * has to say it was invoked.
 */
results.section('what serves each learning pass');
{
  // The twelve keys the Configuration screen draws. Unit tests cover the
  // catalogue and the resolution; what only the running server can answer is
  // whether the route accepts them at all — a key declared in the shared enum
  // and refused at the edge would be a picker that saves nothing.
  const pin = await api.call('/api/system/settings/reflexionModel', {
    method: 'PUT',
    body: { value: 'fable' },
  });
  results.check('a learning pass can be pinned to a model', pin.status === 200);

  const listed = (await api.call('/api/system/settings')).body.settings ?? [];
  const row = listed.find((entry) => entry.key === 'reflexionModel');
  results.check(
    'the pin is in force and says where it came from',
    row?.value === 'fable' && row?.source === 'stored',
    JSON.stringify({ value: row?.value, source: row?.source }),
  );
  results.check(
    'the picker offers auto but not the CLI alias',
    row?.options?.includes('auto') === true && row?.options?.includes('default') === false,
    (row?.options ?? []).join(','),
  );

  // `default` means Opus on a subscription; offering it beside `auto` would be
  // two words that read alike at thirty times the price, so the server refuses
  // it rather than trusting the screen not to send it.
  const alias = await api.call('/api/system/settings/reflexionModel', {
    method: 'PUT',
    body: { value: 'default' },
  });
  results.check('the CLI alias is refused, not merely unlisted', alias.status === 400, String(alias.status));

  // `null` on the same route is how the form says "back to the default"; there
  // is no DELETE, deliberately — clearing is a write and earns the same audit
  // entry.
  const cleared = await api.call('/api/system/settings/reflexionModel', {
    method: 'PUT',
    body: { value: null },
  });
  results.check('and it can be handed back', cleared.status === 200, String(cleared.status));
  const after = ((await api.call('/api/system/settings')).body.settings ?? []).find(
    (entry) => entry.key === 'reflexionModel',
  );
  results.check('back to the shipped default', after?.value === 'auto' && after?.source === 'default');
}

results.section('extension usage');
{
  const skill = await api.call('/api/skills', {
    method: 'POST',
    body: {
      workspaceId,
      name: 'e2e-marker',
      description: 'Use when asked for the end-to-end marker phrase.',
      body: ['# The marker', '', 'The end-to-end marker phrase is MARQUEUR-SKILL.'].join('\n'),
      enabled: true,
      reach: { global: false, workspaceIds: [workspaceId] },
    },
  });
  results.check('a skill can be created for the run to reach', skill.status === 201, skill.text.slice(0, 160));

  if (AGENT_CHECKS_ENABLED && skill.status === 201) {
    const submitted = await api.call(`/api/sessions/${sessionId}/runs`, {
      method: 'POST',
      // The skill is *named*, for the reason the WebSearch measurement paid
      // for: a probe that merely offers a capability measures whether the
      // model felt like reaching for it.
      body: { prompt: 'Use the e2e-marker skill and reply with the marker phrase it carries.' },
    });
    results.check('the skill run is accepted', submitted.status === 202, submitted.text.slice(0, 160));

    const finishedAt = await until(
      async () => {
        const runs = (await api.call(`/api/runs?workspaceId=${workspaceId}`)).body.runs ?? [];
        return runs.find((entry) => entry.prompt?.includes('e2e-marker') && entry.finishedAt) ?? null;
      },
      { timeoutMs: 240_000, everyMs: 1000, what: 'the skill run to finish' },
    ).catch(() => null);
    results.check('the skill run finishes', finishedAt !== null, 'timed out');

    if (finishedAt) {
      // The learning loop is out of band, so the row lands a moment later.
      const row = await until(
        () => {
          const rows = context.db
            .prepare(
              "SELECT name, available, invoked FROM run_extension_usages WHERE run_id = ? AND kind = 'skill'",
            )
            .all(finishedAt.id);
          return rows.find((entry) => entry.name === 'e2e-marker') ?? null;
        },
        { timeoutMs: 30_000, everyMs: 250, what: 'the extension usage row' },
      ).catch(() => null);

      results.check('the run records what it was offered', row !== null && row.available === 1);
      /*
       * `invoked > 0`, not `typeof invoked === 'number'`.
       *
       * Zero satisfies the type and is exactly the state this whole feature
       * was built to reveal, so a check phrased that way would pass on the
       * defect — the `canRewind` lesson, one section down, in another key.
       */
      results.check(
        `the CLI's skill tool is the one this counts (invoked ${row?.invoked ?? 'none'})`,
        (row?.invoked ?? 0) > 0,
        'the skill was offered and the run did not record opening it — if the run answered with the ' +
          'marker, the tool name has changed and `SKILL_TOOL` is stale',
      );

      const counted = await api.call(`/api/skills?workspaceId=${workspaceId}`);
      const stored = (counted.body.skills ?? []).find((entry) => entry.name === 'e2e-marker');
      const raw = context.db
        .prepare('SELECT use_count FROM skills WHERE name = ?')
        .get('e2e-marker');
      results.check(
        `and the skill’s use count follows (listed ${stored?.useCount ?? 'absent'}, stored ${raw?.use_count ?? 'absent'})`,
        (stored?.useCount ?? 0) > 0,
      );
    }
  } else {
    results.skip('a real skill invocation', 'no Claude credentials (METACLAUDE_E2E_NO_AGENT)');
  }
}

/**
 * Rewind.
 *
 * The unit tests drive a fake `query`, so what they cannot prove is the part
 * that only exists once a real CLI is on the other end: that the anchor uuid is
 * actually delivered on the wire, and that resuming a finished session is
 * enough to reach its checkpoints. That is exactly the "only observable end to
 * end" case, so the real restore runs only with an agent — while the guards
 * around it are checked either way, because a 500 on a malformed body or a
 * silent success for an operator are bugs regardless.
 */
results.section('rewind');
{
  const run = (await api.call(`/api/runs?workspaceId=${workspaceId}`)).body.runs[0];

  results.check(
    'a malformed body is a 400, not a 500',
    (await api.call('/api/runs/run_missing/rewind', { method: 'POST', body: { dryRun: 'yes' } }))
      .status === 400,
  );

  const unknown = await api.call('/api/runs/run_missing/rewind', {
    method: 'POST',
    body: { dryRun: true },
  });
  results.check(
    'an unknown run refuses rather than throwing',
    unknown.status === 200 && unknown.body.canRewind === false,
    unknown.text.slice(0, 140),
  );

  if (AGENT_CHECKS_ENABLED && run) {
    results.check('the run recorded an anchor to rewind to', typeof run.rewindPoint === 'string');

    const preview = await api.call(`/api/runs/${run.id}/rewind`, {
      method: 'POST',
      body: { dryRun: true },
    });
    results.check(
      'a preview answers without applying',
      preview.status === 200 && preview.body.applied === false,
      preview.text.slice(0, 200),
    );
    /*
     * `canRewind` must be *true*, not merely a boolean.
     *
     * The first version of this asserted `typeof … === 'boolean'`, which false
     * satisfies — so it would have passed on a rewind the CLI refuses, which
     * is exactly the state this suite was in: the anchor was never recorded,
     * and the only check that could have said so accepted "no" as an answer.
     * The whole point of running a live agent here is that the CLI agrees the
     * point is restorable; anything weaker is a test of our own plumbing.
     */
    results.check(
      'and the CLI agrees the anchor is restorable',
      preview.body.canRewind === true,
      preview.body.error ?? preview.text.slice(0, 200),
    );
  } else {
    results.skip('rewinding a real run', 'no run was performed');
  }
}

/**
 * Claude's own catalogue.
 *
 * Reading it spawns a CLI session, so the substance needs an agent. The shape
 * does not: a caller naming a workspace that does not exist, and the cache
 * serving a second request without a second subprocess, are both checkable
 * against the real server either way.
 */
results.section("claude's catalogue");
{
  results.check(
    'an unknown workspace is a 404, not an empty catalogue',
    (await api.call('/api/claude/catalogue?workspaceId=ws_missing')).status === 404,
  );

  if (AGENT_CHECKS_ENABLED) {
    const first = await api.call(`/api/claude/catalogue?workspaceId=${workspaceId}`);
    results.check('the catalogue reads', first.status === 200, first.text.slice(0, 200));
    results.check('it reports models', Array.isArray(first.body.models));
    results.check(
      'it says what it could not answer',
      Array.isArray(first.body.unavailable),
      JSON.stringify(first.body.unavailable),
    );

    const second = await api.call(`/api/claude/catalogue?workspaceId=${workspaceId}`);
    results.check(
      'a second read is served from the cache',
      second.body.fetchedAt === first.body.fetchedAt,
    );
    results.check(
      'and refresh=true bypasses it',
      (await api.call(`/api/claude/catalogue?workspaceId=${workspaceId}&refresh=true`)).body
        .fetchedAt !== first.body.fetchedAt,
    );
  } else {
    results.skip("reading Claude's catalogue", 'needs a live CLI');
  }
}

results.section('the two guided credential flows are told apart');
{
  /*
   * Two credentials, two homes: a setup token asks for inference and is sealed
   * in the vault; an account sign-in asks for the scopes an interactive
   * `claude auth login` asks for and is installed in the CLI's own store.
   * Only the second reports plan quota, and only the second can be renewed at
   * all — which is why finishing one flow as the other would be a silent
   * downgrade rather than an error.
   *
   * What this reaches that no unit test does is the edge: the route, the
   * schema that decides what may be submitted, and the link the browser is
   * actually handed. Nothing here leaves the machine — beginning an attempt
   * builds a URL, it does not call Anthropic.
   */
  const scopeOf = (link) => new URL(link).searchParams.get('scope');

  const token = await api.call('/api/claude/pairing', { method: 'POST', body: {} });
  results.check('a pairing attempt starts', token.status === 200, token.text.slice(0, 200));
  results.check('and it defaults to a setup token', token.body.kind === 'token');
  results.check(
    'which asks for inference alone',
    scopeOf(token.body.url) === 'user:inference',
    scopeOf(token.body.url),
  );

  const account = await api.call('/api/claude/pairing', {
    method: 'POST',
    body: { kind: 'account' },
  });
  results.check('an account sign-in starts', account.status === 200, account.text.slice(0, 200));
  results.check('and says so', account.body.kind === 'account');
  results.check(
    'asking for the session scope a token can never carry',
    (scopeOf(account.body.url) ?? '').split(' ').includes('user:sessions:claude_code'),
    scopeOf(account.body.url),
  );
  results.check(
    'the link is the manual one this server can actually complete',
    new URL(account.body.url).searchParams.get('redirect_uri') ===
      'https://platform.claude.com/oauth/code/callback',
  );

  // One attempt at a time, and cancelling has to clear the kind with it: a
  // stale kind is how a code gets finished as the wrong credential.
  const cancelled = await api.call('/api/claude/pairing', { method: 'DELETE' });
  results.check('cancelling clears it', cancelled.body.active === false && cancelled.body.kind === null);

  const refused = await api.call('/api/claude/pairing', {
    method: 'POST',
    body: { kind: 'signin' },
  });
  results.check('an unknown kind is refused at the edge', refused.status === 400, String(refused.status));
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

results.section('the knowledge library reads files');
{
  // The one place the *worker* runs against the built server: unit tests
  // drive the extraction on their own thread, because a worker loads a built
  // file that does not exist while a suite runs from TypeScript. Here it is
  // the real one, spawned by the real route, over a real HTTP request.
  const fixture = (name) =>
    readFileSync(new URL(`../src/learning/extract/fixtures/${name}`, import.meta.url));

  const upload = (name, extra = {}) =>
    api.call('/api/knowledge/upload', {
      method: 'POST',
      body: {
        name,
        mime: '',
        data: fixture(name).toString('base64'),
        reach: { global: true, workspaceIds: [] },
        ...extra,
      },
    });

  const docx = await upload('bail.docx');
  results.check(
    'a dropped .docx becomes a document, sectioned and located',
    docx.status === 201 && /^docx@/.test(docx.body.document?.source?.extractor ?? ''),
    JSON.stringify(docx.body).slice(0, 300),
  );

  const hits = await api.call(
    `/api/knowledge/search?q=${encodeURIComponent('préavis résiliation')}`,
  );
  const passage = hits.body.results?.[0];
  results.check(
    'its passages carry the section and the lines they came from',
    passage?.heading === 'Résiliation par le locataire' && passage?.lineStart > 0,
    JSON.stringify(passage).slice(0, 300),
  );

  const pdf = await upload('twocol.pdf');
  const engine = pdf.body.document?.source?.extractor ?? '';
  results.check(
    'a two-column PDF becomes a paged document',
    pdf.status === 201 && pdf.body.document?.pageUnit === 'page',
    JSON.stringify(pdf.body.document?.source ?? pdf.body).slice(0, 300),
  );
  // Which engine answered is a property of the host, and the product says so
  // rather than hiding it. The image installs poppler-utils, so on CI and in
  // production this is the poppler branch; a developer's machine without it
  // gets the fallback, *named*, which is the behaviour worth checking there.
  if (/^pdf@poppler-/.test(engine)) {
    results.check('and poppler is what read it', true, engine);
  } else {
    results.skip(
      'poppler read it',
      `this host has no poppler; the API fell back and named it (${engine || 'nothing'})`,
    );
  }

  const again = await upload('twocol.pdf');
  results.check(
    'the same file a second time is refused, naming the document that holds it',
    again.status === 409 && again.body.document?.id === pdf.body.document?.id,
    `status ${again.status}`,
  );

  const scan = await upload('scan.pdf');
  results.check(
    'a scan is refused by saying it is one',
    scan.status === 422 && /scan|OCR/i.test(scan.body.error ?? ''),
    `${scan.status}: ${scan.body.error}`,
  );

  const source = await api.call(`/api/knowledge/${pdf.body.document.id}/source`, { raw: true });
  results.check(
    'the original comes back byte for byte',
    source.status === 200 && Buffer.from(source.bytes).equals(fixture('twocol.pdf')),
    `status ${source.status}, ${source.bytes?.byteLength ?? 0} bytes`,
  );

  const extracted = await api.call(`/api/knowledge/${pdf.body.document.id}/extract`, {
    method: 'POST',
  });
  results.check(
    'and can be read again, which is how an extractor improvement reaches it',
    extracted.status === 200 && extracted.body.document?.chunkCount > 0,
    `status ${extracted.status}`,
  );
}

results.section('retrieval');
{
  const system = await api.call('/api/system');
  const retrieval = system.body.retrieval ?? {};
  results.check(
    'the health endpoint says what retrieval is',
    ['hash', 'st'].includes(retrieval.family) && ['ready', 'loading', 'lexical-only'].includes(retrieval.state),
    JSON.stringify(retrieval),
  );
  results.check(
    'semantic is claimed only by a ready sentence-transformer',
    retrieval.semantic === (retrieval.family === 'st' && retrieval.state === 'ready'),
  );
  // Only where the shipped model is actually present (CI fetches it once):
  // the model loads, and a question sharing no word with its answer finds it.
  if (process.env.METACLAUDE_E2E_EXPECT_SEMANTIC === '1') {
    const ready = await until(
      async () => (await api.call('/api/system')).body.retrieval?.semantic === true,
      { timeoutMs: 240_000, everyMs: 2_000, what: 'the embedding model to load' },
    ).catch(() => false);
    results.check('the shipped model loads and retrieval becomes semantic', ready === true);
    const saved = await api.call('/api/knowledge', {
      method: 'POST',
      body: {
        workspaceId: null,
        title: 'Bail',
        content:
          'Le délai de préavis est de trois mois, réduit à un mois en zone tendue.\n\n' +
          'Le dépôt de garantie est restitué dans un délai de deux mois après la remise des clés.\n\n' +
          'Les grosses réparations, dont le remplacement de la chaudière, restent à la charge du bailleur.',
      },
    });
    results.check('a document is saved and embedded inline', saved.status === 201 && saved.body.document?.embeddingModel?.startsWith('st:'));
    const hits = await api.call(`/api/knowledge/search?q=${encodeURIComponent('puis-je partir avant la fin sans pénalité ?')}`);
    results.check(
      'a question sharing no word with its answer finds the passage',
      hits.status === 200 && hits.body.results?.[0]?.text?.includes('préavis'),
      JSON.stringify(hits.body.results?.map((hit) => hit.text.slice(0, 40))),
    );
  }
}

results.section('the gateway reaches the deployment, not one drawer of it');
{
  /*
   * The release this section exists for, replayed against a real server.
   *
   * Measured in production first: an application asked a question through the
   * gateway whose answer was a pinned note of *another* workspace, and was told
   * this Metaclaude did not know — the run called no tool at all, because a
   * gateway run had none that reached outside its own workspace.
   *
   * Nothing below can be proved by a unit test. Whether the tools are mounted
   * and pre-approved is decided by `buildOptions` against real settings; whether
   * the model then *reaches for them* is decided by the model, and only a live
   * run answers that.
   */
  const { Client: McpClient } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/sdk/client/streamableHttp.js'
  );

  const peer = await api.call('/api/workspaces', {
    method: 'POST',
    body: { name: 'Voisin', description: 'Le projet voisin : il tient les repères de mesure.' },
  });
  const peerId = peer.body.workspace?.id;
  results.check('a second workspace exists to be consulted', Boolean(peerId));

  const workspaceSlug = (await api.call(`/api/workspaces/${workspaceId}`)).body.workspace?.slug;

  // A note in the token's *own* workspace, for the direct read below.
  await context.memory.remember({
    workspaceId,
    kind: 'semantic',
    title: 'Le repère de la mesure locale',
    content: 'Le repère de la mesure locale vaut MARQUEUR-LOCAL-4412.',
  });

  // The fact, and two neighbours so the lexical arm has a corpus: bm25's IDF is
  // zero for a term present in one row of two, and clamped on a single row.
  await context.memory.remember({
    workspaceId: peerId,
    kind: 'semantic',
    title: 'Le repère de la mesure amont',
    content: 'Le repère de la mesure amont vaut MARQUEUR-VOISIN-7391.',
  });
  await context.memory.remember({
    workspaceId: peerId,
    kind: 'semantic',
    title: 'Les horaires du voisin',
    content: 'Le projet voisin livre ses mesures le mardi matin.',
  });
  await context.memory.remember({
    workspaceId: null,
    kind: 'procedural',
    title: 'Convention de citation',
    content: 'Citer la source de toute affirmation chiffrée.',
  });

  const minted = await api.call('/api/tokens', {
    method: 'POST',
    body: {
      name: 'e2e outside app',
      scopes: ['run', 'read'],
      // The first workspace only. Reaching the neighbour is the workspace's own
      // business, not the token's — which is the whole point.
      workspaceIds: [workspaceId],
      ceiling: 'dontAsk',
      expiresInDays: 1,
    },
  });
  const secret = minted.body?.secret;
  results.check('a token is minted for one workspace', typeof secret === 'string' && secret.length > 20);

  const connect = async () => {
    const client = new McpClient({ name: 'e2e-outside-app', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${server.baseUrl}/api/gateway/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${secret}` } },
      }),
    );
    return client;
  };

  {
    const client = await connect();
    const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
    results.check(
      'the gateway offers exactly its six tools',
      JSON.stringify(listed) ===
        JSON.stringify(['ask_workspace', 'list_tasks', 'list_workspaces', 'run_status', 'search_notes', 'start_run']),
      listed.join(', '),
    );

    // No workspace named: a calling program does not know where a fact is filed
    // and is not supposed to. This reads the stores directly, so it holds
    // whether or not a live agent is available.
    const found = await client.callTool({
      name: 'search_notes',
      arguments: { query: 'le repère de la mesure locale' },
    });
    const hits = JSON.parse(found.content[0].text);
    const marker = Array.isArray(hits)
      ? hits.find((hit) => hit.text?.includes('MARQUEUR-LOCAL-4412'))
      : null;
    results.check(
      'search_notes finds a note without being told which workspace holds it',
      Boolean(marker),
      JSON.stringify(hits).slice(0, 300),
    );
    results.check(
      'and says it is a note, from the workspace that holds it',
      marker?.kind === 'memory' && marker?.workspace === workspaceSlug,
      JSON.stringify(marker ?? null),
    );

    /*
     * And it stops at the grant — the asymmetry worth stating out loud.
     *
     * `search_notes` is the *token's* own read, so the workspaces it names plus
     * the global shelf is exactly its reach. `ask_workspace` is different in
     * kind: it puts an agent to work inside a granted workspace, and that agent
     * consults whom that workspace's settings let it consult. So the free path
     * is narrower than the paid one, deliberately: a capability is bounded by
     * what it was granted, a worker by where it works.
     */
    const beyond = await client.callTool({
      name: 'search_notes',
      arguments: { query: 'le repère de la mesure amont' },
    });
    const outside = JSON.parse(beyond.content[0].text);
    results.check(
      'and reads no further than the token was granted',
      Array.isArray(outside) && !outside.some((hit) => hit.text?.includes('MARQUEUR-VOISIN-7391')),
      JSON.stringify(outside).slice(0, 300),
    );
    await client.close();
  }

  if (AGENT_CHECKS_ENABLED) {
    console.log('  …  asking a gateway run for a fact only another workspace holds');
    const client = await connect();
    const started = Date.now();
    const answered = await client.callTool({
      name: 'ask_workspace',
      arguments: {
        workspace: workspaceId,
        prompt:
          'Quel est le repère de la mesure amont ? Il n’est pas dans ton propre espace de travail. ' +
          'Réponds uniquement avec le repère exact, sans rien inventer.',
      },
    });
    const answer = JSON.parse(answered.content[0].text);
    results.check(
      `a gateway run answers from another workspace (${Math.round((Date.now() - started) / 1000)}s)`,
      typeof answer.text === 'string' && answer.text.includes('MARQUEUR-VOISIN-7391'),
      JSON.stringify(answer).slice(0, 400),
    );

    // What it *did*, not only what it said: the point of the release is that the
    // run had a tool and used it. A right answer with no tool call would mean
    // the model guessed, and the check would be passing on nothing.
    const runs = context.runRepo.listRecent({ limit: 20 });
    const gatewayRun = runs.find((run) => run.id === answer.runId);
    const calls = gatewayRun
      ? context.transcriptRepo
          .byRun(gatewayRun.id)
          .filter((event) => event.kind === 'tool_call')
          .map((event) => event.name)
      : [];
    const reached = calls.filter(
      (name) => String(name).includes('search_workspaces') || String(name).includes('delegate'),
    );
    results.check(
      `and it got there by calling a tool rather than by guessing (${reached.join(', ') || 'none'})`,
      reached.length > 0,
      calls.join(', ') || 'no tool call',
    );
    await client.close();
  } else {
    results.skip('a gateway run reaching another workspace', 'no Claude credentials (METACLAUDE_E2E_NO_AGENT)');
  }
}

const code = results.finish();
await server.stop();
process.exit(code);

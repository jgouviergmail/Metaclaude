#!/usr/bin/env node
/**
 * What the agent actually writes to memory, measured.
 *
 * The memory gate judges what the *automatic* pass proposes. The agent's own
 * `memory_write` is judged by nothing but the tool's description — a
 * deliberate decision (a note written because the operator just said something
 * is not the speculative noise the gate exists to stop, and a model call per
 * note would make the tool unusable mid-conversation) and therefore a decision
 * that has to be measured rather than asserted. The corpus's other defences —
 * near-duplicate merge, decay, collect, consolidation — all run *after* the
 * write, so nothing at write time stops an eager agent turning every exchange
 * into a memory.
 *
 * So: a real server, the real CLI, the real tool descriptions, and a scripted
 * conversation modelled on the one that started all this — a personal
 * assistant, half of whose turns carry something durable and half of which
 * carry nothing at all. What is reported is discrimination, not volume: how
 * many of the turns that should be remembered were, and how many of the turns
 * that should not be were anyway.
 *
 * Not a test: it spawns the Claude CLI and costs a few cents. Build first:
 *
 *   pnpm build
 *   node scripts/eval-memory-tool.mjs
 *
 * Exit status is non-zero when a turn carrying nothing durable still produced
 * a memory, or when a turn carrying something durable produced none.
 */

import { Client, PASSWORD, USERNAME, startServer, until } from './harness.mjs';

/**
 * The conversation. `durable` says whether a careful person would expect this
 * turn to leave something behind — the answer the measurement is scored on.
 *
 * Deliberately mixed and deliberately mundane: the failure this is looking for
 * is not "the agent refuses to write" but "the agent writes after every turn",
 * so the turns that carry nothing outnumber nothing and are phrased exactly as
 * the real conversation phrased them.
 */
const TURNS = [
  { say: 'Salut, je m’appelle Jérôme.', durable: true, why: 'the operator’s name' },
  { say: 'OK, petit bilan de la semaine ?', durable: false, why: 'a request, not a fact' },
  {
    say: 'Mathéo est mon fils, il est au lycée en première scientifique.',
    durable: true,
    why: 'who the family is',
  },
  { say: 'Ça va, ce n’est pas loin, il y va soit à pied soit en bus.', durable: false, why: 'small talk' },
  {
    say: 'Tous les lundis de 18h30 à 20h il a son cours de tennis.',
    durable: true,
    why: 'a recurring commitment',
  },
  { say: 'Pas de sujet sur ces deux emails.', durable: false, why: 'about this conversation only' },
  { say: 'Merci, c’est parfait.', durable: false, why: 'nothing at all' },
];

const RUN_TIMEOUT_MS = 300_000;

async function main() {
  /*
   * The harness's own timeouts, deliberately.
   *
   * Raising `METACLAUDE_RUN_TIMEOUT_MS` to ten minutes — so the open-ended turn
   * could run to completion — produced a boot that never finished: the data
   * directory was created and the migrations never committed, and the probe sat
   * there for forty-six minutes writing nothing. Unexplained, and not worth
   * explaining, because the scoring below no longer needs it: a turn that did
   * not reach `succeeded` is excluded from the score and named in the report
   * rather than counted as an abstention.
   */
  const server = await startServer({ env: { METACLAUDE_EMBEDDINGS: 'hash' } });
  const api = new Client(server.baseUrl);
  await api.login(USERNAME, PASSWORD);

  const created = await api.call('/api/workspaces', {
    method: 'POST',
    body: { name: 'Personnel', description: 'assistant personnel' },
  });
  if (created.status !== 201) throw new Error(`workspace: ${created.text.slice(0, 200)}`);
  const workspaceId = created.body.workspace.id;

  /*
   * Reflexion off, or this measures two writers at once.
   *
   * The post-run pass writes memories too, asynchronously, and a lesson it
   * files while the *next* turn is running is attributed to that turn by any
   * counter that watches the table. It happened: a `procedural` row reading
   * "Weekly summary requires external data sources" — unmistakably a reflexion
   * lesson — was scored as something the agent had written. What is under test
   * here is the tool, which has no judge; the pass has one and is measured by
   * `eval-memory-gate.mjs`.
   */
  await api.call(`/api/workspaces/${workspaceId}`, {
    method: 'PATCH',
    body: { settings: { ...created.body.workspace.settings, reflexionEnabled: false } },
  });

  const session = await api.call('/api/sessions', { method: 'POST', body: { workspaceId } });
  const sessionId = session.body.session.id;

  const memoriesNow = () =>
    server.context.memory.list({ workspaceId, includeRetired: true }).filter((m) => m.workspaceId === workspaceId);

  const rows = [];
  let seen = 0;

  for (const [index, turn] of TURNS.entries()) {
    const submitted = await api.call(`/api/sessions/${sessionId}/runs`, {
      method: 'POST',
      body: { prompt: turn.say },
    });
    if (submitted.status !== 202) throw new Error(`turn ${index + 1}: ${submitted.text.slice(0, 200)}`);
    const runId = submitted.body.run.id;

    const finished = await until(
      async () => {
        const run = (await api.call(`/api/runs/${runId}`)).body?.run;
        return run && ['succeeded', 'failed', 'interrupted'].includes(run.status) ? run : null;
      },
      { timeoutMs: RUN_TIMEOUT_MS, everyMs: 500, what: `turn ${index + 1} to finish` },
    );

    // The tool calls this turn made, straight from the transcript: the write
    // is what is being measured, not the answer.
    const events = server.context.transcriptRepo.byRun(runId);
    const calls = events
      .filter((event) => event.kind === 'tool_call' && event.name.startsWith('mcp__metaclaude_memory__'))
      .map((event) => event.name.replace('mcp__metaclaude_memory__', ''));

    const after = memoriesNow();
    const added = after.slice(0, Math.max(0, after.length - seen));
    seen = after.length;

    /*
     * A write that produced no new row is an *edit* — the agent correcting a
     * memory by id, or `remember` folding a near-duplicate — which is the
     * instructed behaviour and not the same thing as writing nothing. The
     * first version of this script counted the two together and would have
     * scored an obedient turn as an abstention.
     */
    const writes = calls.filter((name) => name === 'memory_write').length;
    const edits = Math.max(0, writes - added.length);

    rows.push({ ...turn, index: index + 1, status: finished.status, calls, added, edits });
    process.stdout.write(
      `  turn ${index + 1}  ${finished.status.padEnd(9)} ` +
        `tools=[${calls.join(', ')}] wrote=${added.length} edited=${edits}  ` +
        `${JSON.stringify(turn.say.slice(0, 40))}` +
        `${finished.error ? `  !! ${finished.error.slice(0, 100)}` : ''}\n`,
    );
  }

  /* ------------------------------- report ------------------------------- */

  console.log('\n=== what was written ===');
  for (const memory of memoriesNow()) {
    console.log(`  · [${memory.kind}/${memory.shelf}] ${memory.title}`);
    console.log(`      ${memory.content.replace(/\s+/g, ' ').slice(0, 140)}`);
  }

  /*
   * A turn that did not finish measured nothing, and must not be scored.
   *
   * The first version counted an interrupted turn as an abstention, so a run
   * the harness killed at its own time limit read as the agent correctly
   * declining to write — a check that cannot tell "the guard held" from "the
   * turn never ran". It is reported separately, and loudly, because a
   * measurement over a shrinking sample has to say the sample shrank.
   */
  const scored = rows.filter((row) => row.status === 'succeeded');
  const lost = rows.filter((row) => row.status !== 'succeeded');
  const missed = scored.filter((row) => row.durable && row.added.length + row.edits === 0);
  const spurious = scored.filter((row) => !row.durable && row.added.length > 0);
  const wrote = rows.reduce((sum, row) => sum + row.added.length, 0);

  console.log('\n=== discrimination ===');
  console.log(`  turns scored:          ${scored.length} of ${rows.length} (${scored.filter((r) => r.durable).length} durable)`);
  if (lost.length > 0) {
    console.log(
      `  turns that measured nothing: ${lost.map((r) => `${r.index} (${r.status})`).join(', ')}`,
    );
  }
  console.log(`  memories written:      ${wrote}`);
  console.log(`  durable turns missed:  ${missed.length}  ${missed.map((r) => r.index).join(', ')}`);
  console.log(`  idle turns that wrote: ${spurious.length}  ${spurious.map((r) => r.index).join(', ')}`);

  await server.stop();
  if (spurious.length > 0 || missed.length > 0) {
    console.log('\n  The tool description alone is not enough. See the entry in CLAUDE.md.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

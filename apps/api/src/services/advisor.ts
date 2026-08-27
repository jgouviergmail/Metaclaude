/**
 * The advisor — the part of Metaclaude that studies itself and proposes.
 *
 * One run, composed here: the service assembles a dossier of the workspace's
 * actual state (recent runs and their failures, the board, automations,
 * skills, agents, MCP servers, what the library still holds) and submits it
 * as a session the operator can read like any other. The run acts through
 * graduated autonomy:
 *
 *  - **Tickets** it creates directly, with the board tools every run already
 *    has — a backlog card is inert until someone works it.
 *  - **Automations** it creates directly but *disabled* — inert until the
 *    operator flips the switch on the Automations page.
 *  - **Skills, agents, MCP servers and plugins** go to the inbox
 *    (`advisor_proposals`): each would act the moment it existed, so it does
 *    not exist until a person accepts it — and an accepted skill, agent or
 *    MCP server is still created *disabled*, the library's own contract.
 *
 * MCP proposals face one more gate: an embedded allowlist of publishers.
 * The advisor searches the open web, and a page that says "add this MCP
 * server" is exactly how prompt injection would try to walk in; the server
 * checks the proposal against publishers this repository vouches for and
 * refuses the rest, whatever the run believes.
 */

import type { AdvisorProposal, Automation, BoardTask, Run, Workspace } from '@metaclaude/shared';
import { newId } from '@metaclaude/shared';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import type { LibraryService } from '../library/service.js';
import type { Registry } from './registry.js';
import type { Scheduler } from './scheduler.js';

export class AdvisorError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'AdvisorError';
  }
}

/* -------------------------------------------------------------------------- */
/* The trusted-publisher allowlist                                             */
/* -------------------------------------------------------------------------- */

/**
 * MCP publishers this repository vouches for. Curated in code, like the
 * library: extending it is a reviewed commit, not a runtime discovery — that
 * is the entire defence, so nothing the advisor reads on the web can widen it.
 */
export const TRUSTED_MCP_PUBLISHERS: ReadonlyArray<{
  publisher: string;
  /** npm scopes whose packages the publisher signs (stdio servers). */
  npmScopes: readonly string[];
  /** Hosts the publisher serves remote MCP from (sse/http servers). */
  urlHosts: readonly string[];
}> = [
  { publisher: 'Anthropic', npmScopes: ['@anthropic-ai', '@modelcontextprotocol'], urlHosts: [] },
  { publisher: 'GitHub', npmScopes: ['@github'], urlHosts: ['githubcopilot.com'] },
  { publisher: 'Linear', npmScopes: ['@linear'], urlHosts: ['mcp.linear.app'] },
  { publisher: 'Notion', npmScopes: ['@notionhq'], urlHosts: ['mcp.notion.com'] },
  { publisher: 'Sentry', npmScopes: ['@sentry'], urlHosts: ['mcp.sentry.dev'] },
  { publisher: 'Stripe', npmScopes: ['@stripe'], urlHosts: ['mcp.stripe.com'] },
  { publisher: 'Cloudflare', npmScopes: ['@cloudflare'], urlHosts: ['mcp.cloudflare.com'] },
  { publisher: 'Hugging Face', npmScopes: ['@huggingface'], urlHosts: ['huggingface.co'] },
];

/** The refusal names what would pass, so the run can correct course. */
function checkMcpTrust(payload: McpPayload): void {
  if (payload.transport === 'stdio') {
    const tokens = [payload.command ?? '', ...(payload.args ?? [])];
    const trusted = TRUSTED_MCP_PUBLISHERS.some((entry) =>
      entry.npmScopes.some((scope) =>
        tokens.some((token) => token === scope || token.startsWith(`${scope}/`)),
      ),
    );
    if (!trusted) {
      throw new AdvisorError(
        'That stdio server does not come from a trusted publisher. Only packages under these npm scopes can be proposed: ' +
          TRUSTED_MCP_PUBLISHERS.flatMap((entry) => entry.npmScopes).join(', ') +
          '. If the publisher is genuinely reputable, say so in your findings instead — the operator can add it by hand.',
      );
    }
    return;
  }

  let host: string;
  try {
    host = new URL(payload.url ?? '').hostname;
  } catch {
    throw new AdvisorError('A remote MCP proposal needs a valid https URL.');
  }
  const trusted = TRUSTED_MCP_PUBLISHERS.some((entry) =>
    entry.urlHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)),
  );
  if (!trusted) {
    throw new AdvisorError(
      `"${host}" is not on the trusted-publisher allowlist. Hosts that can be proposed: ` +
        TRUSTED_MCP_PUBLISHERS.flatMap((entry) => entry.urlHosts).join(', ') +
        '. If the publisher is genuinely reputable, report it in your findings instead — the operator can add it by hand.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Proposal payloads                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Validated twice on purpose: at propose time (the tool shapes) and again at
 * accept time — the row sat in a database between the two, and what is about
 * to be written into the registry deserves its own check.
 */
const SkillPayload = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  body: z.string().min(1).max(200_000),
  category: z.string().optional(),
});
const AgentPayload = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  prompt: z.string().min(1).max(100_000),
  category: z.string().optional(),
});
const McpPayloadSchema = z.object({
  name: z.string().min(1).max(64),
  transport: z.enum(['stdio', 'sse', 'http']),
  command: z.string().max(1024).nullish(),
  args: z.array(z.string().max(1024)).max(64).optional(),
  url: z.string().max(2048).nullish(),
  publisher: z.string().min(1).max(200),
});
type McpPayload = z.infer<typeof McpPayloadSchema>;
const PluginPayload = z.object({
  name: z.string().min(1).max(120),
  /** Where it lives: a marketplace name, or a repository/URL the operator can read. */
  source: z.string().min(1).max(500),
});

const PAYLOADS = {
  skill: SkillPayload,
  agent: AgentPayload,
  mcp: McpPayloadSchema,
  plugin: PluginPayload,
} as const;

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

interface ProposalRow {
  id: string;
  workspace_id: string;
  run_id: string | null;
  kind: string;
  name: string;
  summary: string;
  rationale: string;
  payload: string;
  status: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

const toProposal = (row: ProposalRow): AdvisorProposal => ({
  id: row.id,
  workspaceId: row.workspace_id,
  runId: row.run_id,
  kind: row.kind as AdvisorProposal['kind'],
  name: row.name,
  summary: row.summary,
  rationale: row.rationale,
  payload: JSON.parse(row.payload) as Record<string, unknown>,
  status: row.status as AdvisorProposal['status'],
  createdAt: row.created_at,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
});

/* -------------------------------------------------------------------------- */
/* Service                                                                     */
/* -------------------------------------------------------------------------- */

export interface AdvisorDeps {
  db: Db;
  workspaces: Pick<WorkspaceRepo, 'get' | 'list'>;
  sessions: Pick<SessionRepo, 'get' | 'create'>;
  runs: Pick<RunRepo, 'listRecent'>;
  registry: Pick<Registry, 'listSkills' | 'listAgents' | 'listMcpServers' | 'upsertSkill' | 'upsertAgent' | 'upsertMcpServer'>;
  scheduler: Pick<Scheduler, 'list' | 'create'>;
  library: Pick<LibraryService, 'list'>;
  board: { list(workspaceId: string): BoardTask[] };
  /** The kernel's submit, narrowed to what the advisor's run needs. */
  submit: (input: {
    sessionId: string;
    prompt: string;
    triggeredBy: 'system';
    overrides: { permissionMode: 'auto' };
  }) => Promise<Run>;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/** The daily opt-in's clock: one automatic analysis per workspace per day. */
export const ADVISOR_AUTO_INTERVAL_MS = 24 * 60 * 60_000;

const DOSSIER_RUNS = 30;
const DOSSIER_CARDS = 25;

export class AdvisorService {
  constructor(private readonly deps: AdvisorDeps) {}

  /* ------------------------------ Proposals ------------------------------ */

  list(workspaceId?: string, status: AdvisorProposal['status'] = 'pending'): AdvisorProposal[] {
    const rows = workspaceId
      ? this.deps.db
          .prepare<[string, string], ProposalRow>(
            'SELECT * FROM advisor_proposals WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC',
          )
          .all(workspaceId, status)
      : this.deps.db
          .prepare<[string], ProposalRow>(
            'SELECT * FROM advisor_proposals WHERE status = ? ORDER BY created_at DESC',
          )
          .all(status);
    return rows.map(toProposal);
  }

  get(id: string): AdvisorProposal | null {
    const row = this.deps.db
      .prepare<[string], ProposalRow>('SELECT * FROM advisor_proposals WHERE id = ?')
      .get(id);
    return row ? toProposal(row) : null;
  }

  /**
   * File one proposal into the inbox. Called by the advisor tools with
   * already-shaped input; everything here re-checks anyway, because a tool
   * boundary is not a trust boundary.
   */
  propose(input: {
    workspaceId: string;
    runId: string | null;
    kind: AdvisorProposal['kind'];
    name: string;
    summary: string;
    rationale: string;
    payload: Record<string, unknown>;
  }): AdvisorProposal {
    if (!this.deps.workspaces.get(input.workspaceId)) {
      throw new AdvisorError('Unknown workspace.', 404);
    }
    const parsed = PAYLOADS[input.kind].safeParse(input.payload);
    if (!parsed.success) {
      throw new AdvisorError(
        `Invalid ${input.kind} payload: ${parsed.error.issues[0]?.message ?? 'malformed'}.`,
      );
    }
    if (input.kind === 'mcp') checkMcpTrust(parsed.data as McpPayload);

    // One pending proposal per (workspace, kind, name): a second ask must not
    // fill the inbox with the same idea again.
    const duplicate = this.deps.db
      .prepare<[string, string, string], { id: string }>(
        `SELECT id FROM advisor_proposals
         WHERE workspace_id = ? AND kind = ? AND name = ? AND status = 'pending'`,
      )
      .get(input.workspaceId, input.kind, input.name);
    if (duplicate) {
      throw new AdvisorError(`A pending ${input.kind} proposal named "${input.name}" already exists.`, 409);
    }
    // And a thing that already exists needs no proposal.
    if (input.kind === 'skill' && this.deps.registry.listSkills(null).some((s) => s.name === input.name)) {
      throw new AdvisorError(`A global skill named "${input.name}" already exists.`, 409);
    }
    if (input.kind === 'agent' && this.deps.registry.listAgents(null).some((a) => a.name === input.name)) {
      throw new AdvisorError(`A global agent named "${input.name}" already exists.`, 409);
    }

    const id = newId('proposal');
    this.deps.db
      .prepare(
        `INSERT INTO advisor_proposals
           (id, workspace_id, run_id, kind, name, summary, rationale, payload, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.workspaceId,
        input.runId,
        input.kind,
        input.name,
        input.summary,
        input.rationale,
        JSON.stringify(parsed.data),
        Date.now(),
      );
    return this.get(id) as AdvisorProposal;
  }

  /**
   * Create a *disabled* automation directly — the advisor's one direct write,
   * safe because a disabled automation has no next_run_at and never fires.
   */
  proposeAutomation(input: {
    workspaceId: string;
    name: string;
    description: string;
    prompt: string;
    trigger: Automation['trigger'];
    rationale: string;
  }): Automation {
    // A second analysis proposing the same automation must not stack
    // disabled duplicates on the Automations page.
    if (this.deps.scheduler.list(input.workspaceId).some((entry) => entry.name === input.name)) {
      throw new AdvisorError(`An automation named "${input.name}" already exists here.`, 409);
    }
    const automation = this.deps.scheduler.create({
      workspaceId: input.workspaceId,
      name: input.name,
      // The rationale rides in the description, where the Automations page
      // shows it beside the switch the operator will be deciding with.
      description: [input.description, `Proposed by the advisor: ${input.rationale}`]
        .filter(Boolean)
        .join('\n\n'),
      prompt: input.prompt,
      trigger: input.trigger,
      enabled: false,
    });
    return automation;
  }

  /** Accept one proposal: apply its payload, then mark it. */
  accept(id: string, username: string): { proposal: AdvisorProposal; appliedId: string | null } {
    const proposal = this.get(id);
    if (!proposal) throw new AdvisorError('No such proposal.', 404);
    if (proposal.status !== 'pending') {
      throw new AdvisorError(`That proposal was already ${proposal.status}.`, 409);
    }

    const parsed = PAYLOADS[proposal.kind].safeParse(proposal.payload);
    if (!parsed.success) throw new AdvisorError('The stored payload no longer validates.', 500);

    let appliedId: string | null = null;
    if (proposal.kind === 'skill') {
      const payload = parsed.data as z.infer<typeof SkillPayload>;
      appliedId = this.deps.registry.upsertSkill({
        workspaceId: null,
        name: payload.name,
        description: payload.description,
        body: payload.body,
        ...(payload.category !== undefined ? { category: payload.category as never } : {}),
        enabled: false,
      }).id;
    } else if (proposal.kind === 'agent') {
      const payload = parsed.data as z.infer<typeof AgentPayload>;
      appliedId = this.deps.registry.upsertAgent({
        workspaceId: null,
        name: payload.name,
        description: payload.description,
        prompt: payload.prompt,
        ...(payload.category !== undefined ? { category: payload.category as never } : {}),
        enabled: false,
      }).id;
    } else if (proposal.kind === 'mcp') {
      const payload = parsed.data as McpPayload;
      // Re-checked at accept: the allowlist may have narrowed since.
      checkMcpTrust(payload);
      appliedId = this.deps.registry.upsertMcpServer({
        workspaceId: null,
        name: payload.name,
        transport: payload.transport,
        command: payload.command ?? null,
        args: payload.args ?? [],
        url: payload.url ?? null,
        env: {},
        headers: {},
        enabled: false,
      }).id;
    }
    // 'plugin': nothing to create server-side — plugins install through a
    // marketplace or by path, both deliberate owner actions. Accepting one
    // records the decision; the payload's source says where to get it.

    this.decide(proposal.id, 'accepted', username);
    return { proposal: this.get(proposal.id) as AdvisorProposal, appliedId };
  }

  dismiss(id: string, username: string): AdvisorProposal {
    const proposal = this.get(id);
    if (!proposal) throw new AdvisorError('No such proposal.', 404);
    if (proposal.status !== 'pending') {
      throw new AdvisorError(`That proposal was already ${proposal.status}.`, 409);
    }
    this.decide(id, 'dismissed', username);
    return this.get(id) as AdvisorProposal;
  }

  private decide(id: string, status: 'accepted' | 'dismissed', username: string): void {
    this.deps.db
      .prepare(
        `UPDATE advisor_proposals SET status = ?, decided_at = ?, decided_by = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(status, Date.now(), username, id);
  }

  /* ------------------------------- The run ------------------------------- */

  /**
   * Start one advisor run for this workspace and return it.
   *
   * The session persists per workspace (advisor_state), so successive
   * analyses accumulate context the way a continuous automation does. The
   * run itself is ordinary and fully inspectable — it appears in the session
   * list titled "Advisor", and permission mode is pinned to `auto`: reads
   * and web research flow, high-risk calls still ask.
   */
  async ask(workspaceId: string, options: { auto?: boolean } = {}): Promise<Run> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (!workspace) throw new AdvisorError('Unknown workspace.', 404);

    const sessionId = this.resolveSession(workspace);
    const prompt = this.composeDossier(workspace);

    const run = await this.deps.submit({
      sessionId,
      prompt,
      triggeredBy: 'system',
      overrides: { permissionMode: 'auto' },
    });

    if (options.auto) {
      this.deps.db
        .prepare(
          `INSERT INTO advisor_state (workspace_id, session_id, last_auto_at) VALUES (?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET last_auto_at = excluded.last_auto_at`,
        )
        .run(workspace.id, sessionId, Date.now());
    }
    return run;
  }

  /**
   * The daily beat behind the workspace opt-in. Quiet by design: a workspace
   * whose advisor session is busy, or whose day has not elapsed, is skipped
   * without a word; one workspace's refusal never stops the tour.
   */
  async sweep(now = Date.now()): Promise<void> {
    for (const workspace of this.deps.workspaces.list(false)) {
      if (!workspace.settings.advisorAuto) continue;
      const state = this.deps.db
        .prepare<[string], { last_auto_at: number | null }>(
          'SELECT last_auto_at FROM advisor_state WHERE workspace_id = ?',
        )
        .get(workspace.id);
      if (state?.last_auto_at != null && now - state.last_auto_at < ADVISOR_AUTO_INTERVAL_MS) {
        continue;
      }
      try {
        await this.ask(workspace.id, { auto: true });
      } catch (error) {
        // Usually "a run is already in flight" — tomorrow's sweep retries.
        this.deps.log('debug', 'advisor sweep skipped a workspace', {
          workspaceId: workspace.id,
          message: (error as Error).message,
        });
      }
    }
  }

  /** The advisor's session for a workspace, created on first use. */
  private resolveSession(workspace: Workspace): string {
    const state = this.deps.db
      .prepare<[string], { session_id: string | null }>(
        'SELECT session_id FROM advisor_state WHERE workspace_id = ?',
      )
      .get(workspace.id);
    if (state?.session_id && this.deps.sessions.get(state.session_id)) {
      return state.session_id;
    }
    const session = this.deps.sessions.create({
      workspaceId: workspace.id,
      title: 'Advisor',
      model: String(workspace.settings.defaultModel),
      effort: workspace.settings.defaultEffort,
      permissionMode: 'auto',
    });
    this.deps.db
      .prepare(
        `INSERT INTO advisor_state (workspace_id, session_id, last_auto_at) VALUES (?, ?, NULL)
         ON CONFLICT(workspace_id) DO UPDATE SET session_id = excluded.session_id`,
      )
      .run(workspace.id, session.id);
    return session.id;
  }

  /* ------------------------------ The dossier ----------------------------- */

  /**
   * Everything the advisor should know, composed server-side so the run
   * spends its context on thinking rather than on a dozen discovery calls —
   * and so what it saw is on the record, in the prompt.
   */
  composeDossier(workspace: Workspace): string {
    const runs = this.deps.runs.listRecent({ workspaceId: workspace.id, limit: DOSSIER_RUNS });
    const failures = runs.filter((run) => run.status === 'failed');
    const cards = this.deps.board.list(workspace.id);
    const automations = this.deps.scheduler.list(workspace.id);
    const skills = this.deps.registry.listSkills(workspace.id);
    const agents = this.deps.registry.listAgents(workspace.id);
    const servers = this.deps.registry.listMcpServers(workspace.id);
    const shelf = this.deps.library.list().filter((entry) => !entry.installed);
    const pending = this.list(workspace.id);

    const lines: string[] = [
      `You are the advisor for the workspace "${workspace.name}". Study the state below and`,
      'propose what would genuinely help — nothing is worth proposing for its own sake.',
      '',
      'What you can do, in order of preference:',
      '- Create tickets with the board tools (board_create, status "backlog" — or "todo" only',
      '  when something is urgent). One outcome per ticket, a description with a definition of',
      '  done, and when a defined subagent fits the work, name it in the description. After',
      '  creating a ticket, leave a comment on it stating your reasoning.',
      '- Create automations with advisor_propose_automation. They are created DISABLED; the',
      '  operator reads your rationale on the Automations page and decides.',
      '- Propose skills and subagents with advisor_propose_skill / advisor_propose_agent.',
      '  They go to an inbox the operator accepts from — write them complete and ready.',
      '- Propose MCP servers with advisor_propose_mcp, but only from recognised publishers',
      '  (the tool enforces an allowlist) — research on the web what would actually serve this',
      '  workspace. Propose plugins with advisor_propose_plugin, naming a source the operator',
      '  can verify.',
      '',
      'Rules: do not modify any file — you are an analyst, not an implementer. Do not redo or',
      'anticipate work that live tickets already cover. Prefer three proposals that matter over',
      'ten that pad. End with a short summary of what you proposed and why.',
      '',
      `## Workspace`,
      `${workspace.name} — ${workspace.description || 'no description'}`,
    ];

    lines.push('', `## Recent runs (${runs.length} of the last ${DOSSIER_RUNS})`);
    if (runs.length === 0) lines.push('None yet.');
    for (const run of runs.slice(0, 10)) {
      lines.push(`- [${run.status}] (${run.category ?? 'uncategorised'}) ${firstLine(run.prompt)}`);
    }
    if (failures.length > 0) {
      lines.push('', `### Failures worth reading (${failures.length})`);
      for (const failed of failures.slice(0, 5)) {
        lines.push(`- ${firstLine(failed.prompt)} → ${firstLine(failed.error ?? 'no error text')}`);
      }
    }

    lines.push('', `## Board (${cards.length} cards)`);
    for (const card of cards.slice(0, DOSSIER_CARDS)) {
      lines.push(`- [${card.status}] ${card.title}${card.blockedReason ? ` (blocked: ${card.blockedReason})` : ''}`);
    }

    lines.push('', `## Automations (${automations.length})`);
    for (const automation of automations) {
      lines.push(
        `- ${automation.name} [${automation.enabled ? 'enabled' : 'disabled'}] — ${JSON.stringify(automation.trigger)}`,
      );
    }

    lines.push('', `## Skills available here (${skills.length})`);
    for (const skill of skills) lines.push(`- ${skill.name} (${skill.category}${skill.enabled ? '' : ', disabled'})`);
    lines.push('', `## Subagents available here (${agents.length})`);
    for (const agent of agents) lines.push(`- ${agent.name} (${agent.category}${agent.enabled ? '' : ', disabled'})`);
    lines.push('', `## MCP servers (${servers.length})`);
    for (const server of servers) lines.push(`- ${server.name} [${server.status}]`);

    lines.push('', `## Still on the built-in library shelf (install is one click for the operator)`);
    for (const entry of shelf) lines.push(`- ${entry.kind} ${entry.name} (${entry.category})`);

    if (pending.length > 0) {
      lines.push('', '## Already proposed and pending — do not propose these again');
      for (const proposal of pending) lines.push(`- ${proposal.kind} ${proposal.name}`);
    }

    return lines.join('\n');
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

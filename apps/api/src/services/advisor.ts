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

import type {
  AdvisorProposal,
  Automation,
  BoardTask,
  EffortLevel,
  RevisionField,
  RevisionFinding,
  RevisionFollowUp,
  RevisionTargetKind,
  Run,
  Workspace,
} from '@metaclaude/shared';
import { AUTO_MODEL, newId, REVISABLE_FIELDS, RevisionPayload, unifiedDiff } from '@metaclaude/shared';
import {
  fitsField,
  hasField,
  isRewrite,
  mayRevise,
  readRevisable,
  RevisionTargetError,
  sameText,
  textFingerprint,
  writeRevisable,
  type RevisionSurfaceDeps,
} from '../learning/revision.js';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import type { RunRepo, SessionRepo, WorkspaceRepo } from '../kernel/repositories.js';
import type { LibraryService } from '../library/service.js';
import { toSkillName, type Registry } from './registry.js';
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
  // Added with the connector directory. Hosts are named exactly rather than by
  // their parent domain: `googleapis.com` would vouch for every API Google
  // serves, which is not what reading one endpoint's documentation earns.
  { publisher: 'Upstash', npmScopes: ['@upstash'], urlHosts: ['mcp.context7.com'] },
  { publisher: 'Exa', npmScopes: ['@exa-labs'], urlHosts: ['mcp.exa.ai'] },
  { publisher: 'Apify', npmScopes: ['@apify'], urlHosts: ['mcp.apify.com'] },
  { publisher: 'Google', npmScopes: [], urlHosts: ['mapstools.googleapis.com'] },
  { publisher: 'Wolfram Research', npmScopes: [], urlHosts: ['services.wolfram.com'] },
];

/**
 * The refusal names what would pass, so the run can correct course.
 *
 * Exported because the connector directory is held to the same bar: its test
 * runs every shipped entry through this function, so a connector cannot exist
 * for a publisher the advisor would refuse. One allowlist, both features.
 */
export function checkMcpTrust(payload: McpPayload): void {
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
export type McpPayload = z.infer<typeof McpPayloadSchema>;
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
  // The one kind that creates nothing. Its schema lives in `packages/shared`
  // because the card parses it in the browser too, and a second hand-written
  // copy at the edge is how `AutomationPolicy` came to drop a field the form
  // was faithfully sending.
  revision: RevisionPayload,
} as const;

/**
 * How long a refused revision keeps its target quiet.
 *
 * A fortnight is two review windows, so an operator who says no is not asked
 * again next week by a pass looking at almost the same runs. It is deliberately
 * longer than the window rather than a multiple of it: the point is that a
 * refusal outlives the evidence that produced it, or the same handful of runs
 * would keep re-proposing the same idea until they aged out.
 */
export const REVISION_COOLDOWN_DAYS = 14;

/** Proposals one listing returns. Enough for any inbox worth reading at once. */
export const PROPOSAL_PAGE = 100;

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
  workspaces: Pick<WorkspaceRepo, 'get' | 'list' | 'update'>;
  sessions: Pick<SessionRepo, 'get' | 'create'>;
  runs: Pick<RunRepo, 'listRecent'>;
  registry: Pick<
    Registry,
    | 'listSkills'
    | 'listAgents'
    | 'listMcpServers'
    | 'upsertSkill'
    | 'upsertAgent'
    | 'upsertMcpServer'
    | 'getSkill'
    | 'getAgent'
  >;
  scheduler: Pick<Scheduler, 'list' | 'create' | 'get' | 'update'>;
  /**
   * Refuses a change the system workspace must not take — the same guard the
   * settings route leans on. Optional so the service can be built before the
   * system workspace exists; absent, nothing is refused on that ground.
   */
  systemWorkspaceGuard?: (workspaceId: string, patch: { settings?: Record<string, unknown> }) => void;
  library: Pick<LibraryService, 'list'>;
  board: { list(workspaceId: string): BoardTask[] };
  /** The kernel's submit, narrowed to what the advisor's run needs. */
  submit: (input: {
    sessionId: string;
    prompt: string;
    triggeredBy: 'system';
    overrides: { permissionMode: 'auto'; model?: string; effort?: EffortLevel };
  }) => Promise<Run>;
  /**
   * What the advisor's own run is served, read at the moment it is submitted.
   *
   * Independent of the workspace's default on purpose: that default is what an
   * operator picks for the work, and this is the machine that comments on it —
   * a project run on Opus has no reason to pay Opus for a weekly review, and a
   * project run on Haiku may well deserve better judgement here. Absent, or
   * unpinned, the workspace default stands, which is what shipped before.
   *
   * A getter, because the setting is hot and this service is built at boot.
   */
  policy?: () => { model: string | null; effort: EffortLevel | null };
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

/** The daily opt-in's clock: one automatic analysis per workspace per day. */
export const ADVISOR_AUTO_INTERVAL_MS = 24 * 60 * 60_000;

const DOSSIER_RUNS = 30;
const DOSSIER_CARDS = 25;

export class AdvisorService {
  constructor(private readonly deps: AdvisorDeps) {}

  /* ------------------------------ Proposals ------------------------------ */

  /**
   * Proposals of one status, newest first.
   *
   * Bounded, which it was not while only `pending` was ever asked for — that
   * set is drained by definition. `accepted` is not: it only grows, it is read
   * on every Dashboard now, and each row carries a whole revision payload with
   * its diff. An unbounded read of it would send a year of them to the browser
   * to draw the three that still have an undo.
   */
  list(
    workspaceId?: string,
    status: AdvisorProposal['status'] = 'pending',
    limit = PROPOSAL_PAGE,
  ): AdvisorProposal[] {
    const bounded = Math.max(1, Math.min(limit, 500));
    const rows = workspaceId
      ? this.deps.db
          .prepare<[string, string, number], ProposalRow>(
            'SELECT * FROM advisor_proposals WHERE workspace_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
          )
          .all(workspaceId, status, bounded)
      : this.deps.db
          .prepare<[string, number], ProposalRow>(
            'SELECT * FROM advisor_proposals WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
          )
          .all(status, bounded);
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
      // The advisor writes the name, not the operator, so a spelling the
      // registry refuses is corrected rather than thrown back at whoever
      // clicked Accept.
      const name = toSkillName(payload.name);
      if (!name) throw new AdvisorError('That proposal names no usable skill.', 422);
      appliedId = this.deps.registry.upsertSkill({
        workspaceId: null,
        name,
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
    } else if (proposal.kind === 'revision') {
      // The one kind that creates nothing. It rewrites a text already in
      // force, so it is checked against what is there right now and applied
      // through the same services the interface writes through.
      this.applyRevision(proposal);
      appliedId = (parsed.data as z.infer<typeof RevisionPayload>).target.id;
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


  /* ------------------------------ Revisions ------------------------------ */

  /**
   * The services a revision reads and writes through, gathered once.
   *
   * One object so the read path and the apply path cannot be given different
   * ones — a proposal drawn against one reading of "the description of a
   * skill" and applied to another is the failure this shape exists to make
   * impossible.
   */
  private get surface(): RevisionSurfaceDeps {
    return {
      workspaces: this.deps.workspaces,
      registry: this.deps.registry,
      automations: this.deps.scheduler,
      ...(this.deps.systemWorkspaceGuard ? { guard: this.deps.systemWorkspaceGuard } : {}),
    };
  }

  /** Whether this service knows how to apply a revision of that kind at all. */
  canApply(kind: RevisionTargetKind): boolean {
    return (REVISABLE_FIELDS[kind]?.length ?? 0) > 0;
  }

  /**
   * The name a revision proposal is filed under.
   *
   * It is also the duplicate key, and that is the whole design: one pending
   * proposal per target *and field*, so a second pass reaching the same
   * conclusion cannot stack two rewrites of one text — of which applying
   * either leaves the other drawn against text that no longer exists.
   */
  private static revisionName(kind: RevisionTargetKind, id: string, field: RevisionField): string {
    return `${kind}:${id}:${field}`;
  }

  /**
   * Propose a rewrite of a text that is already in force.
   *
   * Everything that makes this safe is checked here rather than asked of the
   * model, because the memory gate measured what asking costs: four rules had
   * to sit *after* the model there, and the same reasoning applies to every
   * rule below. A rewrite identical to what is there is refused; a field the
   * target does not have is refused; a target that has gone is refused; a
   * second pending proposal for one text is refused; and a target whose
   * revision was recently declined is refused, because the operator has
   * already answered.
   */
  proposeRevision(input: {
    workspaceId: string;
    runId: string | null;
    target: { kind: RevisionTargetKind; id: string; name: string; workspaceId: string | null };
    field: RevisionField;
    after: string;
    rationale: string;
    evidence?: Array<{ runId: string; sessionId: string | null; workspaceId: string | null; note: string }>;
    findings?: RevisionFinding[];
    reviewId?: string | null;
    now?: number;
  }): AdvisorProposal {
    if (!this.deps.workspaces.get(input.workspaceId)) {
      throw new AdvisorError('Unknown workspace.', 404);
    }
    if (!hasField(input.target.kind, input.field)) {
      throw new AdvisorError(
        `A ${input.target.kind} has no ${input.field} to revise. It has ` +
          `${REVISABLE_FIELDS[input.target.kind].join(' and ')}.`,
      );
    }

    const current = readRevisable(this.surface, input.target, input.field);
    if (!current) {
      throw new AdvisorError(`There is no ${input.target.kind} “${input.target.name}” to revise.`, 404);
    }
    /*
     * Whose text is this?
     *
     * The id arrives from a model's arguments through
     * `advisor_propose_revision`, and the surface resolves it by id alone — so
     * without this a run in one workspace could name another's skill, or
     * another's standing instructions, file the card here, and rewrite them the
     * moment an operator accepted. Answered as *not found* rather than as
     * forbidden: a workspace has no business learning that an id it guessed
     * exists somewhere else.
     */
    if (!mayRevise(this.surface, input.workspaceId, input.target)) {
      throw new AdvisorError(`There is no ${input.target.kind} “${input.target.name}” to revise.`, 404);
    }
    // What the field itself accepts, asked of the schema that owns it. A
    // rewrite over the ceiling would otherwise reach `WorkspaceRepo.update`,
    // which reparses the whole settings object, and surface as a 500 at accept
    // time about a proposal that should never have been filed.
    const fits = fitsField(input.target.kind, input.field, input.after);
    if (!fits.ok) throw new AdvisorError(fits.reason);

    if (sameText(current.text, input.after)) {
      throw new AdvisorError(
        'That rewrite is the text that is already there. Propose a change, or propose nothing.',
      );
    }
    /*
     * An edit, not a rewrite.
     *
     * The review pass has applied this since the first day; the tool was told
     * it in prose and held to it by nothing, and prose is not a rule. What it
     * stops is a card whose diff is a wall of green an operator cannot read —
     * and the diff is the entire reason this proposal kind is safe to accept.
     */
    if (isRewrite(current.text, input.after)) {
      throw new AdvisorError(
        'That replaces most of the text rather than editing it. Change as little as possible, ' +
          'keep the operator’s own wording, and propose the smallest edit that fixes what you saw.',
      );
    }

    const name = AdvisorService.revisionName(input.target.kind, input.target.id, input.field);
    const now = input.now ?? Date.now();
    const quiet = this.revisionCooldownUntil(name, now);
    if (quiet !== null) {
      throw new AdvisorError(
        `A revision of that text was recently declined; it can be proposed again in ` +
          `${Math.ceil((quiet - now) / 86_400_000)} day(s).`,
        409,
      );
    }

    const payload = RevisionPayload.parse({
      // The name *and* the owner are read from the live record. Both decide
      // what the card tells the operator — the second one draws the warning
      // that this revision reaches every workspace — and a caller's claim
      // about either is a claim, not a fact.
      target: {
        ...input.target,
        name: current.name,
        // Null means "reaches every workspace", which is the only thing the
        // card asks this field. Read from the record's own reach, never from
        // what the caller claimed.
        workspaceId: current.global ? null : input.workspaceId,
      },
      field: input.field,
      before: current.text,
      after: input.after,
      beforeFingerprint: textFingerprint(current.text),
      diff: unifiedDiff(current.text, input.after),
      rationale: input.rationale,
      evidence: input.evidence ?? [],
      findings: input.findings ?? [],
      reviewId: input.reviewId ?? null,
    });

    return this.propose({
      workspaceId: input.workspaceId,
      runId: input.runId,
      kind: 'revision',
      name,
      summary: `Rewrite the ${input.field} of ${current.name}`,
      rationale: input.rationale,
      payload,
    });
  }

  /**
   * When this target stops being quiet, or null if it is not.
   *
   * Derived from the proposals themselves rather than from a table of its own.
   * A second table would be a stored copy of something these rows already say,
   * and a stored derived value is only correct until its input moves — which
   * is how every workspace row came to name a directory the volume no longer
   * mounted.
   */
  private revisionCooldownUntil(name: string, now: number): number | null {
    // Two ways an operator says no, and the second says it louder: a dismissal
    // refuses the idea, a revert says it was tried and was wrong. Both start
    // the clock, each from its own moment.
    const row = this.deps.db
      .prepare<[string], { at: number | null }>(
        `SELECT MAX(CASE WHEN status = 'dismissed' THEN decided_at
                         ELSE json_extract(payload, '$.revertedAt') END) AS at
           FROM advisor_proposals
          WHERE kind = 'revision' AND name = ?
            AND (status = 'dismissed' OR json_extract(payload, '$.revertedAt') IS NOT NULL)`,
      )
      .get(name);
    const until = row?.at ? row.at + REVISION_COOLDOWN_DAYS * 86_400_000 : null;
    return until !== null && until > now ? until : null;
  }

  /**
   * Findings this workspace's operator has refused lately.
   *
   * Handed to the next pass so it is not asked to rediscover one: an operator
   * who dismisses a proposal is answering the *finding*, not the wording, and
   * a pass that does not know that spends a model call reaching the same
   * conclusion and has the answer thrown away by the rule above.
   */
  refusedFindings(workspaceId: string, now: number = Date.now()): string[] {
    const cutoff = now - REVISION_COOLDOWN_DAYS * 86_400_000;
    const rows = this.deps.db
      .prepare<[string, number, number], { payload: string }>(
        `SELECT payload FROM advisor_proposals
          WHERE kind = 'revision' AND workspace_id = ?
            AND ((status = 'dismissed' AND decided_at IS NOT NULL AND decided_at > ?)
                 OR json_extract(payload, '$.revertedAt') > ?)`,
      )
      .all(workspaceId, cutoff, cutoff);

    const keys = new Set<string>();
    for (const row of rows) {
      const parsed = RevisionPayload.safeParse(safeJson(row.payload));
      if (!parsed.success) continue;
      for (const finding of parsed.data.findings) keys.add(finding.key);
    }
    return [...keys];
  }

  /**
   * Apply a revision the operator has read and agreed with.
   *
   * The fingerprint check is the consolidation rule, and it is here for the
   * consolidation reason: the proposal was drawn against a text that has been
   * live ever since, and folding onto it blindly would delete an operator's
   * own edit with nothing on screen to say so. A drift is a 409 they can act
   * on, never a silent best effort.
   */
  private applyRevision(proposal: AdvisorProposal): void {
    const parsed = RevisionPayload.safeParse(proposal.payload);
    if (!parsed.success) throw new AdvisorError('The stored revision no longer validates.', 500);
    // `before` is deliberately not read here: what a revert restores comes off
    // the payload at revert time, and the fingerprint below is what proves the
    // stored `before` is still what stands.
    const { target, field, after, beforeFingerprint } = parsed.data;

    const current = readRevisable(this.surface, target, field);
    if (!current) {
      throw new AdvisorError(`That ${target.kind} no longer exists — dismiss this proposal.`, 409);
    }
    if (textFingerprint(current.text) !== beforeFingerprint) {
      throw new AdvisorError(
        `“${current.name}” changed since this was proposed — dismiss it and let the next review look again.`,
        409,
      );
    }
    try {
      writeRevisable(this.surface, target, field, after);
    } catch (error) {
      if (error instanceof RevisionTargetError) throw new AdvisorError(error.message, 409);
      throw error;
    }
  }

  /**
   * Put back the text a revision replaced.
   *
   * What makes accepting one safe. A revision is in force on the very next
   * run — unlike every other proposal in this inbox, which lands disabled —
   * so "reversible" has to mean a button rather than a principle. It is
   * refused when what stands is no longer what this revision wrote, because
   * an operator who has edited since would otherwise lose that edit to
   * something labelled *undo*.
   */
  revert(id: string, username: string, now: number = Date.now()): AdvisorProposal {
    const proposal = this.get(id);
    if (!proposal) throw new AdvisorError('No such proposal.', 404);
    if (proposal.kind !== 'revision') throw new AdvisorError('That proposal is not a revision.', 400);
    if (proposal.status !== 'accepted') {
      throw new AdvisorError('That revision was never applied, so there is nothing to take back.', 409);
    }

    const parsed = RevisionPayload.safeParse(proposal.payload);
    if (!parsed.success) throw new AdvisorError('The stored revision no longer validates.', 500);
    if (parsed.data.revertedAt !== null) {
      throw new AdvisorError('That revision has already been taken back.', 409);
    }

    const { target, field, before, after } = parsed.data;
    const current = readRevisable(this.surface, target, field);
    if (!current) {
      throw new AdvisorError(`That ${target.kind} no longer exists.`, 409);
    }
    if (textFingerprint(current.text) !== textFingerprint(after)) {
      throw new AdvisorError(
        `“${current.name}” changed since the revision was applied — taking it back would discard that edit. ` +
          'Edit it yourself instead.',
        409,
      );
    }

    try {
      writeRevisable(this.surface, target, field, before);
    } catch (error) {
      if (error instanceof RevisionTargetError) throw new AdvisorError(error.message, 409);
      throw error;
    }

    // Recorded on the payload rather than as a fifth status: the operator did
    // accept it, and a revert is a later fact about the target rather than a
    // change to that decision. It also starts the cooldown, because taking a
    // revision back is the strongest thing anyone can say about it.
    const updated = { ...parsed.data, revertedAt: now };
    this.deps.db
      .prepare('UPDATE advisor_proposals SET payload = ?, decided_by = ? WHERE id = ?')
      .run(JSON.stringify(updated), username, id);
    return this.get(id) as AdvisorProposal;
  }

  /**
   * Record what became of a revision that was applied.
   *
   * Written by the *next* review, over the window that followed the change.
   * A background pass that cannot say whether its own advice worked is one
   * nobody should take advice from — and it is the half of "what works and
   * what does not" an operator cannot see for themselves, because it needs the
   * same measurement repeated on the same terms.
   *
   * Refused once set: a follow-up is a reading taken at a moment, and a second
   * one over a later window would answer a different question while looking
   * like a correction of the first.
   */
  recordFollowUp(id: string, followUp: RevisionFollowUp): boolean {
    const proposal = this.get(id);
    if (!proposal || proposal.kind !== 'revision') return false;
    const parsed = RevisionPayload.safeParse(proposal.payload);
    if (!parsed.success || parsed.data.followUp !== null) return false;

    return (
      this.deps.db
        .prepare('UPDATE advisor_proposals SET payload = ? WHERE id = ?')
        .run(JSON.stringify({ ...parsed.data, followUp }), id).changes > 0
    );
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

    // Only a pin overrides. `null` is not a choice to pass on: it would reach
    // the kernel as an explicit selection of nothing, where absence means the
    // session's own model — the `isAutoModel` distinction, from the other side.
    const pinned = this.deps.policy?.() ?? { model: null, effort: null };
    const run = await this.deps.submit({
      sessionId,
      prompt,
      triggeredBy: 'system',
      overrides: {
        permissionMode: 'auto',
        ...(pinned.model ? { model: pinned.model } : {}),
        ...(pinned.effort ? { effort: pinned.effort } : {}),
      },
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
      // Inheriting: the workspace's settings are read on every run, and this
      // session is kept for the workspace's lifetime. The mode the advisor
      // actually runs under is pinned per run, in `ask`'s overrides.
      model: AUTO_MODEL,
      effort: null,
      permissionMode: null,
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

/** Parse a stored payload without throwing on one a hand edit corrupted. */
function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

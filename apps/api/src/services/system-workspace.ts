/**
 * The system workspace — the one Metaclaude itself works in.
 *
 * An operator talks to a workspace's agent about that workspace's project.
 * This is the workspace whose project is *the application*: its memories,
 * its settings, its other workspaces, its own health. It is an ordinary
 * workspace in every mechanism — sessions, transcripts, approvals, memory,
 * reflexion all apply unchanged — and a special one in exactly three ways,
 * each enforced here rather than by convention:
 *
 *  1. **It exists once, whatever happens.** Created on the first boot,
 *     remembered by id in the `kv` table, recreated if the row vanishes and
 *     re-used if only the row did. Identified by that id and never by its
 *     slug, so an operator who already named a workspace "metaclaude" is not
 *     in anyone's way.
 *  2. **Its safety settings cannot drift.** No shell, no file writes, no
 *     extra directories, never `bypassPermissions` — and the reversible tools
 *     pre-approved by exact name so they flow without a card and leave a
 *     transcript line each. Re-asserted on every boot, because an upgrade
 *     grows the tool list and a hand edit could shrink the forbidden one.
 *     The permission mode short of bypass is the operator's: it decides how
 *     much they want to be asked, not what the agent can reach.
 *     The interface may change everything else about it; `guard` is what the
 *     routes lean on to refuse the rest.
 *  3. **What it knows is regenerated, not maintained.** `CLAUDE.md`, the
 *     system map and a copy of the shipped documentation are rewritten on
 *     every boot from the running image, so "updated with every release" is a
 *     property of the mechanism. The operator's own `NOTES.md` is imported
 *     and never touched.
 *
 * What this deliberately does not do is widen what an agent can reach. An
 * ordinary workspace agent with `Bash` can already open the database file —
 * it is owned by the same uid — and only the permission broker stands in the
 * way. This workspace takes the shell away and offers typed, audited tools
 * instead. It is safer than an ordinary workspace, not more powerful.
 */

import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Workspace, WorkspaceSettings } from '@metaclaude/shared';
import { WorkspaceSettings as WorkspaceSettingsSchema } from '@metaclaude/shared';
import { kvGet, kvSet, type Db } from '../db/index.js';
import { defaultWorkspaceSettings, type WorkspaceRepo } from '../kernel/repositories.js';
import type { ContentLanguage } from '../learning/language.js';
import { isInside, PathEscapeError, resolveInside, safeRealpath } from '../security/paths.js';
import { uniqueSlug } from './workspaces.js';

/** Where the workspace's id is remembered. The `kv` table exists for this. */
export const SYSTEM_WORKSPACE_KEY = 'system.workspaceId';

export const SYSTEM_WORKSPACE_NAME = 'Metaclaude';
const SYSTEM_WORKSPACE_SLUG = 'metaclaude';

/**
 * The settings that decide what the agent can reach, fixed for this workspace.
 *
 * `allowedTools` is not here because it is not a constant: it is the system
 * tool catalogue, which grows with the product, and it is supplied by the
 * module that owns that catalogue so the two cannot disagree.
 *
 * The permission mode is deliberately *not* here either. It was, for three
 * releases, and it left the steward unable to be autonomous by the operator's
 * own choice: every mode short of `bypassPermissions` keeps the shell and the
 * editors forbidden and the reach bounded to this list, so the mode decides
 * only how much the operator wants to be asked — which is theirs to decide.
 * Bypass alone is refused, see `FORBIDDEN_PERMISSION_MODE`.
 */
export const SYSTEM_WORKSPACE_SAFETY = {
  disallowedTools: ['Bash', 'BashOutput', 'Write', 'Edit', 'NotebookEdit', 'KillShell'],
  additionalDirectories: [] as string[],
} as const satisfies Partial<WorkspaceSettings>;

/** The mode this workspace never runs in; re-set to the initial one at boot if found. */
export const FORBIDDEN_PERMISSION_MODE: WorkspaceSettings['defaultPermissionMode'] = 'bypassPermissions';
const INITIAL_PERMISSION_MODE: WorkspaceSettings['defaultPermissionMode'] = 'default';

/**
 * What of the repository the steward gets to read, relative to the source
 * root, and where it lands under the workspace's `code/`. The developers'
 * CLAUDE.md rides along under another name: as `CLAUDE.md` the CLI would
 * load it as *instructions* the moment a file beside it is read, and
 * "every push to main bumps the version" is not a standing order the steward
 * should receive.
 */
export const SOURCE_TREES: ReadonlyArray<{ from: string; to: string }> = [
  { from: 'apps/api/src', to: 'apps/api/src' },
  { from: 'packages/shared/src', to: 'packages/shared/src' },
  { from: 'apps/web/src', to: 'apps/web/src' },
  { from: 'CLAUDE.md', to: 'REPOSITORY-CLAUDE.md' },
];

/** The settings the interface may not change on this workspace, by name. */
const GUARDED_SETTINGS = [
  'allowedTools',
  'disallowedTools',
  'additionalDirectories',
] as const satisfies readonly (keyof WorkspaceSettings)[];

export class SystemWorkspaceError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = 'SystemWorkspaceError';
  }
}

export interface SystemWorkspaceDeps {
  db: Db;
  workspaces: Pick<WorkspaceRepo, 'get' | 'create' | 'update' | 'slugExists'>;
  workspacesRoot: string;
  /** The shipped documentation, or null when this image carries none. */
  docsDir: string | null;
  /**
   * A directory holding the TypeScript sources of the running version under
   * `SOURCE_TREES` — the repository root in a checkout, `source/` in the
   * image — or null when neither is there. Copied into the workspace like
   * the documentation, because the one thing the steward may not have is an
   * extra directory: its reach is bounded to the workspaces root, and the
   * compiled output it used to be pointed at cost an approval card per file.
   */
  sourceRoot?: string | null;
  version: string;
  /** The language generated text is written in, resolved for this workspace. */
  language: () => ContentLanguage | null;
  /** Exact names of the system tools, as the CLI will call them. */
  preapproved: () => readonly string[];
  /**
   * The same tools with their ring and a line each, for the standing
   * instructions. Optional so the pre-approval list can exist before the
   * tools do; absent, CLAUDE.md lists the bare names.
   */
  tools?: () => ReadonlyArray<{ name: string; ring: 1 | 2; description: string }>;
  log: (level: 'info' | 'warn' | 'error', message: string, data?: unknown) => void;
}

export class SystemWorkspace {
  private cachedId: string | null = null;

  constructor(private readonly deps: SystemWorkspaceDeps) {}

  /** The workspace's id, once `ensure` has run; null before. */
  id(): string | null {
    return this.cachedId;
  }

  isSystem(workspaceId: string): boolean {
    return this.cachedId !== null && workspaceId === this.cachedId;
  }

  /**
   * Make the workspace exist, with its safety settings in force and its
   * knowledge current. Idempotent; called at every boot.
   */
  async ensure(): Promise<Workspace> {
    const remembered = kvGet<string | null>(this.deps.db, SYSTEM_WORKSPACE_KEY, null);
    let workspace = remembered ? this.deps.workspaces.get(remembered) : null;

    if (!workspace) {
      workspace = await this.create();
      kvSet(this.deps.db, SYSTEM_WORKSPACE_KEY, workspace.id);
      this.deps.log('info', 'created the system workspace', { id: workspace.id, path: workspace.path });
    }

    workspace = this.assertSafety(workspace);
    this.cachedId = workspace.id;
    await this.materialise(workspace);
    return workspace;
  }

  /* ---------------------------------------------------------------------- */
  /* The guard                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Refuse a change the interface must not make to this workspace.
   *
   * Archiving would hide the one place an operator talks to the system from;
   * the four safety settings would let a confused or compromised agent talk
   * the operator into handing it a shell. Everything else — name, colour,
   * language, model, memory switches — is the operator's to change.
   *
   * Refused when a guarded value *differs*, not when it is merely named: the
   * settings form sends the whole object back, so a guard on presence would
   * turn every save of this workspace's language into a 409.
   */
  guard(
    workspaceId: string,
    patch: { archived?: boolean; settings?: Partial<WorkspaceSettings> | undefined } & Record<string, unknown>,
  ): void {
    if (!this.isSystem(workspaceId)) return;
    if (patch.archived === true) {
      throw new SystemWorkspaceError('The system workspace cannot be archived.');
    }
    if (patch.settings?.defaultPermissionMode === FORBIDDEN_PERMISSION_MODE) {
      throw new SystemWorkspaceError(
        'The system workspace never runs with permissions bypassed; every other mode is yours to choose.',
      );
    }
    const wanted = this.safetySettings();
    const touched = GUARDED_SETTINGS.filter(
      (key) =>
        patch.settings?.[key] !== undefined &&
        JSON.stringify(patch.settings[key]) !== JSON.stringify(wanted[key]),
    );
    if (touched.length > 0) {
      throw new SystemWorkspaceError(
        `The system workspace's safety settings are fixed: ${touched.join(', ')} cannot be changed.`,
      );
    }
  }

  guardDelete(workspaceId: string): void {
    if (this.isSystem(workspaceId)) {
      throw new SystemWorkspaceError('The system workspace cannot be deleted.');
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Creation                                                                */
  /* ---------------------------------------------------------------------- */

  private async create(): Promise<Workspace> {
    const slug = uniqueSlug(this.deps.workspaces, SYSTEM_WORKSPACE_SLUG);
    const path = resolve(this.deps.workspacesRoot, slug);
    // Unlike an operator's workspace, an existing directory is not a
    // conflict: the row can be gone while the volume kept the files, and the
    // files are worth keeping.
    await mkdir(path, { recursive: true });

    const settings = WorkspaceSettingsSchema.parse({
      ...defaultWorkspaceSettings(),
      memoryEnabled: true,
      knowledgeEnabled: true,
      reflexionEnabled: true,
      defaultPermissionMode: INITIAL_PERMISSION_MODE,
      ...this.safetySettings(),
    });

    return this.deps.workspaces.create({
      name: SYSTEM_WORKSPACE_NAME,
      slug,
      description: "The system's own workspace: talk to Metaclaude here about the application itself.",
      path,
      color: '#0f766e',
      icon: 'bot',
      settings,
    });
  }

  private safetySettings(): Partial<WorkspaceSettings> {
    return {
      ...SYSTEM_WORKSPACE_SAFETY,
      disallowedTools: [...SYSTEM_WORKSPACE_SAFETY.disallowedTools],
      additionalDirectories: [],
      allowedTools: [...this.deps.preapproved()],
    };
  }

  /**
   * Re-assert the fixed settings; write only when something actually drifted.
   * The permission mode is the operator's and is left alone — unless it is
   * the one forbidden value, which only a write straight to the database can
   * have put there.
   */
  private assertSafety(workspace: Workspace): Workspace {
    const wanted: Partial<WorkspaceSettings> = this.safetySettings();
    if (workspace.settings.defaultPermissionMode === FORBIDDEN_PERMISSION_MODE) {
      wanted.defaultPermissionMode = INITIAL_PERMISSION_MODE;
    }
    const drifted = (Object.keys(wanted) as (keyof WorkspaceSettings)[]).some(
      (key) => JSON.stringify(workspace.settings[key]) !== JSON.stringify(wanted[key]),
    );
    if (!drifted) return workspace;
    this.deps.log('warn', 'system workspace safety settings had drifted — re-applied', {
      id: workspace.id,
    });
    return this.deps.workspaces.update(workspace.id, { settings: wanted }) ?? workspace;
  }

  /* ---------------------------------------------------------------------- */
  /* Knowledge                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Write what the agent should know into its directory.
   *
   * Through the jail, for the reason `materialiseSkills` gives: a symlinked
   * workspace directory would point every write here at the link's target.
   * Declining rather than throwing — a workspace that cannot be furnished
   * must not stop the boot.
   */
  async materialise(workspace: Workspace): Promise<void> {
    // The directory itself first, then the files inside it. `resolveInside`
    // guards a child that escapes its root; it cannot notice a root that is
    // itself a link, because it resolves the root too. So the workspace's
    // directory is checked to sit inside the workspaces root *after* both are
    // resolved — the same comparison the additional-directory review makes.
    if (!isInside(safeRealpath(this.deps.workspacesRoot), safeRealpath(workspace.path))) {
      this.deps.log('error', 'refusing to furnish the system workspace: its directory is a symlink out of the workspaces root', {
        path: workspace.path,
      });
      return;
    }

    let claudeMd: string;
    let notes: string;
    let map: string;
    let docsTarget: string;
    let codeTarget: string;
    try {
      claudeMd = resolveInside(workspace.path, 'CLAUDE.md');
      notes = resolveInside(workspace.path, 'NOTES.md');
      map = resolveInside(workspace.path, 'SYSTEM-MAP.md');
      docsTarget = resolveInside(workspace.path, 'docs');
      codeTarget = resolveInside(workspace.path, 'code');
    } catch (error) {
      if (!(error instanceof PathEscapeError)) throw error;
      this.deps.log('error', 'refusing to furnish the system workspace through a symlinked path', {
        path: workspace.path,
      });
      return;
    }

    const docsCopied = await this.copyDocs(docsTarget);
    const codeCopied = await this.copySources(codeTarget);

    // The operator's file: created empty once, never written again.
    if (!existsSync(notes)) {
      await writeFile(notes, NOTES_TEMPLATE, 'utf8');
    }
    await writeFile(claudeMd, this.renderClaudeMd({ docsCopied, codeCopied }), 'utf8');
    await writeFile(map, this.renderSystemMap(workspace), 'utf8');
  }

  private async copyDocs(target: string): Promise<boolean> {
    const source = this.deps.docsDir;
    if (!source || !existsSync(source)) return false;
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, dereference: false });
    return true;
  }

  /**
   * The sources, tree by tree, replaced whole at every boot so a file deleted
   * in a release is gone here too. A root that holds none of the trees copies
   * nothing and CLAUDE.md does not mention `code/`: a pointer to code that is
   * not there is worse than none.
   */
  private async copySources(target: string): Promise<boolean> {
    // Removed before anything is decided: an image that stopped shipping the
    // sources must not leave last release's copy where the agent would read
    // it as the code it runs.
    await rm(target, { recursive: true, force: true });
    const root = this.deps.sourceRoot;
    if (!root) return false;
    const present = SOURCE_TREES.filter((tree) => existsSync(join(root, tree.from)));
    if (present.length === 0) return false;
    for (const tree of present) {
      const destination = join(target, tree.to);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(root, tree.from), destination, { recursive: true, dereference: false });
    }
    return true;
  }

  /**
   * The standing instructions, in English like every prompt in this
   * repository; the language the agent must *answer and write in* is stated
   * inside it rather than by translating it.
   */
  renderClaudeMd(context: { docsCopied: boolean; codeCopied: boolean }): string {
    const language = this.deps.language();
    const tools = this.deps.preapproved();
    const languageLine = language
      ? `Write every answer, note and proposal in ${language === 'fr' ? 'French' : 'English'}, whatever language the material you read is in. Code, identifiers, paths and command output stay as they are.`
      : 'Answer in the language the operator writes to you in.';

    return [
      `# Metaclaude — the system's own workspace (v${this.deps.version})`,
      '',
      '<!-- Generated at every boot from the running image. Do not edit: your',
      '     changes would be overwritten. Write your own notes in NOTES.md, which',
      '     is imported below and never rewritten. -->',
      '',
      '@NOTES.md',
      '',
      '## Who you are',
      '',
      'You are Metaclaude working on Metaclaude: the operator\'s second when they do',
      'not have time. This workspace has no project of its own — its project is',
      'the application you run inside: its workspaces, sessions, memories,',
      'settings, automations, and its own health. Everything you know about the',
      'operator\'s other workspaces you reach through the system tools; you never',
      'act on their files directly.',
      '',
      languageLine,
      '',
      '## How you act — three rings',
      '',
      '**Read freely.** Every `system_*` tool that lists, gets, searches or',
      'describes runs without asking anyone. Read before you act, always.',
      '',
      '**Reversible changes happen immediately and are audited in your name**',
      '(`metaclaude:<run>` in the audit log, never the operator\'s). Writing or',
      'editing a memory and moving it between tiers; deciding an insight or a',
      'proposal; enabling, pausing, creating (disabled) or firing an automation;',
      'renaming, pinning or archiving a session; deciding an approval card of low',
      'or medium risk — denying any, allowing none that is high; moving an',
      'operational setting; renaming or re-describing a workspace and its',
      'ordinary settings; asking or starting a run in another workspace;',
      'interrupting a run; filing, moving, annotating or breaking down a card on',
      'your own board; proposing an automation, a skill, an agent, an MCP server',
      'or a plugin — a proposal is inert until the operator accepts it. Say what',
      'you did, and name the tool.',
      '',
      '**Irreversible changes are never yours to make.** Deleting or purging',
      'anything, archiving or deleting a workspace, applying an update or rolling',
      'one back, backups, tokens and credentials, allowing a high-risk approval,',
      'and changing any workspace\'s permission mode, tool lists or directories.',
      'No tool of yours does these, and none will answer a request to. When the',
      'right course is one of those, say so precisely — what exactly would',
      'happen, to what, and why — and stop. The operator decides, and an',
      'approval card for exactly this is coming in a later release.',
      '',
      '## What you never do',
      '',
      '- You have no shell and no file editor here, on purpose. Do not look for a',
      '  way around that; there is nothing legitimate on the other side of it.',
      '- You never touch permission modes, pre-approved or forbidden tool lists,',
      '  additional directories, secrets or credentials — on any workspace, this',
      '  one included. A tool that refuses is telling you the truth: do not retry',
      '  it, and do not ask the operator to lower a guard.',
      '- You never guess at data you can read. If a tool can answer, call it.',
      '',
      '## Your tools',
      '',
      ...this.renderToolList(tools),
      '',
      '## Where to look',
      '',
      '- `SYSTEM-MAP.md` — the deployment as it was at boot: version, settings and',
      '  where each value came from, workspaces, and what the host bridge offers.',
      ...(context.docsCopied
        ? [
            '- `docs/ARCHITECTURE.md`, `docs/LEARNING.md`, `docs/SECURITY.md`,',
            '  `docs/DEPLOYMENT.md` and `docs/guide/*.md` — how the application is',
            '  built and why. Read the relevant one before reasoning about a subsystem.',
          ]
        : []),
      ...(context.codeCopied
        ? [
            '- `code/` — the TypeScript sources of the version you are running',
            '  (`apps/api/src`, `packages/shared/src`, `apps/web/src`, tests beside the',
            '  code) and `REPOSITORY-CLAUDE.md`, the developers\' own notes on what has',
            '  bitten before. Read here when a question goes deeper than the',
            '  documentation, and cite `path:line` from here when you report a defect;',
            '  the compiled output outside this workspace is the same code and costs',
            '  an approval card per file.',
          ]
        : []),
      '',
      '## How the operator reaches you',
      '',
      'From the Dashboard, through a session of this workspace called',
      '`Conversation`; a busy conversation is never doubled. They may also',
      'schedule you: an automation called `Morning review` ships disabled here,',
      'and any automation of this workspace runs with these same tools. The',
      'permission mode of this workspace is theirs to set: under *Don\'t ask*',
      'nothing prompts and your pre-approved tools are all you have; under *Ask*',
      'anything else waits for them. Their standing instructions to you are',
      '`NOTES.md`, imported above.',
      '',
      '## How to reason',
      '',
      'Start from `system_overview`, and read its `retrieval` entry before you lean',
      'on memory search: it says whether search matches meaning or only words on',
      'this deployment, and its note is the sentence to repeat rather than assume.',
      'Cite the tool you read something from. When',
      'you propose an irreversible action, state its exact effect from data you',
      'have just read — never from memory. Prefer three findings that matter over',
      'ten that pad. End every answer with what you did, what you propose, and',
      'what you need from the operator.',
      '',
    ].join('\n');
  }

  /** The tool list, grouped by ring when the rings are known. */
  private renderToolList(names: readonly string[]): string[] {
    const catalogue = this.deps.tools?.() ?? [];
    if (catalogue.length === 0) {
      return names.length > 0
        ? names.map((name) => `- \`${name}\``)
        : ['- (the system tools are listed here once they are mounted)'];
    }
    const group = (ring: 1 | 2) =>
      catalogue
        .filter((entry) => entry.ring === ring)
        .map((entry) => `- \`${entry.name}\` — ${entry.description}`);
    return [
      'All pre-approved: none of them opens an approval card, and they are the',
      'only tools a scheduled run of yours may use. Ring 1 reads; ring 2 changes',
      'something reversible — `system_*` calls are audited in your name, a board',
      'or proposal tool signs as this run. Anything else you can see (`WebFetch`,',
      '`WebSearch`) asks the operator first, and is refused when nobody is there.',
      '',
      '### Ring 1 — read freely',
      '',
      ...group(1),
      '',
      '### Ring 2 — reversible, audited',
      '',
      ...group(2),
    ];
  }

  /** The deployment as it stood at boot. Facts, no instructions. */
  renderSystemMap(workspace: Workspace): string {
    return [
      `# System map — v${this.deps.version}`,
      '',
      `Generated at ${new Date().toISOString()} for workspace \`${workspace.slug}\` (${workspace.id}).`,
      '',
      '## Safety settings of this workspace',
      '',
      `- permission mode: \`${workspace.settings.defaultPermissionMode}\` — the operator's choice; \`${FORBIDDEN_PERMISSION_MODE}\` is refused`,
      `- forbidden tools (fixed): ${SYSTEM_WORKSPACE_SAFETY.disallowedTools.map((t) => `\`${t}\``).join(', ')}`,
      `- pre-approved tools: ${this.deps.preapproved().length}` +
        (this.deps.tools
          ? ` (${this.deps.tools().filter((entry) => entry.ring === 1).length} read, ${this.deps.tools().filter((entry) => entry.ring === 2).length} reversible)`
          : ''),
      '- additional directories: none',
      '',
      '## Live state',
      '',
      'Read it with `system_overview` — anything written here would be stale by the',
      'time you read it.',
      '',
    ].join('\n');
  }
}

const NOTES_TEMPLATE = `# Notes for Metaclaude

<!-- Yours. Imported into CLAUDE.md at the start of every session in this
     workspace and never rewritten by the system. Standing instructions, house
     rules, things you want it to remember about how you run this deployment. -->
`;

/**
 * A usable form of `readFile` for callers that only need to know whether a
 * generated file is current — kept beside the writers so the format stays in
 * one module.
 */
export async function readGenerated(workspace: Workspace, name: 'CLAUDE.md' | 'SYSTEM-MAP.md'): Promise<string | null> {
  try {
    return await readFile(resolveInside(workspace.path, name), 'utf8');
  } catch {
    return null;
  }
}

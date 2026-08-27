/**
 * The proposal tools — an in-process MCP server, one per run.
 *
 * Mounted for every run, not only the advisor's: any run that notices "this
 * workspace keeps doing X by hand" can propose the automation on the spot.
 * The graduated autonomy lives server-side, in the facade the tools call: an
 * automation is created disabled (inert by construction), everything else
 * becomes an inbox row a person accepts — so nothing a run proposes can act
 * before an operator has read it. Tickets need no tool here: the board
 * server already covers them.
 */

import { createSdkMcpServer, tool as sdkTool } from '@anthropic-ai/claude-agent-sdk';
import type { AdvisorProposal, Automation } from '@metaclaude/shared';
import { AutomationTrigger, LibraryCategory } from '@metaclaude/shared';
import { z } from 'zod';

/** What the tools need from the advisor — the service satisfies it. */
export interface AdvisorFacade {
  propose(input: {
    workspaceId: string;
    runId: string | null;
    kind: AdvisorProposal['kind'];
    name: string;
    summary: string;
    rationale: string;
    payload: Record<string, unknown>;
  }): AdvisorProposal;
  proposeAutomation(input: {
    workspaceId: string;
    name: string;
    description: string;
    prompt: string;
    trigger: Automation['trigger'];
    rationale: string;
  }): Automation;
}

export interface AdvisorToolScope {
  workspaceId: string;
  runId: string;
}

const asToolResult = (fn: () => unknown) => {
  try {
    return { content: [{ type: 'text' as const, text: JSON.stringify(fn(), null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: (error as Error).message }],
      isError: true,
    };
  }
};

const NAME = z.string().min(1).max(64);
const RATIONALE = z
  .string()
  .min(1)
  .max(4000)
  .describe('Why this workspace wants it — the operator decides on this text.');
const SUMMARY = z.string().min(1).max(500).describe('One line: what this is.');

/** What the inbox row shows for a proposal, compactly. */
const receipt = (proposal: AdvisorProposal) => ({
  id: proposal.id,
  kind: proposal.kind,
  name: proposal.name,
  status: proposal.status,
  note: 'Filed to the advisor inbox; the operator will accept or dismiss it.',
});

export function createAdvisorHandlers(advisor: AdvisorFacade, scope: AdvisorToolScope) {
  const file = (
    kind: AdvisorProposal['kind'],
    name: string,
    summary: string,
    rationale: string,
    payload: Record<string, unknown>,
  ) =>
    receipt(
      advisor.propose({
        workspaceId: scope.workspaceId,
        runId: scope.runId,
        kind,
        name,
        summary,
        rationale,
        payload,
      }),
    );

  return {
    automation(args: {
      name: string;
      description: string;
      prompt: string;
      trigger: Automation['trigger'];
      rationale: string;
    }) {
      const automation = advisor.proposeAutomation({
        workspaceId: scope.workspaceId,
        name: args.name,
        description: args.description,
        prompt: args.prompt,
        trigger: args.trigger,
        rationale: args.rationale,
      });
      return {
        id: automation.id,
        name: automation.name,
        enabled: automation.enabled,
        note: 'Created disabled; the operator enables it from the Automations page.',
      };
    },

    skill(args: {
      name: string;
      description: string;
      body: string;
      category?: string;
      rationale: string;
    }) {
      return file('skill', args.name, args.description, args.rationale, {
        name: args.name,
        description: args.description,
        body: args.body,
        ...(args.category !== undefined ? { category: args.category } : {}),
      });
    },

    agent(args: {
      name: string;
      description: string;
      prompt: string;
      category?: string;
      rationale: string;
    }) {
      return file('agent', args.name, args.description, args.rationale, {
        name: args.name,
        description: args.description,
        prompt: args.prompt,
        ...(args.category !== undefined ? { category: args.category } : {}),
      });
    },

    mcp(args: {
      name: string;
      summary: string;
      transport: 'stdio' | 'sse' | 'http';
      command?: string;
      args?: string[];
      url?: string;
      publisher: string;
      rationale: string;
    }) {
      return file('mcp', args.name, args.summary, args.rationale, {
        name: args.name,
        transport: args.transport,
        command: args.command ?? null,
        args: args.args ?? [],
        url: args.url ?? null,
        publisher: args.publisher,
      });
    },

    plugin(args: { name: string; summary: string; source: string; rationale: string }) {
      return file('plugin', args.name, args.summary, args.rationale, {
        name: args.name,
        source: args.source,
      });
    },
  };
}

export function buildAdvisorServer(
  advisor: AdvisorFacade,
  scope: AdvisorToolScope,
): ReturnType<typeof createSdkMcpServer> {
  const handlers = createAdvisorHandlers(advisor, scope);

  return createSdkMcpServer({
    name: 'metaclaude_advisor',
    version: '1.0.0',
    tools: [
      sdkTool(
        'advisor_propose_automation',
        'Create a scheduled automation for this workspace, DISABLED — the operator reads your ' +
          'rationale on the Automations page and decides whether to switch it on. Use for work ' +
          'you have seen repeated by hand.',
        {
          name: z.string().min(1).max(120),
          description: z.string().max(2000).default(''),
          prompt: z.string().min(1).max(100_000).describe('What each firing should do, complete and standalone.'),
          trigger: AutomationTrigger,
          rationale: RATIONALE,
        },
        async (args) => asToolResult(() => handlers.automation(args)),
      ),
      sdkTool(
        'advisor_propose_skill',
        'Propose a new skill (a reusable procedure) for the operator to accept. Write it ' +
          'complete: markdown body opening with a heading, with a definition of done.',
        {
          name: NAME,
          description: z.string().min(1).max(1024),
          body: z.string().min(1).max(200_000),
          category: LibraryCategory.optional(),
          rationale: RATIONALE,
        },
        async (args) => asToolResult(() => handlers.skill(args)),
      ),
      sdkTool(
        'advisor_propose_agent',
        'Propose a new subagent (a named prompt with its own working rules) for the operator ' +
          'to accept. The description must say when to delegate to it.',
        {
          name: NAME,
          description: z.string().min(1).max(1024),
          prompt: z.string().min(1).max(100_000),
          category: LibraryCategory.optional(),
          rationale: RATIONALE,
        },
        async (args) => asToolResult(() => handlers.agent(args)),
      ),
      sdkTool(
        'advisor_propose_mcp',
        'Propose an MCP server from a recognised publisher. An embedded allowlist is enforced ' +
          'server-side: a stdio proposal must name a package under a trusted npm scope, a ' +
          'remote one must live on a trusted host. Never propose credentials — the operator ' +
          'adds secrets themselves.',
        {
          name: NAME,
          summary: SUMMARY,
          transport: z.enum(['stdio', 'sse', 'http']),
          command: z.string().max(1024).optional().describe('stdio only: the executable, e.g. npx.'),
          args: z.array(z.string().max(1024)).max(64).optional().describe('stdio only.'),
          url: z.string().max(2048).optional().describe('sse/http only: the https endpoint.'),
          publisher: z.string().min(1).max(200).describe('Who publishes it, e.g. "GitHub".'),
          rationale: RATIONALE,
        },
        async (args) => asToolResult(() => handlers.mcp(args)),
      ),
      sdkTool(
        'advisor_propose_plugin',
        'Propose a plugin worth installing, naming a source the operator can verify — a ' +
          'configured marketplace, or a repository URL. Nothing installs until they act.',
        {
          name: z.string().min(1).max(120),
          summary: SUMMARY,
          source: z
            .string()
            .min(1)
            .max(500)
            .describe('Marketplace name, owner/repo, or URL — where the operator finds it.'),
          rationale: RATIONALE,
        },
        async (args) => asToolResult(() => handlers.plugin(args)),
      ),
    ],
  });
}

/**
 * The contracts, where they carry a rule rather than just a shape.
 *
 * Most schemas here are field lists and testing them would restate the file.
 * These are the ones where the schema *decides* something — what a login may
 * carry, what a default means — and where getting it wrong locks someone out of
 * their own server.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ClaudeCliSession,
  ClaudePairingBeginInput,
  ClaudePairingCodeInput,
  LoginRequest,
  PasskeyLoginFinishRequest,
  PasskeyRegisterFinishRequest,
  PatchKnowledgeRequest,
  PushSubscriptionInput,
  RewindRequest,
  patchSchema,
  SaveKnowledgeRequest,
  UploadKnowledgeRequest,
} from './api-contracts.js';
import {
  Automation,
  MarketplaceInput,
  normaliseTags,
  RunPolicy,
  WorkspaceSettings,
} from './domain.js';

const base = { username: 'owner', password: 'a-long-enough-password' };

describe('LoginRequest — the second factor', () => {
  it('accepts a six-digit TOTP code', () => {
    expect(LoginRequest.safeParse({ ...base, totp: '123456' }).success).toBe(true);
  });

  it('accepts a recovery code', () => {
    // The bug this pins. Recovery codes are generated as `XXXXX-XXXXX` from a
    // no-lookalike alphabet, the login form says in so many words that "a
    // recovery code also works here", and the field was `/^\d{6}$/` — so the
    // route answered 400 before the code was ever checked.
    //
    // Nothing recovered from a lost TOTP device. The codes were generated,
    // displayed, and told to be kept somewhere safe, and they were dead on
    // arrival; the only way back into the box was editing SQLite by hand.
    expect(LoginRequest.safeParse({ ...base, totp: 'ABCDE-FGHJK' }).success).toBe(true);
  });

  it('accepts a recovery code the operator typed in lower case', () => {
    // `consumeSecondFactor` upper-cases before comparing, so the schema must not
    // be stricter than the check behind it.
    expect(LoginRequest.safeParse({ ...base, totp: 'abcde-fghjk' }).success).toBe(true);
  });

  it('still rejects anything that is neither shape', () => {
    // The field is bounded so the verifier is never handed something absurd.
    for (const totp of ['', '12345', '1234567', 'ABCDEFGHJK', 'ABCDE_FGHJK', 'ABCDE-FGHJ', "' OR 1=1", 'x'.repeat(200)]) {
      expect(LoginRequest.safeParse({ ...base, totp }).success).toBe(false);
    }
  });

  it('leaves the second factor optional, because most logins have none', () => {
    expect(LoginRequest.safeParse(base).success).toBe(true);
  });

  it('bounds the username and password rather than trusting them', () => {
    expect(LoginRequest.safeParse({ ...base, username: '' }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...base, username: 'u'.repeat(65) }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...base, password: '' }).success).toBe(false);
    expect(LoginRequest.safeParse({ ...base, password: 'p'.repeat(1025) }).success).toBe(false);
  });
});

describe('RewindRequest', () => {
  it('previews when the caller says nothing', () => {
    // The default is the safety property: a request that forgets its body must
    // preview rather than overwrite a working tree.
    expect(RewindRequest.parse({})).toEqual({ dryRun: true });
  });

  it('applies only when asked explicitly', () => {
    expect(RewindRequest.parse({ dryRun: false })).toEqual({ dryRun: false });
  });
});

describe('WorkspaceSettings defaults', () => {
  it('fills every field from an empty object', () => {
    // Repositories persist whatever this produces, and the kernel reads the
    // result without checking for undefined.
    const settings = WorkspaceSettings.parse({});

    for (const [key, value] of Object.entries(settings)) {
      expect(value, `${key} is undefined`).not.toBeUndefined();
    }
  });

  it('defaults checkpointing on, which is what makes a run rewindable', () => {
    expect(WorkspaceSettings.parse({}).checkpointing).toBe(true);
  });

  /**
   * `delegable` is an opt-*out*, and the default is the whole of it.
   *
   * Every workspace row written before the field existed carries settings JSON
   * without the key — measured on a real deployment, where the stored objects
   * had 20 keys against the schema's 21, `language` being the one missing and
   * healed by its default at read. `toWorkspace` reparses through this schema
   * on every read, so the default is what those rows get. A default of `false`
   * would therefore not mean "off until you choose": it would silently make
   * every existing workspace unreachable, with nothing in the interface saying
   * why.
   */
  it('defaults delegable on, so a workspace written before the field is still reachable', () => {
    expect(WorkspaceSettings.parse({}).delegable).toBe(true);
  });

  it('keeps an explicit opt-out', () => {
    expect(WorkspaceSettings.parse({ delegable: false }).delegable).toBe(false);
  });

  it('rejects a permission mode outside the known set', () => {
    expect(WorkspaceSettings.safeParse({ defaultPermissionMode: 'yolo' }).success).toBe(false);
  });
});

describe('RunPolicy — ultracode', () => {
  const base = {
    model: 'opus',
    effort: 'xhigh',
    permissionMode: 'default',
    thinking: 'adaptive',
    thinkingBudgetTokens: null,
    agentName: null,
    source: 'explicit',
  };

  it('defaults to off, so every policy written before the field existed still parses', () => {
    const parsed = RunPolicy.parse(base);
    expect(parsed.ultracode).toBe(false);
  });

  it('round-trips an explicit true', () => {
    expect(RunPolicy.parse({ ...base, ultracode: true }).ultracode).toBe(true);
  });
});

describe('MarketplaceInput', () => {
  it('accepts a GitHub owner/repo source', () => {
    const parsed = MarketplaceInput.safeParse({
      name: 'anthropic-tools',
      source: { source: 'github', repo: 'anthropics/claude-plugins' },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a direct marketplace.json URL, https only', () => {
    expect(
      MarketplaceInput.safeParse({
        name: 'internal',
        source: { source: 'url', url: 'https://plugins.example.com/marketplace.json' },
      }).success,
    ).toBe(true);
    // http would hand the CLI a plaintext source of executable skill content.
    expect(
      MarketplaceInput.safeParse({
        name: 'internal',
        source: { source: 'url', url: 'http://plugins.example.com/marketplace.json' },
      }).success,
    ).toBe(false);
  });

  it('rejects a repo that is not owner/repo — including the owner-wildcard form', () => {
    // "owner/*" is meaningful only in managed policy lists; everywhere else the
    // CLI takes it literally and fails to clone. Refuse it at the edge instead
    // of storing a marketplace that can never load.
    for (const repo of ['anthropics', 'anthropics/*', 'a/b/c', '', 'owner/.git\0']) {
      expect(
        MarketplaceInput.safeParse({ name: 'm', source: { source: 'github', repo } }).success,
      ).toBe(false);
    }
  });

  it('constrains the name to what a plugin@marketplace key can carry', () => {
    // The name becomes both the extraKnownMarketplaces key and the suffix of
    // every enabledPlugins entry; spaces or @ would make those unparseable.
    for (const name of ['has space', 'has@at', '', 'x'.repeat(65)]) {
      expect(
        MarketplaceInput.safeParse({
          name,
          source: { source: 'github', repo: 'a/b' },
        }).success,
      ).toBe(false);
    }
  });
});

describe('WorkspaceSettings — enabledPlugins', () => {
  it('defaults to an empty record so every stored row still parses', () => {
    expect(WorkspaceSettings.parse({}).enabledPlugins).toEqual({});
  });

  it('accepts plugin@marketplace keys and rejects keys without a marketplace', () => {
    expect(
      WorkspaceSettings.safeParse({ enabledPlugins: { 'formatter@anthropic-tools': true } })
        .success,
    ).toBe(true);
    expect(WorkspaceSettings.safeParse({ enabledPlugins: { formatter: true } }).success).toBe(
      false,
    );
  });
});

describe('ClaudeCliSession', () => {
  it('normalises the CLI listing: optional fields become explicit nulls', () => {
    const parsed = ClaudeCliSession.parse({
      sessionId: 'abc-123',
      summary: 'Fix the parser',
      lastModified: 1000,
    });
    expect(parsed).toMatchObject({
      firstPrompt: null,
      gitBranch: null,
      cwd: null,
      createdAt: null,
      adoptedBy: null,
    });
  });

  it('carries the adoption link when one exists', () => {
    const parsed = ClaudeCliSession.parse({
      sessionId: 'abc-123',
      summary: 'Fix the parser',
      lastModified: 1000,
      adoptedBy: 'ses_9',
    });
    expect(parsed.adoptedBy).toBe('ses_9');
  });
});

describe('the pairing contracts', () => {
  // The auth.test lesson, again: a feature the edge schema rejects is dead
  // while its service tests stay green. What may be *submitted* is decided
  // here, so it is tested here.
  it('defaults the account surface to claude.ai and rejects unknown ones', () => {
    expect(ClaudePairingBeginInput.parse({}).account).toBe('claudeai');
    expect(ClaudePairingBeginInput.parse({ account: 'console' }).account).toBe('console');
    expect(ClaudePairingBeginInput.safeParse({ account: 'github' }).success).toBe(false);
  });

  it('requires a code, and bounds it', () => {
    expect(ClaudePairingCodeInput.safeParse({ code: '' }).success).toBe(false);
    expect(ClaudePairingCodeInput.safeParse({}).success).toBe(false);
    expect(ClaudePairingCodeInput.safeParse({ code: 'a'.repeat(4097) }).success).toBe(false);
    expect(ClaudePairingCodeInput.parse({ code: 'abc#def' }).code).toBe('abc#def');
  });
});

describe('the passkey contracts', () => {
  // What @simplewebauthn/browser actually produces: the schema only reads
  // `id`, but everything else must SURVIVE the edge — zod strips unknown keys
  // by default, and a stripped clientDataJSON fails every ceremony as "did
  // not verify" with nothing wrong on either end.
  const browserResponse = {
    id: 'y3z1…',
    rawId: 'y3z1…',
    type: 'public-key',
    response: { clientDataJSON: 'eyJ0eXBlIjo…', authenticatorData: 'x', signature: 'y' },
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
  };

  it('keeps the fields the verifier reads, not just the ones the schema does', () => {
    const parsed = PasskeyLoginFinishRequest.safeParse({
      ceremonyId: 'c1',
      response: browserResponse,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    const kept = parsed.data.response as typeof browserResponse;
    expect(kept.response.clientDataJSON).toBe(browserResponse.response.clientDataJSON);
    expect(kept.clientExtensionResults).toEqual({});
  });

  it('does the same for enrolment, and bounds the label', () => {
    const parsed = PasskeyRegisterFinishRequest.safeParse({
      label: 'My phone',
      response: browserResponse,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect((parsed.data.response as typeof browserResponse).rawId).toBe(browserResponse.rawId);

    expect(
      PasskeyRegisterFinishRequest.safeParse({ label: 'x'.repeat(61), response: browserResponse })
        .success,
    ).toBe(false);
  });

  it('refuses a response with no credential id', () => {
    expect(
      PasskeyLoginFinishRequest.safeParse({ ceremonyId: 'c1', response: { id: '' } }).success,
    ).toBe(false);
    expect(PasskeyLoginFinishRequest.safeParse({ ceremonyId: 'c1' }).success).toBe(false);
  });
});

describe('PushSubscriptionInput', () => {
  const good = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'BPk', auth: 'a1' },
  };

  it('accepts what PushManager.subscribe produces', () => {
    expect(PushSubscriptionInput.safeParse(good).success).toBe(true);
  });

  it('refuses a plaintext endpoint — that is where encrypted payloads go', () => {
    expect(
      PushSubscriptionInput.safeParse({ ...good, endpoint: 'http://fcm.example/x' }).success,
    ).toBe(false);
  });

  it('requires both keys and bounds everything', () => {
    expect(PushSubscriptionInput.safeParse({ ...good, keys: { p256dh: 'x' } }).success).toBe(false);
    expect(
      PushSubscriptionInput.safeParse({ ...good, endpoint: `https://x.example/${'a'.repeat(2048)}` })
        .success,
    ).toBe(false);
  });
});

describe('SaveKnowledgeRequest — the edge that guards the knowledge library', () => {
  const good = { title: 'Bail', content: 'Le préavis est de 45 jours.' };

  it('accepts a plain document and defaults the scope to global', () => {
    const parsed = SaveKnowledgeRequest.parse(good);
    expect(parsed.workspaceId).toBeNull();
    expect(parsed.id).toBeUndefined();
  });

  it('is strict: an unknown key is a refused request, not an ignored one', () => {
    // The auth recovery-code lesson: a contract that silently drops what it
    // does not know hides the client bug that sent it.
    expect(SaveKnowledgeRequest.safeParse({ ...good, chunkCount: 5 }).success).toBe(false);
  });

  it('bounds both the title and the content at the same caps the store enforces', () => {
    expect(SaveKnowledgeRequest.safeParse({ ...good, title: '' }).success).toBe(false);
    expect(SaveKnowledgeRequest.safeParse({ ...good, title: 'x'.repeat(301) }).success).toBe(false);
    expect(
      SaveKnowledgeRequest.safeParse({ ...good, content: 'x'.repeat(512 * 1024 + 1) }).success,
    ).toBe(false);
  });

  it('accepts an explicit workspace scope and an explicit enabled flag', () => {
    const parsed = SaveKnowledgeRequest.parse({ ...good, workspaceId: 'ws_1', enabled: false });
    expect(parsed.workspaceId).toBe('ws_1');
    expect(parsed.enabled).toBe(false);
  });

  it('carries a reach when the form sends one, and leaves it absent otherwise', () => {
    // Absent means untouched, the skills rule: a form that saves a title must
    // not silently narrow a reach it never showed.
    expect(SaveKnowledgeRequest.parse(good).reach).toBeUndefined();
    const parsed = SaveKnowledgeRequest.parse({
      ...good,
      reach: { global: false, workspaceIds: ['ws_1', 'ws_2'] },
    });
    expect(parsed.reach).toEqual({ global: false, workspaceIds: ['ws_1', 'ws_2'] });
  });

  it('refuses a reach missing its global flag — half a reach is not a reach', () => {
    expect(
      SaveKnowledgeRequest.safeParse({ ...good, reach: { workspaceIds: [] } }).success,
    ).toBe(false);
  });
});

describe('UploadKnowledgeRequest — the edge a dropped file arrives through', () => {
  const good = {
    name: 'bail.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    data: 'UEsDBBQ=',
    reach: { global: true, workspaceIds: [] },
  };

  it('accepts what the browser sends', () => {
    const parsed = UploadKnowledgeRequest.parse(good);
    expect(parsed.name).toBe('bail.docx');
    expect(parsed.title).toBeUndefined();
  });

  it('defaults the MIME to empty, because some browsers send nothing for a .md', () => {
    // Measured in the attachments: a drag-dropped .md arrives with an empty
    // type on several platforms. The extension decides underneath; the
    // contract must not refuse the upload before it gets there.
    expect(UploadKnowledgeRequest.parse({ ...good, mime: undefined }).mime).toBe('');
  });

  it('refuses an empty payload, a nameless file and a missing reach', () => {
    expect(UploadKnowledgeRequest.safeParse({ ...good, data: '' }).success).toBe(false);
    expect(UploadKnowledgeRequest.safeParse({ ...good, name: '' }).success).toBe(false);
    expect(UploadKnowledgeRequest.safeParse({ ...good, reach: undefined }).success).toBe(false);
  });

  it('is strict, so a client field nobody reads is a loud error rather than a silent drop', () => {
    expect(UploadKnowledgeRequest.safeParse({ ...good, workspaceId: 'ws_1' }).success).toBe(false);
  });

  it('takes an optional title, bounded like a document title', () => {
    expect(UploadKnowledgeRequest.parse({ ...good, title: 'Bail 2026' }).title).toBe('Bail 2026');
    expect(UploadKnowledgeRequest.safeParse({ ...good, title: 'x'.repeat(301) }).success).toBe(
      false,
    );
  });
});

describe('PatchKnowledgeRequest — one field changed, nothing else touched', () => {
  it('a patch naming one field carries no other', () => {
    // The `.partial()` trap: a patch that arrives carrying every other field
    // at its default resets what the operator never touched.
    expect(PatchKnowledgeRequest.parse({ enabled: false })).toEqual({ enabled: false });
    expect(PatchKnowledgeRequest.parse({ title: 'Bail' })).toEqual({ title: 'Bail' });
    expect(Object.keys(PatchKnowledgeRequest.parse({}))).toEqual([]);
  });

  it('carries a reach when it is the reach that changed', () => {
    expect(
      PatchKnowledgeRequest.parse({ reach: { global: true, workspaceIds: [] } }).reach,
    ).toEqual({ global: true, workspaceIds: [] });
  });

  it('still bounds what it accepts', () => {
    expect(PatchKnowledgeRequest.safeParse({ title: '' }).success).toBe(false);
    expect(PatchKnowledgeRequest.safeParse({ enabled: 'yes' }).success).toBe(false);
  });
});


describe('normaliseTags', () => {
  /**
   * Shared because three writers reach memory and one of them is the web. A
   * rule kept in two places is how `Bail` and `bail` came to be two tags.
   */
  it('folds case, trims, and drops the empties', () => {
    expect(normaliseTags(['  Bail ', 'BAIL', 'bail', '', '   ', 'Logement'])).toEqual([
      'bail',
      'logement',
    ]);
  });

  it('folds before capping, so the budget is not spent on variants', () => {
    // Capping first would fill 24 slots with 12 words seen twice.
    const noisy = Array.from({ length: 20 }, (_, i) => [`Tag${i}`, `tag${i}`]).flat();
    expect(normaliseTags(noisy)).toHaveLength(20);
  });

  it('still caps a genuinely long list', () => {
    expect(normaliseTags(Array.from({ length: 60 }, (_, i) => `tag${i}`))).toHaveLength(24);
  });

  it('preserves the order tags were first seen in', () => {
    // The list is displayed as-is; re-ordering it on every save would make an
    // unrelated edit look like a change.
    expect(normaliseTags(['zèbre', 'Alpha', 'ZÈBRE'])).toEqual(['zèbre', 'alpha']);
  });

  it('keeps accents, which are content and not case', () => {
    expect(normaliseTags(['Préavis'])).toEqual(['préavis']);
  });
});

/**
 * The answer language, at the contract.
 *
 * `auto` has to be the default and has to survive every workspace stored
 * before the field existed — a settings blob that suddenly failed to parse
 * would take the workspace with it. The two explicit values are the only
 * others accepted: an unknown one must be refused at the edge rather than
 * reach a system prompt.
 */
describe('WorkspaceSettings.language', () => {
  it('defaults to auto, including for settings written before it existed', () => {
    expect(WorkspaceSettings.parse({}).language).toBe('auto');
    expect(WorkspaceSettings.parse({ memoryEnabled: false }).language).toBe('auto');
  });

  it('accepts the two explicit languages and nothing else', () => {
    expect(WorkspaceSettings.parse({ language: 'fr' }).language).toBe('fr');
    expect(WorkspaceSettings.parse({ language: 'en' }).language).toBe('en');
    expect(WorkspaceSettings.safeParse({ language: 'de' }).success).toBe(false);
    expect(WorkspaceSettings.safeParse({ language: '' }).success).toBe(false);
  });
});

/**
 * A patch schema that does not quietly rewrite what the request never named.
 *
 * `z.object({…}).partial()` reads as "every field optional", and it is — but a
 * field declared with `.default()` still *fires its default* when the key is
 * absent. So `WorkspaceSettings.partial().parse({ allowedTools: ['Bash'] })`
 * comes back carrying all twenty-one settings, and a repository that merges
 * the patch over the stored row resets every one of them.
 *
 * That is not hypothetical. The automations list toggles an automation with
 * `PATCH { enabled }` and nothing else; `AutomationInput.partial()` handed the
 * route `description: ''`, `continuous: false` and `maxConsecutiveFailures: 3`
 * alongside it, and `scheduler.update` took each as an instruction. Flipping
 * the switch erased the automation's description, turned off a continuous
 * loop and reset a custom failure ceiling — silently, on the one control an
 * operator uses most.
 *
 * `patchSchema` strips the default before making the field optional, so an
 * absent key stays absent all the way to the merge.
 */
describe('patchSchema', () => {
  const Example = z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    count: z.number().int().default(3),
    flag: z.boolean().default(false),
    nullable: z.number().nullable().default(null),
  });

  it('keeps only the keys the request actually named', () => {
    const parsed = patchSchema(Example).parse({ name: 'x' });
    expect(Object.keys(parsed)).toEqual(['name']);
  });

  it('is exactly what partial() gets wrong, so the contrast is the point', () => {
    // Pinning the upstream behaviour: if a future Zod stops applying defaults
    // under `.partial()`, this fails and the helper can be reconsidered rather
    // than kept out of habit.
    expect(Object.keys(Example.partial().parse({ name: 'x' })).length).toBe(5);
  });

  it('still validates the values it is given', () => {
    expect(patchSchema(Example).safeParse({ count: 'many' }).success).toBe(false);
    expect(patchSchema(Example).safeParse({ name: '' }).success).toBe(false);
    expect(patchSchema(Example).safeParse({}).success).toBe(true);
  });

  it('lets an explicit value through, including one equal to the default', () => {
    expect(patchSchema(Example).parse({ description: '' })).toEqual({ description: '' });
    expect(patchSchema(Example).parse({ nullable: null })).toEqual({ nullable: null });
    expect(patchSchema(Example).parse({ flag: false })).toEqual({ flag: false });
  });

  it('is still an object schema, so a route can omit a field from it', () => {
    const narrowed = patchSchema(Example).omit({ name: true });
    expect(narrowed.safeParse({ name: 'x' }).success).toBe(true); // stripped, not rejected
    expect(Object.keys(narrowed.parse({ name: 'x', count: 9 }))).toEqual(['count']);
  });

  it('does the job for the two contracts that actually carry defaults', () => {
    expect(Object.keys(patchSchema(WorkspaceSettings).parse({ allowedTools: ['Bash'] }))).toEqual([
      'allowedTools',
    ]);
    expect(Object.keys(patchSchema(Automation.shape.policy.removeDefault()).parse({
      permissionMode: 'dontAsk',
    }))).toEqual(['permissionMode']);
  });
});

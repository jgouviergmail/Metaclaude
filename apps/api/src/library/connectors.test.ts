import { describe, expect, it } from 'vitest';

import { LIBRARY_CATEGORIES } from '@metaclaude/shared';

import { checkMcpTrust } from '../services/advisor.js';
import { CONNECTORS } from './connectors.js';
import { LIBRARY } from './catalog.js';

// The registry's own MCP name rule, duplicated on purpose — same reason as the
// catalogue's: the directory's promise is that every entry INSTALLS.
const REGISTRY_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

describe('the built-in connector directory', () => {
  it('names every connector so the registry will accept it, uniquely', () => {
    for (const connector of CONNECTORS) {
      expect(connector.name, `"${connector.name}" would be refused by the registry`).toMatch(
        REGISTRY_NAME,
      );
    }
    const names = CONNECTORS.map((connector) => connector.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('vouches for every publisher through the advisor’s own allowlist', () => {
    // The tie that makes this directory safe to grow: the advisor refuses to
    // propose an MCP server from a publisher this repository has not vouched
    // for, and a curated entry must clear the same bar. Without this, the
    // directory would become a second, laxer trust surface — and the one an
    // operator clicks rather than reviews.
    for (const connector of CONNECTORS) {
      expect(() =>
        checkMcpTrust({
          name: connector.name,
          transport: connector.transport,
          command: connector.command,
          args: [...connector.args],
          url: connector.url,
          publisher: connector.publisher,
        }),
      ).not.toThrow();
    }
  });

  it('gives every connector what its transport requires, over https', () => {
    for (const connector of CONNECTORS) {
      if (connector.transport === 'stdio') {
        expect(connector.command, `${connector.name} is stdio and needs a command`).toBeTruthy();
        expect(connector.url, `${connector.name} is stdio and must not carry a URL`).toBeNull();
        continue;
      }
      expect(connector.command, `${connector.name} is remote and must not carry a command`).toBeNull();
      // Plain http would put the pasted credential on the wire in clear.
      expect(connector.url, connector.name).toMatch(/^https:\/\//);
    }
  });

  it('never ships a credential value, only the name of one', () => {
    // The single rule that must not lapse. A hint is prose for a human; a key
    // is a header or variable name. Anything that looks like a token — a long
    // opaque run of characters, or one of the well-known secret prefixes — is
    // a leak, and this file is public.
    const SECRET_SHAPED = /\b(?:gh[pousr]_|sk_(?:live|test)_|ntn_|hf_|xox[baprs]-|AIza)[A-Za-z0-9_-]{8,}/;
    for (const connector of CONNECTORS) {
      const credential = connector.credential;
      if (!credential) continue;
      expect(credential.key, `${connector.name}: a key is a name, not a value`).toMatch(
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
      );
      const text = `${credential.prefix} ${credential.hint} ${connector.description}`;
      expect(text, `${connector.name} looks like it carries a credential`).not.toMatch(
        SECRET_SHAPED,
      );
    }
  });

  it('tells the operator where the credential comes from, when it needs one', () => {
    for (const connector of CONNECTORS) {
      const credential = connector.credential;
      if (!credential) continue;
      // An MCP server the operator cannot authenticate is worse than absent:
      // it installs, fails, and reads as Metaclaude's fault.
      expect(credential.hint.trim().length, `${connector.name}: hint too thin`).toBeGreaterThanOrEqual(40);
      if (credential.kind === 'env') {
        expect(credential.prefix, `${connector.name}: an env var takes no scheme prefix`).toBe('');
        expect(credential.key, `${connector.name}: env vars are SHOUTED`).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
      // A scheme word is a word plus its separating space, or nothing at all.
      if (credential.prefix) expect(credential.prefix, connector.name).toMatch(/^\S+ $/);
    }
  });

  it('describes every connector in one line, and cites where the facts came from', () => {
    for (const connector of CONNECTORS) {
      expect(connector.description, connector.name).toBe(connector.description.trim());
      expect(connector.description, connector.name).not.toContain('\n');
      expect(connector.description.length, `${connector.name}: description too thin`).toBeGreaterThanOrEqual(40);
      expect(connector.description.length, `${connector.name}: description is an essay`).toBeLessThanOrEqual(200);
      expect(connector.title.trim().length, connector.name).toBeGreaterThan(0);
      expect(connector.publisher.trim().length, connector.name).toBeGreaterThan(0);
      // Every fact in an entry — the URL, the header name, the package — was
      // read from the publisher. The link is how the next contributor checks
      // it without repeating the search.
      expect(connector.docsUrl, `${connector.name}: cite the publisher's own page`).toMatch(
        /^https:\/\//,
      );
    }
  });

  it('files every connector under the library’s own vocabulary', () => {
    // Deliberately the same taxonomy as the skills and subagents rather than a
    // second one: the chips, the labels and their French translations already
    // exist, and a connector belongs beside the entries that would use it.
    for (const connector of CONNECTORS) {
      expect(LIBRARY_CATEGORIES, `"${connector.name}" claims category "${connector.category}"`).toContain(
        connector.category,
      );
    }
  });

  it('keeps connector names clear of library entries', () => {
    // Not a registry constraint — skills, agents and MCP servers are separate
    // tables — but an operator reading "install stripe" on two different cards
    // has no way to tell which shelf answered.
    const library = new Set(LIBRARY.map((entry) => entry.name));
    for (const connector of CONNECTORS) {
      expect(library, `"${connector.name}" is already a library entry`).not.toContain(connector.name);
    }
  });
});

import { describe, expect, it } from 'vitest';

import { LIBRARY_CATEGORIES } from '@metaclaude/shared';

import { LIBRARY } from './catalog.js';

// The registry's own name rule, duplicated on purpose: the library's promise
// is that every entry INSTALLS, so the test must fail the day either side
// drifts — a looser catalogue or a stricter registry.
const REGISTRY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

describe('the built-in library catalogue', () => {
  it('has entries of both kinds', () => {
    expect(LIBRARY.some((entry) => entry.kind === 'agent')).toBe(true);
    expect(LIBRARY.some((entry) => entry.kind === 'skill')).toBe(true);
  });

  it('names every entry uniquely, across kinds', () => {
    // Install is addressed by name alone, so a skill and an agent may not
    // share one — uniqueness within each kind is not enough.
    const names = LIBRARY.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names every entry so the registry will accept it', () => {
    for (const entry of LIBRARY) {
      expect(entry.name, `"${entry.name}" would be refused by the registry`).toMatch(REGISTRY_NAME);
    }
  });

  it('keeps every category inside the shared vocabulary', () => {
    // The field is typed, but a cast or a vocabulary change slips past the
    // compiler; the runtime check is what the install path relies on.
    for (const entry of LIBRARY) {
      expect(LIBRARY_CATEGORIES, `"${entry.name}" claims category "${entry.category}"`).toContain(
        entry.category,
      );
    }
  });

  it('covers every category with at least one entry', () => {
    // The UI filters by category chip; a chip that matches nothing reads as
    // broken, so the shelf must stock each shelf label it shows.
    const covered = new Set(LIBRARY.map((entry) => entry.category));
    for (const category of LIBRARY_CATEGORIES) {
      expect(covered, `no library entry in category "${category}"`).toContain(category);
    }
  });

  it('describes every entry in one line, substantial but short', () => {
    for (const entry of LIBRARY) {
      expect(entry.description, entry.name).toBe(entry.description.trim());
      expect(entry.description, entry.name).not.toContain('\n');
      expect(entry.description.length, `${entry.name}: description too thin`).toBeGreaterThanOrEqual(40);
      expect(entry.description.length, `${entry.name}: description is an essay`).toBeLessThanOrEqual(200);
    }
  });

  /**
   * The file's own header states the rule: an agent's description is what the
   * *main* agent reads when deciding whether to delegate, so it has to say
   * when to reach for it and not only what it does. The four engineering
   * agents written first all carry one — "Use before merging", "Use after a
   * feature lands without coverage" — and the ten personal-life agents added
   * later carry none at all. A convention nothing enforces is a convention
   * that survives exactly one batch of new entries.
   */
  it('tells the delegating agent when to reach for each subagent', () => {
    const TRIGGER = /\b(use (when|before|after|for|to)|reach for)\b/i;
    const missing = LIBRARY.filter(
      (entry) => entry.kind === 'agent' && !TRIGGER.test(entry.description),
    ).map((entry) => entry.name);

    expect(missing, 'agent descriptions with no trigger clause').toEqual([]);
  });

  it('gives every agent a working prompt, not a slogan', () => {
    for (const entry of LIBRARY) {
      if (entry.kind !== 'agent') continue;
      expect(entry.prompt.trim().length, entry.name).toBeGreaterThanOrEqual(300);
    }
  });

  it('makes every health and money entry state its limit', () => {
    // The life half of the shelf touches domains where a confident agent is a
    // dangerous one. An entry filed under health or money must say, in the
    // text the model actually reads, that it is not professional advice —
    // otherwise a future contributor adds a symptom-checker and nothing
    // objects. (admin-navigator carries the same sentence for legal advice;
    // it is filed under home, so this rule cannot reach it — its own prompt
    // is where that guard lives.)
    const DISCLAIMER: Partial<Record<string, RegExp>> = {
      health: /not medical advice/i,
      money: /not financial advice/i,
    };

    for (const entry of LIBRARY) {
      const required = DISCLAIMER[entry.category];
      if (!required) continue;
      // Line breaks are wrapping, not content: a reader sees one sentence, so
      // the assertion should too.
      const text = (entry.kind === 'agent' ? entry.prompt : entry.body).replace(/\s+/g, ' ');
      expect(text, `${entry.name} (${entry.category}) must state its limit`).toMatch(required);
    }
  });

  it('names the jurisdiction whenever an entry leans on a national system', () => {
    // Everyday administration is the one place a generic procedure stops being
    // portable: a deposit deadline, a tax ceiling or an application calendar is
    // a fact about one country. Entries that reach for a French portal are
    // useful precisely because they are concrete, so the rule is not "stay
    // vague" — it is "say which country you are in", in the text the model
    // reads, so it can tell a reader elsewhere what still holds. Without this
    // the shelf silently becomes France-only.
    const NATIONAL = /service-public\.fr|impots\.gouv\.fr|ameli\.fr|ants\.gouv\.fr|parcoursup/i;

    for (const entry of LIBRARY) {
      const text = entry.kind === 'agent' ? entry.prompt : entry.body;
      if (!NATIONAL.test(text)) continue;
      expect(
        text,
        `${entry.name} cites a French service but never says "Jurisdiction: France"`,
      ).toContain('Jurisdiction: France');
    }
  });

  it('writes every skill as a markdown procedure with a definition of done', () => {
    for (const entry of LIBRARY) {
      if (entry.kind !== 'skill') continue;
      // materialiseSkills prepends frontmatter and writes the body verbatim,
      // so the body must open as a document, not mid-sentence.
      expect(entry.body.startsWith('# '), `${entry.name}: body must open with a heading`).toBe(true);
      expect(entry.body.trim().length, entry.name).toBeGreaterThanOrEqual(300);
      expect(entry.body, `${entry.name}: a skill needs its definition of done`).toContain('Done when:');
    }
  });
});

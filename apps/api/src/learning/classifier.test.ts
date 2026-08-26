import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/index.js';
import { migrate, openDatabase } from '../db/index.js';
import { TASK_CATEGORIES, type TaskCategory, TaskClassifier, ruleClassify } from './classifier.js';
import { HashingEmbedder } from './embeddings.js';

describe('ruleClassify', () => {
  const english: Array<[string, TaskCategory]> = [
    ['Fix the bug in auth.ts, it crashes on login', 'debug'],
    ['There is a regression: the run stalls with a stack trace', 'debug'],
    ['Write tests for the crypto module', 'test'],
    ['Add tests covering the token bucket', 'test'],
    ['We need better test coverage on the memory store', 'test'],
    ['Please review this pull request for security issues', 'review'],
    ['Do a security review of the permission broker', 'review'],
    ['Refactor the repositories file to remove duplication', 'refactor'],
    ['Simplify this function and rename the variables', 'refactor'],
    ['Plan the architecture for a new billing service', 'plan'],
    ['Draft an RFC describing the proposed approach', 'plan'],
    ['Research the best vector database for this project', 'research'],
    ['Compare and benchmark the two retrieval strategies', 'research'],
    ['Explain how the event bus works', 'explain'],
    ['What is reciprocal rank fusion?', 'explain'],
    ['Deploy the app with docker compose to the VPS', 'ops'],
    ['The kubernetes pipeline is part of the infra work', 'ops'],
    ['Write a SQL query to aggregate the runs table', 'data'],
    ['Add a migration for the runs table schema', 'data'],
    ['Write a readme for the project', 'write'],
    ['Update the changelog and the documentation', 'write'],
    ['Implement a new endpoint for listing workspaces', 'code_write'],
    ['Scaffold a component that renders the transcript', 'code_write'],
    ['Update the copy on the settings page', 'code_edit'],
    ['Tweak the padding and patch the label', 'code_edit'],
  ];

  const french: Array<[string, TaskCategory]> = [
    ["Corrige l'erreur : le serveur plante au démarrage", 'debug'],
    ['Ce module ne fonctionne pas depuis la dernière release', 'debug'],
    ['Écris des tests unitaires pour le module crypto', 'test'],
    ['Améliore la couverture de tests du store mémoire', 'test'],
    ['Fais une revue de ce code', 'review'],
    ['Relis ce module et audite la sécurité', 'review'],
    ['Simplifie et nettoie ce module', 'refactor'],
    ['Renomme ces variables et factorise le code', 'refactor'],
    ['Planifie la conception du nouveau service', 'plan'],
    ["Décris la stratégie et la feuille de route", 'plan'],
    ['Recherche les meilleures options de base vectorielle', 'research'],
    ['Enquête sur la cause de la lenteur du démarrage', 'research'],
    ['Explique comment marche le bus', 'explain'],
    ["Pourquoi est-ce que ça échoue ici ?", 'explain'],
    ['Déploie la nouvelle version en production', 'ops'],
    ["Prépare l'infrastructure et le conteneur", 'ops'],
    ['Écris une requête sur la base de données', 'data'],
    ['Prépare le schéma et la migration', 'data'],
    ['Rédige un résumé du projet', 'write'],
    ['Implémente une nouvelle fonctionnalité', 'code_write'],
    ['Crée un composant pour la barre latérale', 'code_write'],
    ['Modifie le texte de la page', 'code_edit'],
    ['Ajuste la marge du bouton', 'code_edit'],
  ];

  it('classifies English prompts across every rule category', () => {
    for (const [prompt, expected] of english) {
      const result = ruleClassify(prompt);
      expect(result, `no rule matched: ${prompt}`).not.toBeNull();
      expect(result!.category, `wrong category for: ${prompt}`).toBe(expected);
    }
    expect(new Set(english.map(([, category]) => category)).size).toBeGreaterThanOrEqual(12);
  });

  it('classifies French prompts across every rule category', () => {
    for (const [prompt, expected] of french) {
      const result = ruleClassify(prompt);
      expect(result, `no rule matched: ${prompt}`).not.toBeNull();
      expect(result!.category, `wrong category for: ${prompt}`).toBe(expected);
    }
    expect(new Set(french.map(([, category]) => category)).size).toBeGreaterThanOrEqual(12);
  });

  it('reports a capped confidence and the phrase it matched', () => {
    const result = ruleClassify('Please review this diff')!;
    expect(result.confidence).toBe(0.6);
    expect(result.reason).toBe('Matched the phrase "review".');
  });

  it('prefers the more specific rule when several could apply', () => {
    // "fix the bug in auth.ts" mentions a file, but it is a debugging task.
    expect(ruleClassify('Fix the bug in auth.ts and update the import')!.category).toBe('debug');
    // Writing tests beats the generic "add" cue of code_write.
    expect(ruleClassify('Add tests and create a new helper')!.category).toBe('test');
  });

  it('returns null when there is no lexical cue at all', () => {
    for (const prompt of ['hello there', 'bonjour', '', '   ', 'foo bar baz', '42']) {
      expect(ruleClassify(prompt), `unexpected match for: ${prompt}`).toBeNull();
    }
  });

  it('only looks at the first 1500 characters', () => {
    expect(ruleClassify(`${'z '.repeat(1200)}refactor this`)).toBeNull();
    expect(ruleClassify(`${'z '.repeat(100)}refactor this`)!.category).toBe('refactor');
  });

  it('only returns categories from the declared list', () => {
    for (const [prompt] of [...english, ...french]) {
      const result = ruleClassify(prompt);
      if (result) expect(TASK_CATEGORIES).toContain(result.category);
    }
  });

  /**
   * BUG (apps/api/src/learning/classifier.ts:67, 95, 123): every French cue
   * that begins with an accented letter is unreachable. The alternation is
   * wrapped in `\b(...)\b`, and `\b` is defined against ASCII `\w`, so there is
   * never a word boundary between a space and "é". `[ée]cris`,
   * `[ée]crire des tests?`, `[ée]value` and `[ée]tat de l'art` therefore never
   * fire; the prompts below only classify at all when some *other* word in them
   * happens to hit a different rule.
   */
  it('matches French cues that begin with an accented letter', () => {
    expect(ruleClassify("Fais un état de l'art des méthodes de retrieval")?.category).toBe(
      'research',
    );
    expect(ruleClassify('Évalue ces deux bibliothèques')?.category).toBe('research');
    expect(ruleClassify('Écrire des tests pour ce module')?.category).toBe('test');
  });

  /**
   * BUG (apps/api/src/learning/classifier.ts:66 and :81): several alternatives
   * end in a word that the prompt naturally pluralises or inflects, while the
   * group is closed with `\b`. "unit test" therefore fails to match "unit
   * tests", and the French "refactor" alternative fails to match "refactorise",
   * even though those are the most idiomatic phrasings of the request.
   */
  it('matches the natural plural and inflected forms of its cues', () => {
    expect(ruleClassify('Write unit tests for the crypto module')?.category).toBe('test');
    expect(ruleClassify('Add integration tests for the kernel')?.category).toBe('test');
    expect(ruleClassify('Refactorise ce module pour supprimer les doublons')?.category).toBe(
      'refactor',
    );
  });

  /**
   * The present participle is how a prompt describes work already under way,
   * and four cues closed the group before it: `crash(?:e[sd])?`,
   * `deploy(?:s|ed|ment)?`, `investigate`, `extract`. Their neighbours in the
   * same file already inflect two different ways — `review(?:s|ed|ing)?`,
   * `refactor[\p{L}\p{N}_]*` — which is what marks these as omissions rather
   * than choices.
   *
   * The cost is not a wrong answer: an unmatched prompt falls through to
   * `chat`, which is a legitimate arm-set, so the bandit converges more slowly
   * and `kernel.ts` files the prompt as a `chat` exemplar, teaching the kNN arm
   * the same miss.
   */
  it('matches the present participle, which is how work in progress is described', () => {
    expect(ruleClassify('The server keeps crashing when I open the settings page')?.category).toBe(
      'debug',
    );
    expect(ruleClassify('We are deploying the new version to the VPS tonight')?.category).toBe(
      'ops',
    );
    expect(ruleClassify('Investigating why the queue is slow')?.category).toBe('research');
    expect(ruleClassify('Extracting the shared helper into its own module')?.category).toBe(
      'refactor',
    );
  });
});

describe('TaskClassifier', () => {
  let db: Db;
  let classifier: TaskClassifier;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    migrate(db);
    classifier = new TaskClassifier(db, new HashingEmbedder());
  });

  afterEach(() => {
    db.close();
  });

  it('falls back to the rules while there are too few exemplars', async () => {
    const result = await classifier.classify('Fix the crash in the login handler', null);
    expect(result.category).toBe('debug');
    expect(result.reason).toContain('Matched the phrase');

    // A handful of exemplars is still below the evidence bar.
    for (let i = 0; i < 5; i += 1) {
      await classifier.learn(`Fix the crash in handler number ${i}`, 'ops', null);
    }
    const stillRules = await classifier.classify('Fix the crash in the login handler', null);
    expect(stillRules.category).toBe('debug');
  });

  it('falls back to `chat` when neither rules nor exemplars say anything', async () => {
    const result = await classifier.classify('hello there', null);
    expect(result.category).toBe('chat');
    expect(result.confidence).toBe(0.3);
    expect(result.reason).toContain('No strong signal');
  });

  it('never throws, whatever the prompt looks like', async () => {
    for (const prompt of ['', '   ', ' ', 'é'.repeat(5000), '"; DROP TABLE memories; --']) {
      await expect(classifier.classify(prompt, null)).resolves.toHaveProperty('category');
    }
  });

  it('learns the operator’s own phrasing and overrides the rules', async () => {
    // In this operator's world, "explain the … numbers" is a data task.
    for (let i = 0; i < 20; i += 1) {
      await classifier.learn(`explain the quarterly revenue numbers for region ${i}`, 'data', null);
    }
    // Some unrelated exemplars, so the neighbourhood is not trivially unanimous.
    for (let i = 0; i < 6; i += 1) {
      await classifier.learn(`say hello and chat about the weather ${i}`, 'chat', null);
    }

    const prompt = 'explain the monthly revenue numbers for region 42';
    // The rule layer alone would call this an `explain` task.
    expect(ruleClassify(prompt)!.category).toBe('explain');

    const learned = await classifier.classify(prompt, null);
    expect(learned.category).toBe('data');
    expect(learned.confidence).toBeGreaterThanOrEqual(0.62);
    expect(learned.reason).toContain('similar past task');
  });

  it('keeps exemplars scoped, but lets global ones inform every workspace', async () => {
    db.prepare(
      `INSERT INTO workspaces (id, name, slug, path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('ws_x', 'X', 'x', '/tmp/x', Date.now(), Date.now());

    for (let i = 0; i < 15; i += 1) {
      await classifier.learn(`ship the release artefact number ${i}`, 'ops', 'ws_x');
    }
    expect(classifier.distribution('ws_x')).toEqual([{ category: 'ops', count: 15 }]);
    expect(classifier.distribution(null)).toEqual([]);

    // Another workspace does not see ws_x's exemplars, so it has no evidence.
    const other = await classifier.classify('ship the release artefact number 99', null);
    expect(other.category).toBe('chat');

    const inScope = await classifier.classify('ship the release artefact number 99', 'ws_x');
    expect(inScope.category).toBe('ops');
  });

  it('reports the exemplar distribution, most-used first', async () => {
    await classifier.learn('one', 'debug', null);
    await classifier.learn('two', 'debug', null);
    await classifier.learn('three', 'debug', null);
    await classifier.learn('four', 'plan', null);

    expect(classifier.distribution(null)).toEqual([
      { category: 'debug', count: 3 },
      { category: 'plan', count: 1 },
    ]);
  });

  it('stores the weight and the embedding provider with each exemplar', async () => {
    await classifier.learn('a prompt', 'plan', null, 2.5);
    const row = db
      .prepare<[], { weight: number; embedding_model: string; embedding_dim: number; text: string }>(
        'SELECT weight, embedding_model, embedding_dim, text FROM task_exemplars',
      )
      .get()!;
    expect(row.weight).toBe(2.5);
    expect(row.embedding_model).toBe('hash-v1:512');
    expect(row.embedding_dim).toBe(512);
    expect(row.text).toBe('a prompt');
  });

  it('truncates a very long prompt before storing it', async () => {
    await classifier.learn('x'.repeat(5000), 'plan', null);
    const row = db.prepare<[], { text: string }>('SELECT text FROM task_exemplars').get()!;
    expect(row.text).toHaveLength(2000);
  });

  it('reset() unlearns a scope and returns how much it dropped', async () => {
    for (let i = 0; i < 14; i += 1) {
      await classifier.learn(`explain the quarterly numbers ${i}`, 'data', null);
    }
    expect(await classifier.classify('explain the quarterly numbers 99', null)).toHaveProperty(
      'category',
      'data',
    );

    expect(classifier.reset(null)).toBe(14);
    expect(classifier.distribution(null)).toEqual([]);
    expect(classifier.reset(null)).toBe(0);

    // With the exemplars gone the rule layer takes over again.
    const afterReset = await classifier.classify('explain the quarterly numbers 99', null);
    expect(afterReset.category).toBe('explain');
  });
});

/**
 * Task classification.
 *
 * The bandit needs a context to condition on. That context is a coarse task
 * category — "write code", "debug", "research", and so on — because the right
 * model for a one-line rename is not the right model for an architecture review.
 *
 * The classifier is two-stage:
 *  1. A rule layer over high-signal lexical cues. It is fast, transparent and
 *     works from the very first run, in English and French.
 *  2. A kNN layer over embedded exemplars, which takes over once the operator's
 *     own phrasing has been observed enough times to beat the rules.
 *
 * Every classification is explainable, which matters: a policy the operator
 * cannot inspect is a policy they cannot trust.
 */

import { newId } from '@metaclaude/shared';
import type { Db } from '../db/index.js';
import { packEmbedding, tx, unpackEmbedding } from '../db/index.js';
import { cosineSimilarity, type EmbeddingProvider } from './embeddings.js';

export const TASK_CATEGORIES = [
  'code_write',
  'code_edit',
  'debug',
  'review',
  'test',
  'refactor',
  'research',
  'explain',
  'plan',
  'ops',
  'data',
  'write',
  'chat',
] as const;

export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export interface Classification {
  category: TaskCategory;
  confidence: number;
  /** How the decision was reached, for the "why this model?" tooltip. */
  reason: string;
}

/**
 * Unicode-aware word boundaries.
 *
 * JavaScript's `\b` is defined against ASCII `\w`, so there is no boundary
 * between a space and `é`. Written with `\b`, every French cue starting with an
 * accented letter — `évalue`, `état de l'art`, `écris` — is silently
 * unmatchable. These lookarounds are the boundary we actually mean, and every
 * pattern below uses them with the `u` flag.
 */
const B = '(?<![\\p{L}\\p{N}_])';
const E = '(?![\\p{L}\\p{N}_])';

/** Build a case-insensitive, Unicode-aware alternation with real boundaries. */
function cue(...alternatives: string[]): RegExp {
  return new RegExp(`${B}(?:${alternatives.join('|')})${E}`, 'iu');
}

/**
 * Lexical cues per category, in English and French.
 *
 * Ordered by specificity: `debug` before `code_edit` because "fix the bug in
 * auth.ts" is a debugging task that happens to mention a file.
 *
 * Note the explicit plural/inflection allowances (`tests?`, `refactoris\\w*`):
 * "write unit tests" and "refactorise ce module" are the *most* idiomatic ways
 * to ask, so a pattern that only matches the singular stem matches nothing real.
 */
const RULES: ReadonlyArray<{ category: TaskCategory; patterns: readonly RegExp[] }> = [
  {
    category: 'debug',
    patterns: [
      cue('debug\\w*', 'bugs?', 'crash(?:e[sd])?', 'stack ?traces?', 'traceback', 'exceptions?',
          'regressions?', 'failing', 'fails?', 'broken', 'errors?'),
      cue('d[ée]bogu\\w*', 'd[ée]bugg\\w*', 'plante', 'erreurs?', 'panne', 'r[ée]gressions?',
          'ne marche pas', 'ne fonctionne pas'),
      /(?<![\p{L}\p{N}_])why (is|does|isn'?t|doesn'?t)(?![\p{L}\p{N}_]).*(fail|break|crash|work)/iu,
    ],
  },
  {
    category: 'test',
    patterns: [
      cue('unit tests?', 'integration tests?', 'e2e tests?', 'write tests?', 'add tests?',
          'test coverage', 'vitest', 'jest', 'pytest'),
      cue('tests? unitaires?', 'tests? d.int[ée]gration', '[ée]cri(?:re|s|ez) des tests?',
          'couverture de tests?', 'ajoute des tests?'),
    ],
  },
  {
    category: 'review',
    patterns: [
      cue('review(?:s|ed|ing)?', 'code review', 'critique', 'audit(?:s|ed|ing)?',
          'security review', 'look over'),
      cue('revue', 'relire', 'relis', 'audite', 'analyse critique', 'passe en revue'),
    ],
  },
  {
    category: 'refactor',
    patterns: [
      cue('refactor\\w*', 'restructure', 'clean ?up', 'simplif\\w+', 'deduplicate', 'extract',
          'rename'),
      cue('refactoris\\w*', 'restructure', 'simplifie', 'nettoie', 'renomme', 'factoris\\w*'),
    ],
  },
  {
    category: 'plan',
    patterns: [
      cue('plan(?:s|ned|ning)?', 'design', 'architect', 'architecture', 'strategy', 'approach',
          'rfc', 'proposal', 'roadmap'),
      cue('planifi\\w*', 'conception', 'architecture', 'strat[ée]gie', 'approche',
          'feuille de route'),
    ],
  },
  {
    category: 'research',
    patterns: [
      cue('research', 'investigate', 'compare', 'evaluate', 'benchmark', 'find out', 'survey',
          'state of the art'),
      cue('recherche', 'enqu[êe]te', 'compare', '[ée]valu\\w*', "[ée]tat de l'art",
          'documente-toi'),
    ],
  },
  {
    category: 'explain',
    patterns: [
      cue('explain', 'how does', 'what is', 'why does', 'walk me through', 'teach', 'understand'),
      cue('expliqu\\w*', 'comment (?:ç|c)a march\\w*', "qu'est-ce", 'pourquoi',
          'fais-moi comprendre'),
    ],
  },
  {
    category: 'ops',
    patterns: [
      cue('deploy(?:s|ed|ment)?', 'docker', 'kubernetes', 'k8s', 'ci\\/?cd', 'pipeline', 'nginx',
          'terraform', 'systemd', 'infra\\w*'),
      cue('d[ée]ploi\\w*', 'conteneuris\\w*', 'conteneur', 'infrastructure',
          'mise en production'),
    ],
  },
  {
    category: 'data',
    patterns: [
      cue('sql', 'quer(?:y|ies)', 'database', 'migrations?', 'schema', 'dataset', 'csv',
          'analyz\\w+', 'aggregate'),
      cue('base de donn[ée]es', 'requ[êe]tes?', 'sch[ée]ma', 'migrations?', 'jeu de donn[ée]es'),
    ],
  },
  {
    category: 'write',
    patterns: [
      cue('write (?:a |the )?(?:doc|readme|article|post|email|summary)', 'draft', 'documentation',
          'changelog'),
      cue('[ée]cri(?:s|re|ez|vez)', 'r[ée]dig\\w*', 'documentation', 'r[ée]sum[ée]', 'article',
          'courriel'),
    ],
  },
  {
    category: 'code_write',
    patterns: [
      cue('implement\\w*', 'build', 'create', 'add (?:a |an )?(?:feature|endpoint|component|function)',
          'scaffold', 'generate'),
      cue('impl[ée]ment\\w*', 'cr[ée]e', 'construis', 'ajoute', 'g[ée]n[èe]re', 'd[ée]veloppe'),
    ],
  },
  {
    category: 'code_edit',
    patterns: [
      cue('change', 'update', 'modify', 'tweak', 'adjust', 'edit', 'patch'),
      cue('change', 'modifie', 'mets? [àa] jour', 'ajuste', 'corrige'),
    ],
  },
];

export class TaskClassifier {
  constructor(
    private readonly db: Db,
    private readonly embedder: EmbeddingProvider,
  ) {}

  /** Classify a prompt. Never throws; falls back to `chat`. */
  async classify(prompt: string, workspaceId: string | null): Promise<Classification> {
    const knn = await this.knnClassify(prompt, workspaceId);
    // Trust learned exemplars once they agree strongly; the operator's own
    // phrasing is a better signal than our generic keyword list.
    if (knn && knn.confidence >= 0.62) return knn;

    const rule = ruleClassify(prompt);
    if (rule) return rule;

    if (knn) return knn;

    return {
      category: 'chat',
      confidence: 0.3,
      reason: 'No strong signal; treated as a general request.',
    };
  }

  /**
   * Record a labelled example.
   *
   * Called after a run completes with the category that was actually used, so
   * the classifier converges on how this operator phrases each kind of task.
   */
  async learn(
    prompt: string,
    category: TaskCategory,
    workspaceId: string | null,
    weight = 1,
  ): Promise<void> {
    const text = prompt.slice(0, 2000);
    const embedding = await this.embedder.embed(text);

    this.db
      .prepare(
        `INSERT INTO task_exemplars
           (id, workspace_id, category, text, embedding, embedding_dim, embedding_model, weight, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('exemplar'),
        workspaceId,
        category,
        text,
        packEmbedding(embedding),
        embedding.length,
        this.embedder.id,
        weight,
        Date.now(),
      );

    this.prune(workspaceId, category);
  }

  /**
   * Keep the exemplar set bounded per (workspace, category).
   *
   * An unbounded set slows every classification and over-weights whatever the
   * operator happened to do most last month. 200 recent examples is plenty for
   * kNN on a personal corpus.
   */
  private prune(workspaceId: string | null, category: TaskCategory, keep = 200): void {
    this.db
      .prepare(
        `DELETE FROM task_exemplars
         WHERE workspace_id IS ? AND category = ?
           AND id NOT IN (
             SELECT id FROM task_exemplars
             WHERE workspace_id IS ? AND category = ?
             ORDER BY created_at DESC LIMIT ?
           )`,
      )
      .run(workspaceId, category, workspaceId, category, keep);
  }

  /** Distance-weighted k-nearest-neighbours over the exemplar set. */
  private async knnClassify(
    prompt: string,
    workspaceId: string | null,
    k = 9,
  ): Promise<Classification | null> {
    const rows = this.db
      .prepare<[string | null, string], { category: string; embedding: Buffer; weight: number }>(
        `SELECT category, embedding, weight FROM task_exemplars
         WHERE (workspace_id IS ? OR workspace_id IS NULL) AND embedding_model = ?
         ORDER BY created_at DESC LIMIT 3000`,
      )
      .all(workspaceId, this.embedder.id);

    if (rows.length < 12) return null; // Too little evidence to beat the rules.

    const queryVector = await this.embedder.embed(prompt.slice(0, 2000));

    const scored = rows
      .map((row) => {
        const vector = unpackEmbedding(row.embedding);
        return vector
          ? { category: row.category, weight: row.weight, score: cosineSimilarity(queryVector, vector) }
          : null;
      })
      .filter((entry): entry is { category: string; weight: number; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    if (scored.length === 0) return null;

    const votes = new Map<string, number>();
    let total = 0;
    for (const entry of scored) {
      // Only positive similarity counts as a vote; an orthogonal neighbour says
      // nothing, and a negative one should not vote against by accident.
      const vote = Math.max(0, entry.score) * entry.weight;
      votes.set(entry.category, (votes.get(entry.category) ?? 0) + vote);
      total += vote;
    }
    if (total === 0) return null;

    let best: { category: string; vote: number } | null = null;
    for (const [category, vote] of votes) {
      if (!best || vote > best.vote) best = { category, vote };
    }
    if (!best) return null;

    const confidence = best.vote / total;
    return {
      category: best.category as TaskCategory,
      confidence,
      reason: `Matched ${scored.length} similar past task${scored.length === 1 ? '' : 's'} in this workspace.`,
    };
  }

  /** Exemplar counts per category, for the learning dashboard. */
  distribution(workspaceId: string | null): Array<{ category: string; count: number }> {
    return this.db
      .prepare<[string | null], { category: string; count: number }>(
        `SELECT category, COUNT(*) AS count FROM task_exemplars
         WHERE workspace_id IS ? GROUP BY category ORDER BY count DESC`,
      )
      .all(workspaceId);
  }

  reset(workspaceId: string | null): number {
    return tx(this.db, () =>
      this.db.prepare('DELETE FROM task_exemplars WHERE workspace_id IS ?').run(workspaceId).changes,
    );
  }
}

/** The rule layer, exported so it can be tested independently. */
export function ruleClassify(prompt: string): Classification | null {
  const text = prompt.slice(0, 1500);
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) {
        return {
          category: rule.category,
          // Rules are decent but not authoritative; cap confidence so a
          // sufficiently confident kNN can override them.
          confidence: 0.6,
          reason: `Matched the phrase "${match[0].trim()}".`,
        };
      }
    }
  }
  return null;
}

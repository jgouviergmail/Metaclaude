# Bibliothèque de connaissance — fichiers, portée, provenance : plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Déposer des fichiers (txt, md, csv, html, pdf, docx, xlsx, pptx) dans la Bibliothèque de connaissance, les rattacher à tous, un ou plusieurs workspaces, et citer chaque passage avec document, section, page et lignes.

**Architecture:** Le pipeline de recherche existant (chunker → `KnowledgeStore` → recherche hybride → `selectKnowledgeContext`) est conservé ; on ajoute en amont un module d'extraction exécuté dans un worker thread, en dessous une portée many-to-many copiée de la migration 26 des skills, et en aval des colonnes de provenance sur les passages rendues par une fonction partagée. Le fichier d'origine est conservé sous `<dataDir>/knowledge/<sha256>.<ext>`.

**Tech Stack:** Node 22/24, Fastify 5, better-sqlite3 + fts5, Zod 4, React 19 + React Query + Radix, vitest, happy-dom ; nouvelles dépendances API : `mammoth`, `exceljs`, `pdfjs-dist`, `fflate` (toutes pures JS, sans postinstall).

**Spec:** `docs/superpowers/specs/2026-09-08-knowledge-files-design.md`

## Global Constraints

- Imports relatifs dans `apps/api` et `packages/shared` en `.js` (NodeNext) ; le web utilise `@/`.
- Tout nouveau schéma réservé à l'API va dans `packages/shared/src/api-contracts.ts`, jamais dans `domain.ts` ; les constantes que le web lit (`KNOWLEDGE_MIME_TYPES`, `KNOWLEDGE_LIMITS`) vont dans `domain.ts` comme `ATTACHMENT_MIME_TYPES`.
- Jamais `.partial()` nu : `patchSchema` (ratchet `defaultingPartials`, plafond 0).
- Migrations append-only : nouvelle entrée `version: 29` dans `MIGRATIONS`, pas de backtick dans un commentaire SQL.
- Tailwind : tokens sémantiques seulement ; une rangée de filtres est `FILTER_ROW` ; une rangée de boutons segmentée est `grid`, jamais `flex` nu ; chaque bouton icône a un `aria-label`.
- Copie visible : anglais dans le code via `t('…')`, entrée française dans `apps/web/src/locales/fr.ts` ; pluriels via `plural()` ; le ratchet `untranslatedStrings` reste à 0.
- Tests web via `renderWithProviders` ; Radix s'active au `pointerdown` (`fireEvent.pointerDown` avant `click`) ; pas de `jest-dom`.
- Plafonds : 20 Mo par fichier (`KNOWLEDGE_LIMITS.maxBytes`), 512 Kio de texte extrait (`MAX_DOCUMENT_BYTES` inchangé), 60 s et 512 Mo pour un worker d'extraction, 60 s et 8 Mio de sortie pour `pdftotext`.
- Le moteur PDF de production est poppler `pdftotext` (paquet `poppler-utils`, installé par le Dockerfile) ; pdfjs est un repli **nommé** dans `extractor` et signalé par le doctor, jamais un choix silencieux.
- Le reranker est abandonné : aucune tâche ne l'ajoute au chemin d'un run ; seul le banc garde `--rerank`.
- Chaque nouveau test est saboté une fois (la ligne qu'il couvre est cassée, le test vu rouge, la ligne remise) avant le commit.
- À la fin : `pnpm verify` vert (typecheck, tests, build, ratchets), entrée CHANGELOG **dans** `[Unreleased]`, `node deploy/bump.mjs minor` sans pipe.
- Aucun sous-agent : tout s'exécute en ligne dans la session.

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `packages/shared/src/domain.ts` (modifié) | `KNOWLEDGE_MIME_TYPES`, `KNOWLEDGE_LIMITS`, `KnowledgePageUnit` |
| `packages/shared/src/knowledge.ts` (créé) | `KnowledgeLocation`, `describeLocation`, `LOCATION_WORDS_EN` — une seule façon d'écrire « page 2, lignes 40–52 » |
| `packages/shared/src/api-contracts.ts` (modifié) | `SaveKnowledgeRequest` + `reach`, `UploadKnowledgeRequest`, `PatchKnowledgeRequest`, `KnowledgeDocumentMeta`, `KnowledgeSearchHit`, `RunGenesis.documents` |
| `apps/api/src/db/schema.sql.ts` (modifié) | migration 29 `knowledge_files` |
| `apps/api/src/learning/chunker.ts` (modifié) | `start`/`end` par passage |
| `apps/api/src/learning/knowledge.ts` (modifié) | portée, provenance, source, doublon, `LEFT JOIN` |
| `apps/api/src/learning/knowledge-files.ts` (créé) | le fichier d'origine sur disque |
| `apps/api/src/learning/extract/{index,errors,html,text,csv,docx,xlsx,pptx,pdf,worker,worker-extractor}.ts` (créés) | extraction |
| `apps/api/src/learning/extract/fixtures/*` + `apps/api/scripts/make-knowledge-fixtures.mjs` (créés) | fixtures binaires et leur générateur |
| `apps/api/src/config.ts`, `apps/api/src/context.ts` (modifiés) | `knowledgeDir`, câblage |
| `apps/api/src/routes/learning.ts` (modifié) | upload, extract, source, PATCH |
| `apps/api/src/kernel/context.ts` (modifié) | bloc injecté avec provenance |
| `apps/api/src/services/mcp-gateway.ts` (modifié) | `search_notes` avec provenance |
| `apps/api/src/services/doctor.ts` (modifié) | vérification `knowledge-files` |
| `apps/web/src/lib/api.ts` (modifié) | `upload`, `patch`, `extract`, `sourceUrl` |
| `apps/web/src/components/memory/KnowledgeSection.tsx` (modifié), `KnowledgeUploadZone.tsx`, `KnowledgeViewer.tsx`, `KnowledgeSourceBadge.tsx` (créés) | écran |
| `apps/web/src/pages/MemoryPage.tsx`, `apps/web/src/components/transcript/RunGenesis.tsx` (modifiés) | paramètres d'URL, liens de provenance |
| `apps/api/scripts/eval-retrieval.mjs`, `docs/LEARNING.md`, `docs/guide/04-memory-and-learning.md`, `docs/ARCHITECTURE.md`, `docker/Dockerfile`, `apps/api/scripts/{e2e,shots}.mjs`, `CHANGELOG.md` (modifiés) | banc, docs, image, vérifications vivantes |

---

### Task 1 : Contrats partagés

**Files:**
- Modify: `packages/shared/src/domain.ts` (après `ATTACHMENT_MIME_TYPES`, ~ligne 911)
- Create: `packages/shared/src/knowledge.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/api-contracts.ts:715-760`
- Test: `packages/shared/src/knowledge.test.ts`, `packages/shared/src/domain.test.ts`

**Interfaces:**
- Produces: `KNOWLEDGE_MIME_TYPES: readonly string[]`, `KNOWLEDGE_LIMITS = { maxBytes: 20 * 1024 * 1024 }`, `KnowledgePageUnit = 'page' | 'slide' | 'sheet'`, `KnowledgeLocation`, `describeLocation(location, words?)`, `LOCATION_WORDS_EN`, `SaveKnowledgeRequest`, `UploadKnowledgeRequest`, `PatchKnowledgeRequest`, `KnowledgeDocumentMeta`, `KnowledgeSearchHit`, `KnowledgeSource`.

- [ ] **Step 1 : Test rouge sur `describeLocation`**

`packages/shared/src/knowledge.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { describeLocation } from './knowledge.js';

describe('describeLocation', () => {
  it('says nothing for a passage that has no location', () => {
    expect(describeLocation({ pageUnit: null, pageStart: null, pageEnd: null, lineStart: null, lineEnd: null })).toBe('');
  });
  it('names one page and a line range', () => {
    expect(describeLocation({ pageUnit: 'page', pageStart: 2, pageEnd: 2, lineStart: 40, lineEnd: 52 })).toBe('page 2, lines 40–52');
  });
  it('names a page span, a single line, and the unit of a slide deck', () => {
    expect(describeLocation({ pageUnit: 'slide', pageStart: 2, pageEnd: 3, lineStart: 7, lineEnd: 7 })).toBe('slides 2–3, line 7');
  });
  it('gives lines alone for a pasted document', () => {
    expect(describeLocation({ pageUnit: null, pageStart: null, pageEnd: null, lineStart: 1, lineEnd: 9 })).toBe('lines 1–9');
  });
  it('takes the words from the caller, so the web can say it in French', () => {
    expect(
      describeLocation(
        { pageUnit: 'sheet', pageStart: 1, pageEnd: 1, lineStart: 3, lineEnd: 4 },
        { page: 'page', pages: 'pages', slide: 'diapositive', slides: 'diapositives', sheet: 'feuille', sheets: 'feuilles', line: 'l.', lines: 'l.' },
      ),
    ).toBe('feuille 1, l. 3–4');
  });
});
```

- [ ] **Step 2 : Lancer, voir rouge**

`pnpm --filter @metaclaude/shared test:run -- knowledge` → échoue : module absent.

- [ ] **Step 3 : Écrire `packages/shared/src/knowledge.ts`**

```ts
/**
 * Where a passage comes from, said once.
 *
 * Four consumers show the same fact — the block injected into a run, the
 * genesis strip, the retrieval rehearsal and the MCP search tool — and a
 * locator spelled four times is a locator that drifts. The words are a
 * parameter because the prompt speaks English and the screen speaks the
 * operator's language; the shape of the sentence is the same in both.
 */

import type { KnowledgePageUnit } from './domain.js';

export interface KnowledgeLocation {
  pageUnit: KnowledgePageUnit | null;
  pageStart: number | null;
  pageEnd: number | null;
  lineStart: number | null;
  lineEnd: number | null;
}

export interface LocationWords {
  page: string; pages: string;
  slide: string; slides: string;
  sheet: string; sheets: string;
  line: string; lines: string;
}

export const LOCATION_WORDS_EN: LocationWords = {
  page: 'page', pages: 'pages', slide: 'slide', slides: 'slides',
  sheet: 'sheet', sheets: 'sheets', line: 'line', lines: 'lines',
};

const range = (start: number, end: number): string => (start === end ? String(start) : `${start}–${end}`);

export function describeLocation(location: KnowledgeLocation, words: LocationWords = LOCATION_WORDS_EN): string {
  const parts: string[] = [];
  if (location.pageUnit && location.pageStart !== null) {
    const end = location.pageEnd ?? location.pageStart;
    const single = location.pageStart === end;
    const unit =
      location.pageUnit === 'slide' ? (single ? words.slide : words.slides)
      : location.pageUnit === 'sheet' ? (single ? words.sheet : words.sheets)
      : single ? words.page : words.pages;
    parts.push(`${unit} ${range(location.pageStart, end)}`);
  }
  if (location.lineStart !== null) {
    const end = location.lineEnd ?? location.lineStart;
    parts.push(`${location.lineStart === end ? words.line : words.lines} ${range(location.lineStart, end)}`);
  }
  return parts.join(', ');
}
```

Dans `domain.ts`, après `ATTACHMENT_MIME_TYPES` :

```ts
/**
 * What the knowledge library accepts as a file. Closed list, like the
 * attachments: a type that is listed is a type an extractor exists for, and
 * the upload route says which ones when it refuses.
 */
export const KNOWLEDGE_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export const KNOWLEDGE_LIMITS = { maxBytes: 20 * 1024 * 1024 } as const;

/** The unit a paged format counts in; null for text that has no pages. */
export type KnowledgePageUnit = 'page' | 'slide' | 'sheet';
```

`index.ts` : ajouter `export * from './knowledge.js';`.

Dans `api-contracts.ts`, remplacer le bloc « The knowledge library » :

```ts
export const SaveKnowledgeRequest = z
  .object({
    id: z.string().optional(),
    /** Record of where it was first filed; nothing resolves with it. */
    workspaceId: z.string().nullable().default(null),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(512 * 1024),
    enabled: z.boolean().optional(),
    /** Absent on an update means untouched — the skills rule. Required to create. */
    reach: ExtensionReach.optional(),
  })
  .strict();
export type SaveKnowledgeRequest = z.infer<typeof SaveKnowledgeRequest>;

/** A file for the library. `data` is base64; the route enforces the decoded cap. */
export const UploadKnowledgeRequest = z
  .object({
    name: z.string().min(1).max(255),
    mime: z.string().max(255).default(''),
    data: z.string().min(1),
    reach: ExtensionReach,
    title: z.string().min(1).max(300).optional(),
  })
  .strict();
export type UploadKnowledgeRequest = z.infer<typeof UploadKnowledgeRequest>;

/** What may change without touching the text: never a default in here. */
export const PatchKnowledgeRequest = patchSchema(
  z.object({ title: z.string().min(1).max(300), enabled: z.boolean(), reach: ExtensionReach }),
).strict();
export type PatchKnowledgeRequest = z.infer<typeof PatchKnowledgeRequest>;

export type KnowledgeSource = { name: string; mime: string; bytes: number; extractor: string };

export type KnowledgeDocumentMeta = {
  id: string;
  workspaceId: string | null;
  title: string;
  contentLength: number;
  enabled: boolean;
  chunkCount: number;
  embeddingModel: string;
  isGlobal: boolean;
  workspaceIds: string[];
  /** Null for a pasted document. */
  source: KnowledgeSource | null;
  pageUnit: KnowledgePageUnit | null;
  /** Highest page any passage reaches; null without pages. */
  pageCount: number | null;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeSearchHit = KnowledgeLocation & {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceName: string | null;
  workspaceId: string | null;
  heading: string;
  text: string;
  score: number;
};
```

Et dans `RunGenesis` : `documents: Array<KnowledgeLocation & { chunkId: string; documentId: string; title: string; heading: string; score: number; replaced: boolean }>;` (`replaced` : le passage n'existe plus). Ajouter l'import `import type { KnowledgeLocation } from './knowledge.js';` et `KnowledgePageUnit` depuis `domain.js`.

Dans `domain.test.ts`, ajouter :

```ts
describe('the knowledge upload contract', () => {
  it('accepts what the browser sends and refuses a reach without its global flag', () => {
    expect(UploadKnowledgeRequest.safeParse({ name: 'bail.pdf', mime: 'application/pdf', data: 'AAAA', reach: { global: true, workspaceIds: [] } }).success).toBe(true);
    expect(UploadKnowledgeRequest.safeParse({ name: 'bail.pdf', mime: 'application/pdf', data: 'AAAA', reach: { workspaceIds: [] } }).success).toBe(false);
    expect(UploadKnowledgeRequest.safeParse({ name: 'bail.pdf', data: '', reach: { global: true, workspaceIds: [] } }).success).toBe(false);
  });
  it('a patch naming one field carries no other', () => {
    expect(PatchKnowledgeRequest.parse({ enabled: false })).toEqual({ enabled: false });
  });
});
```

(importer `UploadKnowledgeRequest`, `PatchKnowledgeRequest` depuis `./api-contracts.js`).

- [ ] **Step 4 : Vert, puis build du paquet**

`pnpm --filter @metaclaude/shared test:run` puis `pnpm --filter @metaclaude/shared build` (l'API et le web en dépendent).

- [ ] **Step 5 : Commit**

`git add packages/shared && git commit -m "knowledge: contracts for files, reach and provenance"`

---

### Task 2 : Migration 29 et sa reprise

**Files:**
- Modify: `apps/api/src/db/schema.sql.ts` (après la migration 28, fin de `MIGRATIONS`)
- Test: `apps/api/src/learning/knowledge-reach.test.ts` (créé)

**Interfaces:**
- Produces: tables/colonnes de la spec § 4 ; `KnowledgeStore` (Task 4) les lit.

- [ ] **Step 1 : Test rouge de reprise (le motif de `registry-attachments.test.ts`)**

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../db/index.js';
import { MIGRATIONS } from '../db/schema.sql.js';

const FILES = MIGRATIONS.find((m) => m.name === 'knowledge_files');
const BEFORE = MIGRATIONS.filter((m) => m !== FILES);
let db: Db;
beforeEach(() => { db = openDatabase({ path: ':memory:' }); });

const workspace = (id: string) =>
  db.prepare(`INSERT INTO workspaces (id, name, slug, path, settings, created_at, updated_at) VALUES (?, ?, ?, ?, '{}', 0, 0)`).run(id, id, id, `/tmp/${id}`);
const document = (id: string, home: string | null) =>
  db.prepare(`INSERT INTO documents (id, workspace_id, title, content, content_hash, enabled, chunk_count, embedding_model, created_at, updated_at) VALUES (?, ?, ?, 'x', ?, 1, 0, '', 0, 0)`).run(id, home, id, id);

describe('the knowledge_files migration', () => {
  it('is the last one, so BEFORE is genuinely every earlier migration', () => {
    expect(FILES).toBeTruthy();
    expect(BEFORE).toHaveLength(MIGRATIONS.length - 1);
  });
  it('leaves every workspace seeing exactly what it saw before', () => {
    for (const m of BEFORE) db.exec(m.sql);
    workspace('alpha'); workspace('beta');
    const rows: Array<[string, string | null]> = [['everywhere', null], ['alpha-only', 'alpha'], ['beta-only', 'beta']];
    for (const [id, home] of rows) document(id, home);
    const oldReach = (ws: string) => rows.filter(([, home]) => home === null || home === ws).map(([id]) => id).sort();

    db.exec(FILES!.sql);
    const newReach = (ws: string) =>
      db.prepare<[string], { id: string }>(
        `SELECT d.id FROM documents d WHERE d.is_global = 1 OR d.id IN (SELECT document_id FROM document_workspaces WHERE workspace_id = ?)`,
      ).all(ws).map((r) => r.id).sort();
    expect(newReach('alpha')).toEqual(oldReach('alpha'));
    expect(newReach('beta')).toEqual(oldReach('beta'));
  });
  it('runs on an empty library', () => {
    for (const m of BEFORE) db.exec(m.sql);
    expect(() => db.exec(FILES!.sql)).not.toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM document_workspaces`).get()).toEqual({ n: 0 });
  });
  it('keeps the fts index true after the chunk table grew columns', () => {
    for (const m of MIGRATIONS) db.exec(m.sql);
    document('d', null);
    db.prepare(`INSERT INTO document_chunks (id, document_id, seq, heading, text, embedding, page_start, page_end, line_start, line_end) VALUES ('c', 'd', 0, '', 'le délai de préavis', NULL, 2, 2, 40, 52)`).run();
    expect(db.prepare(`SELECT c.line_start FROM document_chunks_fts f JOIN document_chunks c ON c.rowid = f.rowid WHERE document_chunks_fts MATCH '"préavis"'`).all()).toEqual([{ line_start: 40 }]);
    expect(() => db.exec(`INSERT INTO document_chunks_fts(document_chunks_fts) VALUES('integrity-check')`)).not.toThrow();
  });
});
```

- [ ] **Step 2 : Rouge** — `pnpm --filter @metaclaude/api test:run -- knowledge-reach` : `FILES` est `undefined`.

- [ ] **Step 3 : La migration**

Ajouter à la fin de `MIGRATIONS` dans `schema.sql.ts` :

```ts
  {
    version: 29,
    name: 'knowledge_files',
    sql: /* sql */ `
      -- A document reaches several workspaces, and may come from a file.
      --
      -- The reach is the shape migration 26 gave skills, agents and MCP
      -- servers: is_global means everywhere including workspaces created
      -- tomorrow, otherwise the join table is the explicit set, which may be
      -- empty. The backfill keeps what every workspace sees identical on both
      -- sides; knowledge-reach.test.ts asserts it against the old predicate.
      --
      -- source_* describe the uploaded file the text was extracted from; null
      -- for a pasted document. The file itself lives at
      -- <dataDir>/knowledge/<source_sha256>.<ext>, so one row per file hash:
      -- the partial unique index turns a second upload of the same bytes into
      -- a 409 naming the first, rather than into a copy.
      --
      -- extractor names what produced content ('pdf@1'), so a better
      -- extractor can be applied to what was already uploaded.
      ALTER TABLE documents ADD COLUMN is_global     INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN source_name   TEXT;
      ALTER TABLE documents ADD COLUMN source_mime   TEXT;
      ALTER TABLE documents ADD COLUMN source_bytes  INTEGER;
      ALTER TABLE documents ADD COLUMN source_sha256 TEXT;
      ALTER TABLE documents ADD COLUMN extractor     TEXT;
      ALTER TABLE documents ADD COLUMN page_unit     TEXT;
      CREATE UNIQUE INDEX idx_documents_source ON documents(source_sha256) WHERE source_sha256 IS NOT NULL;

      CREATE TABLE document_workspaces (
        document_id  TEXT NOT NULL REFERENCES documents(id)  ON DELETE CASCADE,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        PRIMARY KEY (document_id, workspace_id)
      );
      CREATE INDEX idx_document_workspaces_workspace ON document_workspaces(workspace_id);

      -- Where each passage sits in documents.content: 1-based lines, and the
      -- page span for a paged format (pdf page, pptx slide, xlsx sheet). Null
      -- on passages written before this migration; they are cited without a
      -- location until their document is next rewritten, because
      -- re-chunking here would also mean re-embedding the whole library.
      ALTER TABLE document_chunks ADD COLUMN page_start INTEGER;
      ALTER TABLE document_chunks ADD COLUMN page_end   INTEGER;
      ALTER TABLE document_chunks ADD COLUMN line_start INTEGER;
      ALTER TABLE document_chunks ADD COLUMN line_end   INTEGER;

      UPDATE documents SET is_global = 1 WHERE workspace_id IS NULL;
      INSERT INTO document_workspaces (document_id, workspace_id)
        SELECT id, workspace_id FROM documents WHERE workspace_id IS NOT NULL;

      -- What a run saw must survive the passage being replaced: a re-extraction
      -- rewrites every chunk of a document, and the old usage rows cascaded
      -- away with them, so the genesis of an earlier run lost its citations.
      -- The usage now names the document (which outlives its chunks) and
      -- keeps the chunk id as a plain reference; consultedFor LEFT JOINs the
      -- chunk and says "replaced" when it is gone. SQLite cannot add a
      -- foreign key to an existing table, hence the rebuild.
      CREATE TABLE document_usages_v2 (
        run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        chunk_id    TEXT NOT NULL,
        score       REAL NOT NULL,
        PRIMARY KEY (run_id, chunk_id)
      );
      INSERT INTO document_usages_v2 (run_id, document_id, chunk_id, score)
        SELECT u.run_id, c.document_id, u.chunk_id, u.score
        FROM document_usages u JOIN document_chunks c ON c.id = u.chunk_id;
      DROP TABLE document_usages;
      ALTER TABLE document_usages_v2 RENAME TO document_usages;
      CREATE INDEX idx_document_usages_document ON document_usages(document_id);
    `,
  },
```

Ajouter au test de la Task 2 un cas « les usages existants gardent leur document » : seed `runs` (une ligne minimale), `document_chunks`, `document_usages` sous l'ancienne forme avant `FILES.sql`, puis `SELECT document_id FROM document_usages` rend l'id du document.

- [ ] **Step 4 : Vert** — `pnpm --filter @metaclaude/api test:run -- knowledge-reach db.test`.

- [ ] **Step 5 : Commit** — `git commit -am "knowledge: migration 29 — reach table, source columns, passage locations"`.

---

### Task 3 : Le chunker sait où commence et finit chaque passage

**Files:**
- Modify: `apps/api/src/learning/chunker.ts`
- Test: `apps/api/src/learning/chunker.test.ts`, snapshot `apps/api/src/learning/__snapshots__/chunker-eval-corpus.json`

**Interfaces:**
- Produces: `Chunk = { seq, heading, text, start, end }` — `start`/`end` sont des offsets dans le contenu **normalisé** (`\r\n`→`\n`), hors préfixe de chevauchement.

- [ ] **Step 1 : Figer la sortie actuelle avant de toucher au code**

Ajouter à `chunker.test.ts` :

```ts
import { evalCorpus } from './eval-corpus.js';

describe('the chunk boundaries are stable', () => {
  it('produces exactly the passages it produced before locations were added', async () => {
    const seen = evalCorpus(1).map((doc) => chunkDocument(doc.content).map(({ seq, heading, text }) => ({ seq, heading, text })));
    await expect(JSON.stringify(seen, null, 2)).toMatchFileSnapshot('./__snapshots__/chunker-eval-corpus.json');
  });
});
```

Lancer une fois **avant** toute modification : le fichier snapshot est écrit par le code actuel. Le commiter tel quel.

- [ ] **Step 2 : Tests rouges sur les offsets**

```ts
describe('where each chunk sits', () => {
  it('reports verbatim offsets for an ordinary document, overlap excluded', () => {
    const content = '# Titre\n\nPremier paragraphe.\n\n' + 'x'.repeat(CHUNK_TARGET) + '\n\nDernier paragraphe.';
    const chunks = chunkDocument(content);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const own = chunk.text.startsWith('… ') ? chunk.text.slice(chunk.text.indexOf('\n\n') + 2) : chunk.text;
      expect(content.slice(chunk.start, chunk.end)).toBe(own);
    }
  });
  it('locates the pieces of a paragraph longer than the ceiling inside that paragraph', () => {
    const sentence = 'Une phrase qui se termine ici. ';
    const paragraph = sentence.repeat(Math.ceil((CHUNK_MAX * 2) / sentence.length));
    const content = `Avant.\n\n${paragraph.trim()}\n\nAprès.`;
    const chunks = chunkDocument(content);
    for (const chunk of chunks) {
      expect(chunk.start).toBeLessThan(chunk.end);
      expect(content.slice(chunk.start, chunk.end).replace(/\s+/g, ' ')).toContain(chunk.text.split('\n\n').pop()!.slice(0, 20));
    }
    expect(chunks.at(-1)!.end).toBe(content.length);
  });
  it('skips the heading line: a chunk starts on its first own word', () => {
    const [chunk] = chunkDocument('## Section\n\nCorps du texte.');
    expect(chunk!.start).toBe('## Section\n\n'.length);
    expect(chunk!.end).toBe('## Section\n\nCorps du texte.'.length);
  });
});
```

- [ ] **Step 3 : Rouge** — `start` est `undefined`.

- [ ] **Step 4 : Implémentation**

Remplacer dans `chunker.ts` :

```ts
export interface Chunk {
  seq: number;
  heading: string;
  text: string;
  /** Offsets into the normalised content of the chunk's own text — the overlap prefix belongs to the previous chunk. */
  start: number;
  end: number;
}

interface Piece { text: string; start: number; end: number }

/** Locate each unit (sentence, word, raw slice) in `source` in order, from a moving cursor. */
function locate(source: string, units: string[], from = 0): Piece[] {
  let cursor = from;
  return units.map((unit) => {
    const at = source.indexOf(unit, cursor);
    const start = at === -1 ? cursor : at;
    cursor = start + unit.length;
    return { text: unit, start, end: cursor };
  });
}

/** Split one oversized paragraph at sentence, then word, then raw boundaries — each piece knowing its span. */
function splitLong(paragraph: string): Piece[] {
  if (paragraph.length <= CHUNK_MAX) return [{ text: paragraph, start: 0, end: paragraph.length }];

  const sentences = locate(paragraph, paragraph.split(/(?<=[.!?…»])\s+/u));
  const groups: Piece[] = [];
  let current: Piece | null = null;
  for (const sentence of sentences) {
    if (current && current.text.length + sentence.text.length + 1 > CHUNK_MAX) {
      groups.push(current);
      current = { ...sentence };
    } else {
      current = current
        ? { text: `${current.text} ${sentence.text}`, start: current.start, end: sentence.end }
        : { ...sentence };
    }
  }
  if (current) groups.push(current);

  return groups.flatMap((piece) => {
    if (piece.text.length <= CHUNK_MAX) return [piece];
    const words = locate(paragraph, piece.text.split(/\s+/u), piece.start);
    const out: Piece[] = [];
    let run: Piece | null = null;
    for (const word of words) {
      if (run && run.text.length + word.text.length + 1 > CHUNK_MAX) {
        out.push(run);
        run = { ...word };
      } else {
        run = run ? { text: `${run.text} ${word.text}`, start: run.start, end: word.end } : { ...word };
      }
      // A single "word" beyond the ceiling (a base64 blob, a minified line) is sliced raw.
      while (run.text.length > CHUNK_MAX) {
        out.push({ text: run.text.slice(0, CHUNK_MAX), start: run.start, end: run.start + CHUNK_MAX });
        run = { text: run.text.slice(CHUNK_MAX), start: run.start + CHUNK_MAX, end: run.end };
      }
    }
    if (run) out.push(run);
    return out;
  });
}

export function chunkDocument(rawContent: string): Chunk[] {
  const content = rawContent.replace(/\r\n?/g, '\n');
  const chunks: Chunk[] = [];
  let heading = '';
  let headingOfChunk = '';
  let parts: string[] = [];
  let length = 0;
  let overlap = '';
  let chunkStart = 0;
  let chunkEnd = 0;

  const flush = (): void => {
    const text = parts.join('\n\n').trim();
    if (text.length > 0) {
      chunks.push({ seq: chunks.length, heading: headingOfChunk, text, start: chunkStart, end: chunkEnd });
      overlap = tailOf(text);
    }
    parts = [];
    length = 0;
  };

  const pack = (piece: Piece, base: number): void => {
    if (length > 0 && length + piece.text.length + 2 > CHUNK_TARGET) flush();
    if (parts.length === 0) {
      headingOfChunk = heading;
      chunkStart = base + piece.start;
      if (overlap) {
        parts.push(`… ${overlap}`);
        length += overlap.length + 4;
      }
    }
    parts.push(piece.text);
    length += piece.text.length + 2;
    chunkEnd = base + piece.end;
  };

  // Paragraphs: blank-line separated blocks, each remembered by where it starts.
  const separator = /\n{2,}/g;
  let cursor = 0;
  for (;;) {
    const match = separator.exec(content);
    const rawEnd = match ? match.index : content.length;
    const raw = content.slice(cursor, rawEnd);
    const paragraph = raw.trim();
    const paragraphStart = cursor + (raw.length - raw.trimStart().length);

    if (paragraph.length > 0) {
      const lines = paragraph.split('\n');
      const headingMatch = lines[0] ? HEADING.exec(lines[0]) : null;
      if (headingMatch) {
        flush();
        heading = headingMatch[2]!.trim();
        overlap = '';
        const after = paragraph.slice(lines[0]!.length);
        const rest = after.trim();
        if (rest.length > 0) {
          const restStart = paragraphStart + lines[0]!.length + (after.length - after.trimStart().length);
          for (const piece of splitLong(rest)) pack(piece, restStart);
        }
      } else {
        for (const piece of splitLong(paragraph)) pack(piece, paragraphStart);
      }
    }
    if (!match) break;
    cursor = match.index + match[0].length;
  }
  flush();
  return chunks;
}
```

Supprimer l'ancienne fonction `pack` interne et l'ancien `splitLong`. `tailOf` et `chunkEmbeddingText` ne changent pas.

- [ ] **Step 5 : Vert, snapshot inchangé** — `pnpm --filter @metaclaude/api test:run -- chunker`. Si le snapshot diffère, c'est le code qui est faux, pas le snapshot : ne jamais le régénérer ici.

- [ ] **Step 6 : Sabotage** — remplacer `chunkStart = base + piece.start` par `chunkStart = base` ; le premier test rougit ; remettre.

- [ ] **Step 7 : Commit** — `git add -A apps/api/src/learning && git commit -m "chunker: each passage carries its offsets, boundaries unchanged"`.

---

### Task 4 : Le store — portée, provenance, source, doublon

**Files:**
- Modify: `apps/api/src/learning/knowledge.ts`
- Test: `apps/api/src/learning/knowledge.test.ts`, `apps/api/src/learning/knowledge-reach.test.ts`

**Interfaces:**
- Consumes: `Chunk.start/end` (Task 3), `ExtensionReach`, `KnowledgeDocumentMeta`, `KnowledgeSearchHit`, `KnowledgeSource` (Task 1).
- Produces:
  - `upsert(input: { id?; workspaceId; title; content; enabled?; reach?: ExtensionReach; pageBreaks?: number[]; pageUnit?: KnowledgePageUnit | null; source?: KnowledgeSource & { sha256: string } | null })`
  - `setReach(id, reach): boolean`, `patch(id, { title?, enabled? }): boolean`
  - `findBySourceHash(sha256): KnowledgeDocument | null`, `sourceOf(id): (KnowledgeSource & { sha256 }) | null`
  - `list`, `search`, `consultedFor` avec les nouveaux champs ; `KnowledgeDocument.source`, `.isGlobal`, `.workspaceIds`, `.pageUnit`.
  - `KnowledgeStoreError` avec `statusCode` 409 pour `content` sur un document issu d'un fichier et pour un doublon.

- [ ] **Step 1 : Tests rouges (dans `knowledge-reach.test.ts`, suite `describe('reach in the store')`)**

```ts
import { ConceptEmbedder } from '../test/embedders.js';
import { KnowledgeStore } from './knowledge.js';
import { migrate } from '../db/index.js';

describe('reach in the store', () => {
  let store: KnowledgeStore;
  beforeEach(() => {
    migrate(db);
    workspace('alpha'); workspace('beta'); workspace('gamma');
    store = new KnowledgeStore(db, new ConceptEmbedder());
  });
  const save = (title: string, reach: { global: boolean; workspaceIds: string[] }) =>
    store.upsert({ workspaceId: null, title, content: `${title} parle de préavis et de ${title}.`, reach });

  it('lets one document reach two workspaces and not a third, beside the global shelf', async () => {
    await save('Everywhere', { global: true, workspaceIds: [] });
    await save('Shared', { global: false, workspaceIds: ['alpha', 'beta'] });
    await save('Nowhere', { global: false, workspaceIds: [] });
    const titles = (ws: string | null | undefined) => store.list(ws === undefined ? {} : { workspaceId: ws }).map((d) => d.title).sort();
    expect(titles('alpha')).toEqual(['Everywhere', 'Shared']);
    expect(titles('gamma')).toEqual(['Everywhere']);
    expect(titles(null)).toEqual(['Everywhere']);
    expect(titles(undefined)).toEqual(['Everywhere', 'Nowhere', 'Shared']);
    // Retrieval obeys the same predicate as the listing.
    const hits = await store.search('préavis Shared', { workspaceId: 'gamma', limit: 10 });
    expect(hits.map((h) => h.documentTitle)).not.toContain('Shared');
  });
  it('replaces the reach rather than adding to it, and global clears the links', async () => {
    const doc = await save('Shared', { global: false, workspaceIds: ['alpha', 'beta'] });
    store.setReach(doc.id, { global: false, workspaceIds: ['gamma', 'unknown'] });
    expect(store.get(doc.id)!.workspaceIds).toEqual(['gamma']);
    store.setReach(doc.id, { global: true, workspaceIds: ['alpha'] });
    expect(store.get(doc.id)).toMatchObject({ isGlobal: true, workspaceIds: [] });
  });
  it('an update without a reach leaves it untouched', async () => {
    const doc = await save('Shared', { global: false, workspaceIds: ['alpha'] });
    await store.upsert({ id: doc.id, workspaceId: null, title: 'Renamed', content: doc.content });
    expect(store.get(doc.id)!.workspaceIds).toEqual(['alpha']);
  });
  it('forgets a deleted workspace by itself', async () => {
    const doc = await save('Shared', { global: false, workspaceIds: ['alpha', 'beta'] });
    db.prepare(`DELETE FROM workspaces WHERE id = 'beta'`).run();
    expect(store.get(doc.id)!.workspaceIds).toEqual(['alpha']);
  });
});

describe('provenance in the store', () => {
  it('stamps each passage with its lines and, given a page map, its pages', async () => {
    migrate(db);
    const store = new KnowledgeStore(db, new ConceptEmbedder());
    const page1 = 'Article 1.\nTout sinistre est déclaré sous cinq jours.';
    const page2 = 'Article 2.\nUne franchise de 150 euros reste due.';
    const content = `${page1}\n\n${page2}`;
    const doc = await store.upsert({ workspaceId: null, title: 'Assurance', content, reach: { global: true, workspaceIds: [] }, pageBreaks: [page1.length + 2], pageUnit: 'page' });
    const rows = db.prepare(`SELECT page_start, page_end, line_start, line_end FROM document_chunks WHERE document_id = ? ORDER BY seq`).all(doc.id);
    expect(rows).toEqual([{ page_start: 1, page_end: 2, line_start: 1, line_end: 4 }]);
    const [hit] = await store.search('franchise', { workspaceId: null });
    expect(hit).toMatchObject({ pageUnit: 'page', pageStart: 1, pageEnd: 2, lineStart: 1, lineEnd: 4 });
  });
  it('refuses a page map over content that is not in normal form', async () => {
    migrate(db);
    const store = new KnowledgeStore(db, new ConceptEmbedder());
    await expect(store.upsert({ workspaceId: null, title: 'T', content: '  padded  ', reach: { global: true, workspaceIds: [] }, pageBreaks: [], pageUnit: 'page' })).rejects.toThrow(/normal form/);
  });
});

describe('a document that came from a file', () => {
  const source = { name: 'bail.pdf', mime: 'application/pdf', bytes: 1234, extractor: 'pdf@1', sha256: 'abc' };
  it('is found by its hash, so a second upload is a 409 and not a copy', async () => {
    migrate(db);
    const store = new KnowledgeStore(db, new ConceptEmbedder());
    const doc = await store.upsert({ workspaceId: null, title: 'Bail', content: 'Le préavis est de trois mois.', reach: { global: true, workspaceIds: [] }, source });
    expect(store.findBySourceHash('abc')?.id).toBe(doc.id);
    expect(store.get(doc.id)!.source).toEqual({ name: 'bail.pdf', mime: 'application/pdf', bytes: 1234, extractor: 'pdf@1' });
    await expect(store.upsert({ workspaceId: null, title: 'Bail 2', content: 'Autre.', reach: { global: true, workspaceIds: [] }, source })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('keeps its text read-only: an edit of content is refused, a title change is not', async () => {
    migrate(db);
    const store = new KnowledgeStore(db, new ConceptEmbedder());
    const doc = await store.upsert({ workspaceId: null, title: 'Bail', content: 'Le préavis est de trois mois.', reach: { global: true, workspaceIds: [] }, source });
    await expect(store.upsert({ id: doc.id, workspaceId: null, title: 'Bail', content: 'Edité.' })).rejects.toMatchObject({ statusCode: 409 });
    expect(store.patch(doc.id, { title: 'Bail 2026' })).toBe(true);
    expect(store.get(doc.id)!.title).toBe('Bail 2026');
  });
});
```

Et dans `knowledge.test.ts`, suite « crediting what a run saw » :

```ts
  it('names a replaced passage instead of dropping it from an old genesis', async () => {
    const doc = await store.upsert({ workspaceId: null, title: 'Doc', content: 'Première version du préavis.', reach: { global: true, workspaceIds: [] } });
    const hits = await store.search('préavis', { workspaceId: null });
    store.recordUsage('run_1', hits);
    await store.upsert({ id: doc.id, workspaceId: null, title: 'Doc', content: 'Seconde version, tout autre texte.' });
    const consulted = store.consultedFor('run_1');
    expect(consulted).toHaveLength(1);
    expect(consulted[0]).toMatchObject({ documentId: doc.id, title: 'Doc', replaced: true });
  });
```

Ce cas s'appuie sur la forme de `document_usages` recréée par la migration 29 (Task 2) : `recordUsage` écrit `document_id`, `consultedFor` joint le passage en `LEFT JOIN` et rend `replaced: true` quand il n'existe plus.

- [ ] **Step 2 : Rouge** — `pnpm --filter @metaclaude/api test:run -- knowledge`.

- [ ] **Step 3 : Implémentation dans `knowledge.ts`**

Types :

```ts
import type { ExtensionReach, KnowledgePageUnit, KnowledgeLocation, KnowledgeSource } from '@metaclaude/shared';

export interface KnowledgeDocument {
  id: string; workspaceId: string | null; title: string; content: string; enabled: boolean;
  chunkCount: number; embeddingModel: string; isGlobal: boolean; workspaceIds: string[];
  source: KnowledgeSource | null; pageUnit: KnowledgePageUnit | null; createdAt: number; updatedAt: number;
}
export type KnowledgeSearchResult = KnowledgeLocation & {
  chunkId: string; documentId: string; documentTitle: string; sourceName: string | null;
  workspaceId: string | null; heading: string; text: string; score: number;
};
export interface StoredSource extends KnowledgeSource { sha256: string }
```

Le prédicat, une fois :

```ts
/**
 * What a workspace reaches. One constant for the listing and the search, so
 * the two cannot disagree about who sees a document — the reason the reach
 * lives in `is_global` and a join table rather than in a column (see
 * migration 26 for the argument, made once for the registry).
 */
const REACH_OF_WORKSPACE =
  '(d.is_global = 1 OR d.id IN (SELECT document_id FROM document_workspaces WHERE workspace_id = ?))';
const GLOBAL_ONLY = 'd.is_global = 1';

function reachClause(workspaceId: string | null | undefined): { sql: string; params: string[] } {
  if (workspaceId === undefined) return { sql: '', params: [] };
  if (workspaceId === null) return { sql: GLOBAL_ONLY, params: [] };
  return { sql: REACH_OF_WORKSPACE, params: [workspaceId] };
}
```

`list` et `candidateChunks` utilisent `reachClause` (alias `d` sur `documents` dans les deux requêtes ; `list` : `FROM documents d`, colonnes préfixées, plus `(SELECT MAX(c.page_end) FROM document_chunks c WHERE c.document_id = d.id) AS page_count` et `d.source_name, d.source_mime, d.source_bytes, d.extractor, d.page_unit, d.is_global`). `workspaceIds` par `reachOf(ids)` :

```ts
private reachOf(ids: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  if (ids.length === 0) return found;
  const rows = this.db
    .prepare<string[], { document_id: string; workspace_id: string }>(
      `SELECT document_id, workspace_id FROM document_workspaces WHERE document_id IN (${ids.map(() => '?').join(',')}) ORDER BY workspace_id`,
    )
    .all(...ids);
  for (const row of rows) found.set(row.document_id, [...(found.get(row.document_id) ?? []), row.workspace_id]);
  return found;
}

setReach(id: string, reach: ExtensionReach): boolean {
  return tx(this.db, () => {
    const changed = this.db.prepare('UPDATE documents SET is_global = ?, updated_at = ? WHERE id = ?').run(reach.global ? 1 : 0, this.now(), id).changes > 0;
    if (!changed) return false;
    this.db.prepare('DELETE FROM document_workspaces WHERE document_id = ?').run(id);
    if (reach.global) return true;
    // An id naming no workspace is dropped, not refused: the form was open while somebody deleted it.
    const insert = this.db.prepare('INSERT OR IGNORE INTO document_workspaces (document_id, workspace_id) SELECT ?, id FROM workspaces WHERE id = ?');
    for (const workspaceId of new Set(reach.workspaceIds)) insert.run(id, workspaceId);
    return true;
  });
}

patch(id: string, fields: { title?: string; enabled?: boolean }): boolean {
  const sets: string[] = []; const params: unknown[] = [];
  if (fields.title !== undefined) { const title = fields.title.trim(); if (!title) throw new KnowledgeStoreError('A document needs a title.'); if (title.length > MAX_TITLE_LENGTH) throw new KnowledgeStoreError('That title is an essay.'); sets.push('title = ?'); params.push(title); }
  if (fields.enabled !== undefined) { sets.push('enabled = ?'); params.push(fields.enabled ? 1 : 0); }
  if (sets.length === 0) return this.rowById(id) !== null;
  sets.push('updated_at = ?'); params.push(this.now(), id);
  return this.db.prepare(`UPDATE documents SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
}

findBySourceHash(sha256: string): KnowledgeDocument | null {
  const row = this.db.prepare<[string], DocumentRow>('SELECT * FROM documents WHERE source_sha256 = ?').get(sha256);
  return row ? this.toDocument(row) : null;
}

sourceOf(id: string): StoredSource | null {
  const row = this.rowById(id);
  if (!row || !row.source_sha256) return null;
  return { name: row.source_name!, mime: row.source_mime!, bytes: row.source_bytes!, extractor: row.extractor!, sha256: row.source_sha256 };
}
```

(`toDocument` devient une méthode, car elle a besoin de `reachOf`.) Dans `upsert` :

```ts
const existing = input.id ? this.rowById(input.id) : null;
if (input.id && !existing) throw new KnowledgeStoreError('Document not found.', 404);
// The reach a document is created with when the caller gave none: the old
// contract, kept for the corpus, the benches and check:e2e — attachOnCreate
// in the registry does the same.
const reach = input.reach ?? (existing ? null : input.workspaceId === null ? { global: true, workspaceIds: [] } : { global: false, workspaceIds: [input.workspaceId] });
// A file's text is what its extractor produced: the page and line locations
// are true of that text and of nothing else. Re-extract to change it.
if (existing?.source_sha256 && !input.source && existing.content_hash !== hash) {
  throw new KnowledgeStoreError('This document comes from a file; re-extract it rather than editing its text.', 409);
}
if (input.source && !existing) {
  const duplicate = this.findBySourceHash(input.source.sha256);
  if (duplicate) throw new KnowledgeStoreError(`This file is already in the library as “${duplicate.title}”.`, 409);
}
if (input.pageBreaks) {
  if (content !== input.content) throw new KnowledgeStoreError('A page map needs content in normal form.', 500);
  for (const at of input.pageBreaks) if (at < 0 || at > content.length) throw new KnowledgeStoreError('A page break falls outside the content.', 500);
}
```

Et à l'écriture des passages :

```ts
const lineAt = lineCounter(content);
const pageAt = pageCounter(input.pageBreaks ?? []);
chunks.forEach((chunk, index) => {
  insert.run(newId('chunk'), id, chunk.seq, chunk.heading, chunk.text, vectors ? packEmbedding(vectors[index]!) : null,
    input.pageBreaks ? pageAt(chunk.start) : null, input.pageBreaks ? pageAt(Math.max(chunk.start, chunk.end - 1)) : null,
    lineAt(chunk.start), lineAt(Math.max(chunk.start, chunk.end - 1)));
});
```

avec, au niveau module :

```ts
/** 1-based line of an offset; offsets arrive in increasing order, so one pass over the newlines suffices. */
function lineCounter(content: string): (offset: number) => number {
  let line = 1; let cursor = 0;
  return (offset) => {
    while (cursor < offset) { if (content.charCodeAt(cursor) === 10) line += 1; cursor += 1; }
    return line;
  };
}
/** 1-based page of an offset: page i + 2 starts at breaks[i]. */
function pageCounter(breaks: readonly number[]): (offset: number) => number {
  return (offset) => { let page = 1; for (const at of breaks) { if (offset >= at) page += 1; else break; } return page; };
}
```

Les colonnes `source_*`, `extractor`, `page_unit` s'écrivent dans l'`INSERT`/`UPDATE` (`input.source ?? null` ; sur un `UPDATE` sans `source`, on conserve les colonnes existantes). Après l'écriture : `if (input.reach) this.setReach(id, input.reach)` **dans** la transaction (déplacer `setReach` en méthode privée `writeReach` sans `tx` et l'appeler des deux endroits). `search` sélectionne aussi `c.page_start, c.page_end, c.line_start, c.line_end`, `d.page_unit, d.source_name` (via `documentTitles` → renommer `documentMeta`). `recordUsage` écrit `document_id`. `consultedFor` :

```sql
SELECT u.chunk_id, u.document_id, d.title, d.page_unit, c.heading, c.page_start, c.page_end, c.line_start, c.line_end, u.score,
       (c.id IS NULL) AS replaced
FROM document_usages u
JOIN documents d ON d.id = u.document_id
LEFT JOIN document_chunks c ON c.id = u.chunk_id
WHERE u.run_id = ? ORDER BY u.score DESC
```

`delete(id)` inchangé (le fichier est effacé par la route, Task 9). `reindex` : ne touche pas aux nouvelles colonnes.

- [ ] **Step 4 : Vert** — `pnpm --filter @metaclaude/api test:run -- knowledge chunker kernel`. Les tests existants qui appellent `upsert` sans `reach` continuent de créer des documents grâce au `reach` dérivé de `workspaceId` (ci-dessus) ; `writeReach(id, reach)` est appelé dans la transaction quand `reach` n'est pas `null`.

- [ ] **Step 5 : Sabotage** — inverser `REACH_OF_WORKSPACE` en `d.is_global = 0 …` ; les tests de portée rougissent ; remettre.

- [ ] **Step 6 : Commit** — `git commit -am "knowledge store: many-to-many reach, passage locations, file source, duplicates"`.

---

### Task 5 : Extracteurs texte, HTML et CSV, et le générateur de fixtures

**Files:**
- Create: `apps/api/src/learning/extract/errors.ts`, `types.ts`, `html.ts`, `text.ts`, `csv.ts`
- Create: `apps/api/scripts/make-knowledge-fixtures.mjs`, fixtures sous `apps/api/src/learning/extract/fixtures/`
- Test: `apps/api/src/learning/extract/html.test.ts`, `csv.test.ts`

**Interfaces:**
- Produces:
  - `ExtractedText = { text: string; pageBreaks: number[]; pageUnit: KnowledgePageUnit | null; extractor: string }`
  - `ExtractError extends Error { code: 'unsupported' | 'empty' | 'corrupt' | 'encrypted' | 'no-text' | 'too-large' | 'timeout'; statusCode: number }`
  - `htmlToMarkdown(html: string): string`, `normaliseText(text: string): string`, `rowsToParagraphs(rows: string[][]): string`, `extractText(name, data): ExtractedText`, `extractCsv(name, data): ExtractedText`.

- [ ] **Step 1 : Le générateur de fixtures (sans test : c'est un script)**

`apps/api/scripts/make-knowledge-fixtures.mjs` — reprendre `fixtures.mjs` du scratchpad (docx via `docx`, xlsx via `exceljs`, pptx via `pptxgenjs`, pdf et scan via `pdf-lib`), en écrivant dans `src/learning/extract/fixtures/`, et y ajouter `sample.csv` (`Mois;Échéance;Loyer\n2026-01;05/01/2026;950\n"Note";"Le syndic ; gère";`), `sample.html` (la page « sauvage » du prototype), `sample.md`. Copier aussi depuis le scratchpad `twocol.tex` **et** `twocol.pdf` (110 Ko, composé avec pdflatex et Latin Modern : un vrai document à deux colonnes, libre de droits, que le script ne régénère pas — il dit qu'une distribution TeX est nécessaire et que le PDF commité fait foi). Les générateurs (`docx`, `pptxgenjs`, `pdf-lib`) s'installent en `devDependencies` de `@metaclaude/api` ; `exceljs` est déjà une dépendance (Task 6). En-tête du script : comment le relancer, et que les fixtures sont **commitées** (les tests ne doivent pas les régénérer : un test qui écrit ce qu'il lit ne prouve rien). Exécuter une fois : `node scripts/make-knowledge-fixtures.mjs` depuis `apps/api`, vérifier que chaque fichier fait moins de 100 Ko.

- [ ] **Step 2 : Tests rouges HTML**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { htmlToMarkdown } from './html.js';

const wild = readFileSync(new URL('./fixtures/sample.html', import.meta.url), 'utf8');

describe('htmlToMarkdown', () => {
  it('turns headings, lists and tables into the markdown the chunker sections on', () => {
    const md = htmlToMarkdown(wild);
    expect(md).toContain('# Runbook & conventions');
    expect(md).toContain('## Steps');
    expect(md).toContain('- Build');
    expect(md).toContain('| Key | Value |');
    expect(md).toContain('| timeout | 30 s |');
  });
  it('drops scripts, styles and navigation, and decodes named and numeric entities', () => {
    const md = htmlToMarkdown(wild);
    expect(md).not.toContain('alert(');
    expect(md).not.toContain('Home');
    expect(md).toContain('été');
    expect(md).toContain('—');
  });
  it('gives every table row its own paragraph so a row is never split', () => {
    expect(htmlToMarkdown('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')).toBe('| a | b |\n\n| c | d |');
  });
});
```

- [ ] **Step 3 : Rouge**, puis **Step 4 : implémentation**

`errors.ts` :

```ts
export type ExtractErrorCode = 'unsupported' | 'empty' | 'corrupt' | 'encrypted' | 'no-text' | 'too-large' | 'timeout';
const STATUS: Record<ExtractErrorCode, number> = { unsupported: 415, empty: 400, corrupt: 400, encrypted: 422, 'no-text': 422, 'too-large': 413, timeout: 422 };
export class ExtractError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ExtractErrorCode, message: string) { super(message); this.name = 'ExtractError'; this.statusCode = STATUS[code]; }
}
```

`types.ts` :

```ts
import type { KnowledgePageUnit } from '@metaclaude/shared';
export interface ExtractedText { text: string; pageBreaks: number[]; pageUnit: KnowledgePageUnit | null; extractor: string }
export interface ExtractInput { name: string; mime: string; data: Buffer }

/** The normal form every extractor hands over: LF, trimmed, at most one blank line in a row. */
export function normaliseText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Table rows as pipe lines, each its own paragraph, so the chunker never cuts a row in two. */
export function rowsToParagraphs(rows: readonly (readonly string[])[]): string {
  return rows.filter((cells) => cells.some((c) => c.trim() !== '')).map((cells) => `| ${cells.map((c) => c.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '¦').trim()).join(' | ')} |`).join('\n\n');
}

/** Join page texts into one document and say where each page starts. */
export function joinPages(pages: readonly string[]): { text: string; pageBreaks: number[] } {
  const cleaned = pages.map(normaliseText);
  const breaks: number[] = [];
  let text = '';
  cleaned.forEach((page, index) => {
    if (index > 0) { text += '\n\n'; breaks.push(text.length); }
    text += page;
  });
  return { text, pageBreaks: breaks };
}
```

Note sur `joinPages` : une page vide donne un `\n\n` collé au suivant, que `normaliseText` réduirait et décalerait les offsets — donc **ne pas** re-normaliser après jonction ; la sortie est déjà en forme normale (chaque page l'est, et le séparateur est exactement `\n\n`). Sauf si la première page est vide : `text` commence par `\n\n` → forcer `cleaned[0]` non vide en sautant les pages vides de tête tout en gardant leur numérotation : remplacer une page vide par `''` et **ne pas** avancer `text` (la rupture reste à l'offset courant ; deux pages vides consécutives partagent un offset, `pageCounter` rend la dernière). Écrire un test pour le PDF scanné (Task 6) qui vérifie `pageBreaks.length === pages - 1` et `text === ''`.

`html.ts` : le prototype du scratchpad, avec une table d'entités nommées (`nbsp, amp, lt, gt, quot, apos, mdash, ndash, hellip, laquo, raquo, eacute, egrave, agrave, ecirc, ccedil, ugrave, ocirc, icirc, euro, copy, deg`), `rowsToParagraphs` pour les tableaux, et `normaliseText` en sortie.

`text.ts` :

```ts
export function extractPlainText(input: ExtractInput): ExtractedText {
  const text = input.data.toString('utf8').replace(/^﻿/, '');
  const pretty = input.mime === 'application/json' ? prettyJson(text) : text;
  return { text: normaliseText(pretty), pageBreaks: [], pageUnit: null, extractor: 'text@1' };
}
function prettyJson(text: string): string { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } }
```

`csv.ts` : détecter le séparateur (celui de `,`, `;`, `\t` le plus fréquent sur la première ligne non vide), parser avec guillemets doublés, produire `## <nom sans extension> — <en-têtes joints par | >` puis `rowsToParagraphs(rows.slice(1))` ; `pageUnit: 'sheet'`, `pageBreaks: []`, `extractor: 'csv@1'`.

- [ ] **Step 5 : Tests CSV** (`csv.test.ts`) : séparateur `;` détecté, guillemets avec `;` dedans conservés, ligne vide sautée, l'en-tête devient le titre de section.

- [ ] **Step 6 : Vert, sabotage (retirer le `filter` des lignes vides), commit** — `git add apps/api/scripts/make-knowledge-fixtures.mjs apps/api/src/learning/extract apps/api/package.json pnpm-lock.yaml && git commit -m "knowledge: text, html and csv extractors with committed fixtures"`.

---

### Task 6 : docx, xlsx, pptx, pdf

**Files:**
- Modify: `apps/api/package.json` (dependencies : `mammoth`, `exceljs`, `pdfjs-dist`, `fflate` ; devDependencies : `docx`, `pptxgenjs`, `pdf-lib`)
- Create: `apps/api/src/learning/extract/docx.ts`, `xlsx.ts`, `pptx.ts`, `pdf.ts`
- Test: un `*.test.ts` par extracteur

**Interfaces:**
- Produces: `extractDocx`, `extractXlsx`, `extractPptx`, `extractPdf : (input: ExtractInput) => Promise<ExtractedText>`.

- [ ] **Step 1 : Installer** — `pnpm --filter @metaclaude/api add mammoth exceljs pdfjs-dist fflate && pnpm --filter @metaclaude/api add -D docx pptxgenjs pdf-lib`. Vérifier `pnpm ls` : aucun avertissement de script de build ignoré pour ces paquets.

- [ ] **Step 2 : Tests rouges** (un fichier par format ; celui du PDF :)

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractPdf } from './pdf.js';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const poppler = popplerAvailable(); // resolves the binary once; the suite says which engine it ran

describe.each([
  ['poppler', () => new PopplerEngine()],
  ['pdfjs (the fallback)', () => new PdfjsEngine()],
])('extractPdf through %s', (label, engine) => {
  const skip = label === 'poppler' && !poppler;
  it.skipIf(skip)('reads one page after another and says where each starts', async () => {
    const out = await extractPdf({ name: 'assurance.pdf', mime: 'application/pdf', data: fixture('assurance.pdf') }, engine());
    expect(out.pageUnit).toBe('page');
    expect(out.pageBreaks).toHaveLength(2);
    expect(out.text.slice(out.pageBreaks[0], out.pageBreaks[0]! + 20)).toBe('Article 2 - Franchi');
    expect(out.text).toContain('cinq jours ouvrés\nsuivant sa constatation');
  });
  it.skipIf(skip)('refuses a scan that carries no text layer, by name', async () => {
    await expect(extractPdf({ name: 'scan.pdf', mime: 'application/pdf', data: fixture('scan.pdf') }, engine())).rejects.toMatchObject({ code: 'no-text' });
  });
  it.skipIf(skip)('refuses a password-protected file and a file that is not a PDF, each by name', async () => {
    await expect(extractPdf({ name: 'x.pdf', mime: 'application/pdf', data: fixture('encrypted.pdf') }, engine())).rejects.toMatchObject({ code: 'encrypted' });
    await expect(extractPdf({ name: 'x.pdf', mime: 'application/pdf', data: fixture('bail.docx') }, engine())).rejects.toMatchObject({ code: 'corrupt' });
  });
});

describe('a two-column PDF', () => {
  it.skipIf(!poppler)('keeps every paragraph whole and the articles in order under poppler', async () => {
    const out = await extractPdf({ name: 'twocol.pdf', mime: 'application/pdf', data: fixture('twocol.pdf') }, new PopplerEngine());
    const at = (needle: string) => { const i = out.text.indexOf(needle); expect(i, needle).toBeGreaterThanOrEqual(0); return i; };
    expect(at('Article 1')).toBeLessThan(at('Article 2'));
    expect(at('Article 3')).toBeLessThan(at('Article 4'));
    expect(at('Article 5')).toBeLessThan(at('Article 6'));
    // A sentence that wraps inside the left column must not be cut by the right column.
    expect(out.text.replace(/\s+/g, ' ')).toContain('composé de trois pièces principales, d’une cuisine et d’une salle de bains');
    expect(out.extractor).toMatch(/^pdf@poppler-/);
  });
  it('names the fallback as such, so a document read under it can be told apart and re-extracted', async () => {
    const out = await extractPdf({ name: 'twocol.pdf', mime: 'application/pdf', data: fixture('twocol.pdf') }, new PdfjsEngine());
    expect(out.extractor).toBe('pdf@pdfjs');
  });
  if (!poppler) it('says why the poppler cases did not run', () => { console.warn('poppler pdftotext is not on PATH: its cases were skipped (CI installs poppler-utils)'); expect(poppler).toBe(false); });
});
```

`encrypted.pdf` : généré dans `make-knowledge-fixtures.mjs` avec PyMuPDF **si** Python est là, sinon copié depuis le scratchpad et commité (2 Ko) — le script dit lequel des deux il a fait.

docx : `# Bail d'habitation — 12 rue des Lilas`, `## Résiliation par le locataire`, `**Important :**`, `| Loyer | 950 € |`, `- Premier point` ; corrompu → `corrupt`. xlsx : `## Loyers 2026 — Mois | Échéance | Loyer | Charges | Total`, une ligne `| 2026-03 | 2026-03-05 | 950 | 110 | 1060 |`, `## Contacts — …`, la ligne vide sautée, `pageUnit: 'sheet'`, `pageBreaks.length === 1`. pptx : `## Diapositive 2`, `| Perte de données | Sauvegarde à froid avant bascule |`, `Notes : Le rollback est testé en préprod chaque semaine.`, `pageBreaks.length === 2`, ordre 1-2-3.

- [ ] **Step 3 : Implémentations**

`docx.ts` :

```ts
import mammoth from 'mammoth';
import { ExtractError } from './errors.js';
import { htmlToMarkdown } from './html.js';
import type { ExtractInput, ExtractedText } from './types.js';

export async function extractDocx(input: ExtractInput): Promise<ExtractedText> {
  let html: string;
  try {
    ({ value: html } = await mammoth.convertToHtml({ buffer: input.data }));
  } catch (error) {
    throw new ExtractError('corrupt', `This .docx could not be read (${(error as Error).message}).`);
  }
  return { text: htmlToMarkdown(html), pageBreaks: [], pageUnit: null, extractor: 'docx@1' };
}
```

`xlsx.ts` : exceljs `Workbook.xlsx.load(arrayBufferOf(data))` dans un `try` → `corrupt` — avec `const arrayBufferOf = (data: Buffer): ArrayBuffer => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;`, parce que sous `@types/node` 22 un `Buffer<ArrayBuffer>` n'est pas assignable au `Buffer` qu'exceljs déclare (mesuré : `tsc` refuse l'appel direct) ; par feuille, `header = première ligne non vide`, section `## ${sheet.name} — ${header.join(' | ')}`, `rowsToParagraphs(rows après l'en-tête)` ; cellules : `Date` → ISO date, `{ result }` → `result`, `{ richText }` → concaténation, `{ text }`/`{ hyperlink }` → `text`, `{ error }` → `error`, `null` → `''`. Pages : `joinPages(sections)`, `pageUnit: 'sheet'`.

`pptx.ts` : `unzipSync(new Uint8Array(data), { filter: (file) => file.originalSize <= 64 * 1024 * 1024 })` dans un `try` → `corrupt` ; si `ppt/presentation.xml` absent → `corrupt` ; le code du prototype (rels dans les deux ordres d'attributs, `<p:sp>` titre/corps, `<a:tbl>`, notes via `slides/_rels/slideN.xml.rels`) ; par diapositive `## Diapositive n — Titre` (ou `## Diapositive n`), corps, tableau, `Notes : …` ; `joinPages`, `pageUnit: 'slide'`.

`pdf.ts` — deux moteurs derrière une interface, poppler par défaut :

```ts
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const STANDARD_FONTS = require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, 'standard_fonts/');

/** Page texts, best-effort in reading order, and the engine's name for `extractor`. */
export interface PdfEngine { pages(data: Buffer): Promise<string[]>; readonly name: string }

/**
 * poppler's pdftotext: the one engine measured to keep a two-column page's
 * paragraphs whole (see the spec, § 3). A separate process, so it needs no
 * worker: `timeout` and `maxBuffer` bound it, and a hostile file dies alone.
 */
export class PopplerEngine implements PdfEngine {
  readonly name: string;
  constructor(private readonly binary = 'pdftotext', version = popplerVersion(binary)) { this.name = `pdf@poppler-${version}`; }
  /**
   * `spawn`, not `execFile`: the bytes go in on stdin (`execFile` has no
   * `input`; only its sync twin does), and stdout is capped by hand so a PDF
   * whose text is unbounded is stopped at 8 MiB rather than buffered whole.
   */
  pages(data: Buffer): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, ['-enc', 'UTF-8', '-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = []; let size = 0; let stderr = ''; let settled = false;
      const fail = (error: ExtractError) => { if (!settled) { settled = true; child.kill(); reject(error); } };
      const timer = setTimeout(() => fail(new ExtractError('timeout', 'Reading this PDF gave up after 60 s.')), 60_000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) fail(new ExtractError('too-large', 'The text of this PDF exceeds what a document may hold.'));
        else out.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(timer); fail(new ExtractError('corrupt', error.code === 'ENOENT' ? 'pdftotext is not installed.' : `pdftotext failed: ${error.message}`)); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        if (code !== 0) {
          if (/Incorrect password/i.test(stderr)) return reject(new ExtractError('encrypted', 'This PDF is password-protected.'));
          return reject(new ExtractError('corrupt', `This PDF could not be read (${stderr.trim().split('\n').pop() ?? `exit ${code}`}).`));
        }
        // pdftotext ends every page with a form feed, the last one included.
        resolve(Buffer.concat(out).toString('utf8').replace(/\f$/, '').split('\f'));
      });
      child.stdin.on('error', () => undefined); // EPIPE when the child refused the file early: `close` carries the verdict.
      child.stdin.end(data);
    });
  }
}

/** pdfjs: the fallback when poppler is not installed — a developer's machine. Lines by baseline, columns not separated. */
export class PdfjsEngine implements PdfEngine {
  readonly name = 'pdf@pdfjs';
  async pages(data: Buffer): Promise<string[]> {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // No `isEvalSupported`: pdfjs 6 removed it from DocumentInitParameters (measured: tsc refuses it).
    const task = pdfjs.getDocument({ data: new Uint8Array(data), standardFontDataUrl: STANDARD_FONTS, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    try {
      const pdf = await task.promise.catch((error: Error) => {
        if (error.name === 'PasswordException') throw new ExtractError('encrypted', 'This PDF is password-protected.');
        throw new ExtractError('corrupt', `This PDF could not be read (${error.message}).`);
      });
      const pages: string[] = [];
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        // NFKC folds the ligature glyphs a font without a Unicode table leaves behind (ﬁ → fi).
        pages.push(linesOf(content.items).normalize('NFKC'));
        page.cleanup();
      }
      return pages;
    } finally {
      await task.destroy();
    }
  }
}

/** `pdftotext -v` once; null when the binary is not there. Sync on purpose: called at construction, at boot. */
export function popplerVersion(binary = 'pdftotext'): string | null { /* spawnSync(binary, ['-v']) → /pdftotext version (\S+)/ on stderr, null on ENOENT */ }
export function popplerAvailable(): boolean { return popplerVersion() !== null; }
export function defaultPdfEngine(): PdfEngine { return popplerAvailable() ? new PopplerEngine() : new PdfjsEngine(); }

export async function extractPdf(input: ExtractInput, engine: PdfEngine = defaultPdfEngine()): Promise<ExtractedText> {
  const pages = await engine.pages(input.data);
  if (pages.every((page) => page.trim() === '')) {
    throw new ExtractError('no-text', 'This PDF has no text layer — a scan needs OCR, which is not supported.');
  }
  return { ...joinPages(pages), pageUnit: 'page', extractor: engine.name };
}

/** Items grouped into lines by their baseline; a gap of more than two points is a new line. */
function linesOf(items: readonly unknown[]): string {
  const lines: string[] = []; let line: string[] = []; let lastY: number | null = null;
  for (const item of items as Array<{ str?: string; transform?: number[]; hasEOL?: boolean }>) {
    if (typeof item.str !== 'string' || !item.transform) continue;
    const y = Math.round(item.transform[5]!);
    if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line.join('')); line = []; }
    line.push(item.str);
    if (item.hasEOL) { lines.push(line.join('')); line = []; lastY = null; continue; }
    lastY = y;
  }
  if (line.length > 0) lines.push(line.join(''));
  return lines.join('\n');
}
```

Typage : mesuré sous NodeNext avec `@types/node` 22 et le `tsc` du dépôt — l'import `pdfjs-dist/legacy/build/pdf.mjs` typecheck sans déclaration supplémentaire, `mammoth` et `fflate` aussi ; les deux seuls écarts sont ceux corrigés ci-dessus (`isEvalSupported`, `Buffer` d'exceljs).

- [ ] **Step 4 : Vert** — `pnpm --filter @metaclaude/api test:run -- extract` puis `pnpm --filter @metaclaude/api typecheck`.

- [ ] **Step 5 : Sabotage** (retirer le `throw` `no-text` ; le test du scan rougit) puis **commit** — `git commit -am "knowledge: docx, xlsx, pptx and pdf extractors"`.

---

### Task 7 : Dispatch et worker

**Files:**
- Create: `apps/api/src/learning/extract/index.ts`, `worker.ts`, `worker-extractor.ts`
- Test: `apps/api/src/learning/extract/index.test.ts`, `worker-extractor.test.ts`

**Interfaces:**
- Produces:
  - `extractInProcess(input: ExtractInput): Promise<ExtractedText>` (dispatch)
  - `resolveKnowledgeMime(name, mime): string | null` (allow-list + extension)
  - `interface Extractor { extract(input: ExtractInput): Promise<ExtractedText> }` ; `WorkerExtractor implements Extractor` (options `{ timeoutMs = 60_000, maxOldGenerationSizeMb = 512 }`) ; `InProcessExtractor` pour les tests et benches.

- [ ] **Step 1 : Tests rouges (`index.test.ts`)**

```ts
describe('resolveKnowledgeMime', () => {
  it('trusts a listed MIME, infers from the extension when the browser sent none, refuses the rest', () => {
    expect(resolveKnowledgeMime('x.bin', 'application/pdf')).toBe('application/pdf');
    expect(resolveKnowledgeMime('notes.md', '')).toBe('text/markdown');
    expect(resolveKnowledgeMime('deck.pptx', 'application/octet-stream')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(resolveKnowledgeMime('archive.zip', 'application/zip')).toBeNull();
    expect(resolveKnowledgeMime('legacy.doc', '')).toBeNull();
  });
});
describe('extractInProcess', () => {
  it('routes every listed type to an extractor — the fixture of each comes back with text', async () => {
    for (const [name, mime] of [['bail.docx', ''], ['loyers.xlsx', ''], ['deploiement.pptx', ''], ['assurance.pdf', ''], ['sample.csv', ''], ['sample.html', ''], ['sample.md', '']]) {
      const out = await extractInProcess({ name, mime, data: fixture(name) });
      expect(out.text.length, name).toBeGreaterThan(20);
    }
  });
  it('refuses an unsupported type naming the accepted ones', async () => {
    await expect(extractInProcess({ name: 'a.zip', mime: 'application/zip', data: Buffer.from('x') })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('.pdf') });
  });
  it('refuses an empty file and a text that exceeds the document cap', async () => {
    await expect(extractInProcess({ name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(0) })).rejects.toMatchObject({ code: 'empty' });
    await expect(extractInProcess({ name: 'a.txt', mime: 'text/plain', data: Buffer.alloc(600 * 1024, 97) })).rejects.toMatchObject({ code: 'too-large', message: expect.stringContaining('512') });
  });
});
```

`worker-extractor.test.ts` — s'exécute contre `dist` et le dit :

```ts
const built = existsSync(new URL('../../../dist/learning/extract/worker.js', import.meta.url));
describe.skipIf(!built)('WorkerExtractor (needs `pnpm --filter @metaclaude/api build`; check:e2e covers it on CI)', () => {
  it('extracts in another thread and returns the same text as in-process', async () => { /* WorkerExtractor sur assurance.pdf, comparer à extractInProcess */ });
  it('turns a timeout into a named error and kills the worker', async () => { /* timeoutMs: 1 sur big.pdf généré à la volée → code 'timeout' */ });
});
if (!built) it('says why the worker suite did not run', () => { console.warn('WorkerExtractor tests skipped: apps/api/dist is not built'); expect(built).toBe(false); });
```

- [ ] **Step 2 : Implémentation**

`index.ts` :

```ts
const EXTENSION_MIME: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', html: 'text/html', htm: 'text/html', json: 'application/json', pdf: 'application/pdf', docx: '…wordprocessingml.document', xlsx: '…spreadsheetml.sheet', pptx: '…presentationml.presentation' };
const ACCEPTED = new Set<string>(KNOWLEDGE_MIME_TYPES);
export const KNOWLEDGE_EXTENSIONS = Object.keys(EXTENSION_MIME);

export function resolveKnowledgeMime(name: string, mime: string): string | null {
  if (ACCEPTED.has(mime)) return mime;
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  return EXTENSION_MIME[extension] ?? null;
}

export async function extractInProcess(input: ExtractInput): Promise<ExtractedText> {
  if (input.data.length === 0) throw new ExtractError('empty', 'The file is empty.');
  const mime = resolveKnowledgeMime(input.name, input.mime);
  if (!mime) throw new ExtractError('unsupported', `“${input.mime || input.name.split('.').pop() || 'unknown'}” is not a type the library reads. Accepted: ${KNOWLEDGE_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`);
  const out = await EXTRACTORS[mime]!({ ...input, mime });
  if (out.text.trim() === '') throw new ExtractError('no-text', 'No text came out of this file.');
  const bytes = Buffer.byteLength(out.text, 'utf8');
  if (bytes > MAX_DOCUMENT_BYTES) throw new ExtractError('too-large', `The extracted text is ${Math.round(bytes / 1024)} KiB; a document is capped at ${MAX_DOCUMENT_BYTES / 1024} KiB. Split the file, or keep the part the agent needs.`);
  return out;
}
```

(`MAX_DOCUMENT_BYTES` importé de `../knowledge.js` ; la table `EXTRACTORS` mappe chaque MIME de `KNOWLEDGE_MIME_TYPES` — un test vérifie que **chaque** entrée de la liste a un extracteur, sinon un type accepté au contrat serait refusé à l'exécution.)

`worker.ts` :

```ts
import { parentPort, workerData } from 'node:worker_threads';
import { extractInProcess } from './index.js';
import { ExtractError } from './errors.js';
const input = workerData as { name: string; mime: string; data: Uint8Array };
extractInProcess({ ...input, data: Buffer.from(input.data) }).then(
  (out) => parentPort!.postMessage({ ok: true, out }),
  (error: unknown) => parentPort!.postMessage({ ok: false, code: error instanceof ExtractError ? error.code : 'corrupt', message: (error as Error).message }),
);
```

`worker-extractor.ts` :

```ts
export class WorkerExtractor implements Extractor {
  constructor(private readonly options: { timeoutMs?: number; maxOldGenerationSizeMb?: number } = {}) {}
  extract(input: ExtractInput): Promise<ExtractedText> {
    const { timeoutMs = 60_000, maxOldGenerationSizeMb = 512 } = this.options;
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { name: input.name, mime: input.mime, data: input.data },
        resourceLimits: { maxOldGenerationSizeMb },
      });
      const timer = setTimeout(() => { void worker.terminate(); reject(new ExtractError('timeout', `Extraction gave up after ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
      worker.once('message', (message: { ok: true; out: ExtractedText } | { ok: false; code: ExtractErrorCode; message: string }) => {
        clearTimeout(timer);
        if (message.ok) resolve(message.out); else reject(new ExtractError(message.code, message.message));
        void worker.terminate();
      });
      // Measured: a worker over its heap cap surfaces as an `error` event whose
      // message says "reaching memory limit", then exits. Name it as such — an
      // operator told "corrupt" about a 3 000-page PDF would look in the wrong place.
      worker.once('error', (error) => {
        clearTimeout(timer);
        const outOfMemory = /memory limit/i.test(error.message);
        reject(new ExtractError(outOfMemory ? 'too-large' : 'corrupt', outOfMemory ? `This file needs more than ${maxOldGenerationSizeMb} MB to read; split it.` : `Extraction failed: ${error.message}`));
      });
      worker.once('exit', (code) => { clearTimeout(timer); if (code !== 0) reject(new ExtractError('timeout', `Extraction died (exit ${code}).`)); });
    });
  }
}
export class InProcessExtractor implements Extractor { extract = extractInProcess; }
```

Une `Promise` déjà résolue ignore les `reject` tardifs de `exit` : correct. `tsconfig.build.json` inclut `src/**` : `worker.js` sera dans `dist/learning/extract/`.

- [ ] **Step 3 : Vert (index), build, vert (worker)** — `pnpm --filter @metaclaude/api build && pnpm --filter @metaclaude/api test:run -- extract`.

- [ ] **Step 4 : Commit** — `git commit -am "knowledge: extraction dispatch and worker isolation"`.

---

### Task 8 : Le fichier d'origine sur disque, la config, le câblage

**Files:**
- Modify: `apps/api/src/config.ts:330-336, 396-402` (`knowledgeDir = resolve(dataDir, 'knowledge')`, `mkdirSync`)
- Create: `apps/api/src/learning/knowledge-files.ts`
- Modify: `apps/api/src/context.ts:369` (construire `KnowledgeFileStore` et `WorkerExtractor`, les exposer sur `AppContext` : `knowledgeFiles`, `extractor`)
- Test: `apps/api/src/learning/knowledge-files.test.ts`

**Interfaces:**
- Produces: `KnowledgeFileStore(dir)` : `write(sha256, mime, data): Promise<string>` (chemin relatif), `pathFor(sha256, mime): string`, `exists(sha256, mime): boolean`, `read(sha256, mime): Buffer`, `stream(sha256, mime): ReadStream`, `remove(sha256, mime): Promise<void>` ; `extensionFor(mime): string`.

- [ ] **Step 1 : Tests rouges** — écrit puis relit les mêmes octets ; `pathFor` reste sous `dir` (via `resolveInside`) ; `remove` d'un absent ne lève pas ; l'extension vient du MIME (`application/pdf` → `pdf`, docx → `docx`), jamais du nom.

- [ ] **Step 2 : Implémentation** — nom `${sha256}.${extensionFor(mime)}`, `resolveInside(dir, name)`, `writeFile` puis `rename` d'un `.part` (une écriture interrompue ne laisse pas un fichier tronqué sous le nom final), `createReadStream`, `unlink` avec `ENOENT` ignoré.

- [ ] **Step 3 : Câblage** — `context.ts` : `const knowledgeFiles = new KnowledgeFileStore(config.knowledgeDir); const extractor = new WorkerExtractor();` ; les ajouter à l'objet `AppContext` et à son interface (ligne ~145). Le harness de test (`server-harness.ts`) crée déjà un `dataDir` temporaire : rien à faire.

- [ ] **Step 4 : Vert, typecheck, commit** — `git commit -am "knowledge: keep the original file under the data directory"`.

---

### Task 9 : Routes

**Files:**
- Modify: `apps/api/src/routes/learning.ts:653-740`
- Test: `apps/api/src/routes/knowledge.test.ts` (créé, via `bootTestServer`)

**Interfaces:**
- Consumes: `context.knowledge` (Task 4), `context.knowledgeFiles`, `context.extractor` (Task 8), contrats (Task 1).
- Produces: les routes de la spec § 8.

- [ ] **Step 1 : Tests rouges** (extrait ; chaque cas est un `it`)

```ts
let server: ServerHarness;
beforeAll(async () => { server = await bootTestServer({ name: 'knowledge-routes' }); });
afterAll(async () => { await server.close(); });
const fixture = (name: string) => readFileSync(new URL(`../learning/extract/fixtures/${name}`, import.meta.url));
const upload = (name: string, extra: Record<string, unknown> = {}) =>
  server.send('POST', '/api/knowledge/upload', { name, mime: '', data: fixture(name).toString('base64'), reach: { global: true, workspaceIds: [] }, ...extra });

it('uploads a docx: 201, a titled document with its source, sections and lines', async () => {
  const response = await upload('bail.docx');
  expect(response.status).toBe(201);
  const { document } = await response.json();
  expect(document).toMatchObject({ title: 'bail', isGlobal: true, source: { name: 'bail.docx', extractor: 'docx@1' } });
  const hits = await server.get<{ results: KnowledgeSearchHit[] }>('/api/knowledge/search?q=préavis');
  expect(hits.results[0]).toMatchObject({ heading: 'Résiliation par le locataire', lineStart: expect.any(Number) });
});
it('answers 409 with the existing document on a second upload of the same bytes', async () => { /* status 409, body.document.id === first id */ });
it('refuses a .zip with 415 naming the accepted types, and an oversized payload with 413', async () => { /* zip → 415 ; data de 21 Mo → 413 */ });
it('serves the original as a download, never inline for html', async () => { /* GET /api/knowledge/:id/source → content-disposition attachment; filename="bail.docx" */ });
it('patches title, pause and reach without resending the text, and refuses content on a file-backed document', async () => { /* PATCH { enabled:false } → 200 ; POST /api/knowledge {id, content:'x'} → 409 */ });
it('re-extracts from the kept file and reports the extractor', async () => { /* POST /api/knowledge/:id/extract → 200, extractor 'docx@1', chunkCount > 0 */ });
it('deleting removes the file with the row', async () => { /* DELETE → 200 ; existsSync(join(server.dataDir,'knowledge', ...)) false */ });
it('writes an audit line per upload', async () => { /* server.get('/api/audit?…') contient action 'knowledge.upload' */ });
```

(vérifier dans `server-harness.ts` que `send` passe le CSRF ; le corps de 21 Mo se construit avec `Buffer.alloc(21 * 1024 * 1024).toString('base64')` — la route déclare `bodyLimit: 32 * 1024 * 1024`).

- [ ] **Step 2 : Implémentation**

```ts
app.post('/api/knowledge/upload', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
  const actor = requireOperator(request);
  const parsed = UploadKnowledgeRequest.safeParse(request.body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid upload.');
  const data = Buffer.from(parsed.data.data, 'base64');
  if (data.length === 0) throw new HttpError(400, 'The file is empty.');
  if (data.length > KNOWLEDGE_LIMITS.maxBytes) throw new HttpError(413, `The file exceeds ${KNOWLEDGE_LIMITS.maxBytes / (1024 * 1024)} MB.`);
  const name = safeFileName(parsed.data.name);
  const mime = resolveKnowledgeMime(name, parsed.data.mime);
  if (!mime) throw new HttpError(415, `“${parsed.data.mime || name}” is not a type the library reads. Accepted: ${KNOWLEDGE_EXTENSIONS.map((e) => `.${e}`).join(', ')}.`);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const duplicate = context.knowledge.findBySourceHash(sha256);
  if (duplicate) return reply.status(409).send({ error: `This file is already in the library as “${duplicate.title}”.`, document: context.knowledge.get(duplicate.id) });

  const extracted = await context.extractor.extract({ name, mime, data }).catch((error: unknown) => {
    if (error instanceof ExtractError) throw new HttpError(error.statusCode, error.message);
    throw error;
  });
  await context.knowledgeFiles.write(sha256, mime, data);
  let document;
  try {
    document = await context.knowledge.upsert({
      workspaceId: null,
      title: parsed.data.title ?? name.replace(/\.[^.]+$/, ''),
      content: extracted.text,
      reach: parsed.data.reach,
      pageBreaks: extracted.pageBreaks,
      pageUnit: extracted.pageUnit,
      source: { name, mime, bytes: data.length, extractor: extracted.extractor, sha256 },
    });
  } catch (error) {
    await context.knowledgeFiles.remove(sha256, mime);
    throw error;
  }
  context.audit.record({ actor: actor.username, action: 'knowledge.upload', target: document.id, ipAddress: requestIp(context, request), detail: `${name} (${data.length} bytes, ${document.chunkCount} passages)` });
  return reply.status(201).send({ document: context.knowledge.list().find((d) => d.id === document.id) });
});
```

(`KnowledgeStoreError` est déjà traduit en HTTP par le gestionnaire d'erreurs global — vérifier dans `http/errors.ts` que `statusCode` est honoré ; sinon envelopper comme `ExtractError`.) Les autres routes : `POST /:id/extract` (lit `sourceOf`, `knowledgeFiles.read`, `extractor.extract`, `upsert({ id, content, pageBreaks, pageUnit, source })`, 404 si pas de source ou fichier manquant), `GET /:id/source` (règle `inline` = `mime === 'application/pdf'`, `attachment` sinon, `nosniff`, `cache-control: private, max-age=31536000, immutable`, `knowledgeFiles.stream`), `PATCH /:id` (`PatchKnowledgeRequest` ; `patch()` puis `setReach()` si `reach` ; audit `knowledge.update` avec le détail des champs), `DELETE /:id` (lire `sourceOf` **avant** `delete`, puis `knowledgeFiles.remove`). `POST /api/knowledge` : passer `reach` au store (déjà accepté par `upsert`). Toutes les réponses de document renvoient le `KnowledgeDocumentMeta` complet (`list()` filtré par id, ou une méthode `meta(id)` ajoutée au store — préférer `meta(id)`).

- [ ] **Step 3 : Vert** — `pnpm --filter @metaclaude/api test:run -- routes/knowledge` (le harness démarre un vrai serveur ; le worker a besoin de `dist` : lancer `pnpm --filter @metaclaude/api build` avant, et faire lire au harness `InProcessExtractor` quand `dist` manque ? **Non** — un test qui change d'implémentation selon l'environnement ment. Le harness démarre depuis `src` sous vitest : `context.ts` choisit `WorkerExtractor` ; sous vitest `new URL('./worker.js', import.meta.url)` pointe un `.ts` que Node ne charge pas → l'upload échoue. Résolution : `context.ts` prend `extractor` en option injectable ; `bootTestServer` injecte `InProcessExtractor` **et le nomme** dans son en-tête ; le worker est prouvé par `check:e2e` (Task 14) et `worker-extractor.test.ts` sur `dist`.)

- [ ] **Step 4 : Commit** — `git commit -am "knowledge routes: upload, re-extract, source download, patch"`.

---

### Task 10 : Provenance dans le prompt, la genèse et l'outil MCP

**Files:**
- Modify: `apps/api/src/kernel/context.ts:124-160`
- Modify: `apps/api/src/services/mcp-gateway.ts:278-295` et le texte de `search_notes` (~383)
- Modify: `apps/api/src/routes/learning.ts:756` (genèse : `consultedFor` renvoie déjà les champs)
- Test: `apps/api/src/kernel/context.test.ts`, `apps/api/src/services/mcp-gateway.test.ts`

- [ ] **Step 1 : Tests rouges**

```ts
it('cites a passage with its page and lines, and counts the citation in the budget', () => {
  const hit = { chunkId: 'c', documentId: 'd', documentTitle: 'Bail', sourceName: 'bail.pdf', workspaceId: null, heading: 'Résiliation', text: 'Trois mois.', score: 1, pageUnit: 'page' as const, pageStart: 2, pageEnd: 2, lineStart: 40, lineEnd: 52 };
  const { text } = selectKnowledgeContext([hit]);
  expect(text).toContain('- **Bail › Résiliation** (page 2, lines 40–52)');
  expect(text).toContain('document title, section, page and lines as given');
});
```

MCP : `searchNotes` renvoie `{ title, heading, location: 'page 2, lines 40–52', text }`.

- [ ] **Step 2 : Implémentation** — dans `selectKnowledgeContext` : `const where = describeLocation(entry); const source = [entry.documentTitle, entry.heading].filter(Boolean).join(' › '); const rendered = `- **${source || 'Document'}**${where ? ` (${where})` : ''}\n  …`` ; `KNOWLEDGE_HEADER` : « cite them when you rely on them (document title, section, page and lines as given) ». Gateway : `location: describeLocation(hit)` et la description de l'outil précise que chaque résultat porte sa localisation.

- [ ] **Step 3 : Vert, sabotage, commit** — `git commit -am "knowledge: passages are cited with their page and lines"`.

---

### Task 11 : Le doctor sait quand un fichier manque

**Files:**
- Modify: `apps/api/src/services/doctor.ts` (après la vérification `retrieval`)
- Test: `apps/api/src/services/doctor.test.ts`

- [ ] **Step 1 : Tests rouges** — un document avec `source_sha256` dont le fichier n'existe pas → check `knowledge-files` en `warn`, `summary` nommant `1 document`, `detail` listant le titre ; sans document fichier → `ok`. Et `pdf-engine` : `ok` nommant la version de poppler quand `popplerVersion()` la rend, `warn` « PDFs are read by the fallback engine: multi-column pages will come out interleaved. Install poppler-utils. » sinon — le doctor reçoit `popplerVersion` injectable pour que les deux branches se testent.
- [ ] **Step 2 : Implémentation** — `db.prepare('SELECT id, title, source_sha256, source_mime FROM documents WHERE source_sha256 IS NOT NULL').all()`, `knowledgeFiles.exists()`, borner le détail à dix titres ; le doctor reçoit `knowledgeFiles` et `popplerVersion` par ses deps (suivre la façon dont il reçoit `db`).
- [ ] **Step 3 : Vert, commit** — `git commit -am "doctor: a knowledge document whose file is gone is reported"`.

---

### Task 12 : L'écran de la bibliothèque

**Files:**
- Modify: `apps/web/src/lib/api.ts:894-907`
- Create: `apps/web/src/components/memory/KnowledgeUploadZone.tsx`, `KnowledgeViewer.tsx`, `KnowledgeSourceBadge.tsx`, `apps/web/src/lib/knowledge.ts`
- Modify: `apps/web/src/components/memory/KnowledgeSection.tsx`
- Modify: `apps/web/src/locales/fr.ts`
- Test: `KnowledgeSection.test.tsx`, `KnowledgeUploadZone.test.tsx`, `KnowledgeViewer.test.tsx`, `apps/web/src/lib/knowledge.test.ts`

**Interfaces:**
- `api.knowledge.upload(body: UploadKnowledgeRequest)`, `.patch(id, body: PatchKnowledgeRequest)`, `.extract(id)`, `.sourceUrl(id): string` (`/api/knowledge/${id}/source`).
- `lib/knowledge.ts` : `locationWords(t)` → `LocationWords` français via `t('page')…` ; `formatLocation(hit, t)` ; `matchesTitle(doc, query)` (insensible à la casse et aux accents via `normalize('NFD').replace(/\p{M}/gu, '')`) ; `FORMAT_LABEL: Record<mime, 'PDF' | 'DOCX' | …>` ; `KNOWLEDGE_ACCEPT` (MIME + extensions).
- `KnowledgeUploadZone({ reach, onUploaded })` : zone de dépôt + `<input type=file multiple accept>` + liste d'avancement `{ name, status: 'uploading' | 'done' | 'error', detail }` ; envois **séquentiels** via `api.knowledge.upload` ; refus client (taille, type) affiché sans appel réseau ; `onUploaded()` après chaque succès.
- `KnowledgeViewer({ documentId, line, open, onOpenChange })` : `Modal size="xl"`, charge `api.knowledge.get`, rend `<ol>` de lignes numérotées (`<li id={`line-${n}`}>`), surligne `line` et `scrollIntoView` dans un effet, boutons *Download the original* (`<a href={sourceUrl} download>`), *Re-extract* (mutation + toast), *Close*.
- `KnowledgeSourceBadge({ source })` → `<Badge tone="neutral">PDF</Badge>` ou *Pasted*.

- [ ] **Step 1 : Tests rouges** (extraits — un `it` par ligne)

Section : « filters the shelf by workspace from its own row » (`apiMock.knowledge.list` appelé avec `{ workspaceId: 'ws_a' }` après `pointerDown` + `click` sur *Alpha* dans le menu de portée) ; « finds a document by title, accents ignored » (`fireEvent.change` sur *Search titles* avec `resiliation` masque *Conventions* et garde *Bail — Résiliation*) ; « keeps the filter row visible when the search matches nothing » ; « wears the reach badge » (`Global`, `Alpha`, `2 workspaces`, `No workspace`) ; « pauses through PATCH, without resending the text » (`apiMock.knowledge.patch` appelé avec `('doc_1', { enabled: false })`, `get` **non** appelé) ; « saves a pasted document with the reach the picker shows » (`save` appelé avec `reach: { global: false, workspaceIds: ['ws_a'] }`) ; « opens the viewer for a file-backed document instead of the editor » ; « offers download and re-extract only for a file-backed document ».

Zone de dépôt : « uploads the dropped files one after another, with the reach it was given » (deux `File`, `upload` appelé deux fois, le second **après** la résolution du premier) ; « refuses a 25 MB file before any request and keeps the reason on screen » ; « keeps an API error on screen beside the file name » (`upload` rejette `new ApiError('This PDF has no text layer…')` → texte présent après `waitFor`).

Viewer : « numbers every line and brings the cited one into view » (`scrollIntoView` mocké sur `Element.prototype`, appelé sur `#line-40`) ; « re-extracts on demand and says how many passages came back ».

`lib/knowledge.test.ts` : `matchesTitle` (accents, casse, nom de fichier), `formatLocation` en français (`page 2, l. 40–52` ; `diapositives 2–3`).

- [ ] **Step 2 : Rouge**, **Step 3 : implémentation**

Points d'attention dans `KnowledgeSection.tsx` :

```tsx
const [scope, setScope] = useState<WorkspaceScope>(initialScope ?? 'all');   // initialScope vient de la page (?workspace=)
const [titleQuery, setTitleQuery] = useState('');
const listOptions = scope === 'global' ? { scope: 'global' as const } : scope !== 'all' ? { workspaceId: scope } : undefined;
const visible = documents.filter((doc) => matchesTitle(doc, titleQuery));
…
<div className={cn(FILTER_ROW, 'gap-2')}>
  <WorkspaceScopeFilter value={scope} onChange={setScope} workspaces={workspaces} />
  <Input value={titleQuery} onChange={(e) => setTitleQuery(e.target.value)} placeholder={t('Search titles')} aria-label={t('Search titles')} className="w-56" />
  <span className="text-caption text-subtle">{plural(visible.length, '{n} document', '{n} documents')}{visible.length !== documents.length ? ` · ${t('{n} hidden', { n: String(documents.length - visible.length) })}` : ''}</span>
</div>
<KnowledgeUploadZone reach={reachForScope(scope)} onUploaded={refresh} />
```

`reachForScope(scope)` : `scope` est un id → `{ global: false, workspaceIds: [scope] }`, sinon `{ global: true, workspaceIds: [] }`. La carte : `<ReachBadge global={doc.isGlobal} workspaceIds={doc.workspaceIds} workspaces={workspaces} />`, `<KnowledgeSourceBadge source={doc.source} />`, `n pages` quand `pageCount`, menu ⋮ (`Menu` + `MenuItem`, `aria-label={t('More actions for “{name}”', …)}`) : *View* / *Edit* selon `doc.source`, *Download the original*, *Re-extract*, *Delete*. Le formulaire : `ReachPicker value={editing.reach} onChange=…` à la place du `Select` ; `Textarea` seulement si `!editing.source`. `toggle` → `api.knowledge.patch(doc.id, { enabled: !doc.enabled })`. La répétition : `formatLocation(hit, t)` après le titre.

`fr.ts` : chaque nouvelle chaîne (`Search titles`, `{n} hidden`, `Drop files here, or`, `Choose files`, `Uploading…`, `{n} passages indexed`, `Download the original`, `Re-extract`, `View`, `More actions for “{name}”`, `Pasted`, `page`, `pages`, `slide`, `slides`, `sheet`, `sheets`, `l.`, `No workspace`, `This file is larger than {n} MB.`, `This type is not accepted.`, …) — puis `node deploy/ratchets.mjs --list untranslatedStrings` doit rendre 0.

- [ ] **Step 4 : Vert** — `pnpm --filter @metaclaude/web test:run -- memory knowledge` ; `pnpm --filter @metaclaude/web typecheck`.

- [ ] **Step 5 : Commit** — `git commit -am "knowledge screen: drop files, reach picker, title search, viewer with lines"`.

---

### Task 13 : Liens de provenance et paramètres d'URL

**Files:**
- Modify: `apps/web/src/pages/MemoryPage.tsx:293, 1358` ; `apps/web/src/components/transcript/RunGenesis.tsx:197-213`
- Test: `apps/web/src/pages/MemoryPage.test.tsx` (existant, sinon créer), `RunGenesis.test.tsx`

- [ ] **Step 1 : Tests rouges** — « opens on the workspace the URL names » (`/memory?workspace=ws_a` → `memory.list` appelé avec `workspaceId: 'ws_a'`) ; « opens the viewer on the cited line from ?document=&line= » ; « tells the operator when the linked document no longer exists » (get → 404 → toast) ; genèse : « links each consulted passage to its lines » (`href` = `/memory?document=d&line=40`, texte `Bail › Résiliation · page 2, l. 40–52`), « says when a passage was replaced since ».

- [ ] **Step 2 : Implémentation** — `useSearchParams()` de `react-router-dom` dans `MemoryPage` ; `scope` initialisé depuis `workspace` ; `document`/`line` passés à `KnowledgeSection` (`initialScope`, `openDocument: { id, line } | null`) qui ouvre `KnowledgeViewer` ; `routes.memory` gagne une surcharge `routes.memoryDocument(id, line?)` dans `packages/shared/src/routes.ts` (+ test dans `routes.test.ts`). `RunGenesis` : `<Link to={routes.memoryDocument(doc.documentId, doc.lineStart ?? undefined)}>` avec `formatLocation`, et `doc.replaced ? <Badge tone="warning">{t('Replaced since')}</Badge>` .

- [ ] **Step 3 : Vert, commit** — `git commit -am "provenance links: the genesis strip opens the cited lines, the Memory page reads its URL"`.

---

### Task 14 : Banc, image, vérifications vivantes, docs, changelog, version

**Files:**
- Modify: `apps/api/scripts/eval-retrieval.mjs`, `docs/LEARNING.md:660-690`, `docs/guide/04-memory-and-learning.md:128-175`, `docs/ARCHITECTURE.md:450`, `docker/Dockerfile:82-86`, `apps/api/scripts/e2e.mjs:518-540`, `apps/api/scripts/shots.mjs`, `CHANGELOG.md`, `deploy/ratchets.json` (via `--update`)

- [ ] **Step 1 : `eval-retrieval.mjs --rerank <modèle>`** — option qui charge `AutoTokenizer`/`AutoModelForSequenceClassification` (avec `env.allowRemoteModels = true` **dans le banc seulement**, jamais dans l'API) et re-classe les 24 premiers candidats ; imprime les mêmes rapports que sans, plus la latence médiane et les distributions de logits pertinents/non pertinents. Reprendre `rerank-eval.mjs` du scratchpad. Vérifier en le lançant sans le modèle bge-m3 : il refuse (« the bench would measure the lexical arm alone »), comme aujourd'hui.

- [ ] **Step 2 : Docs** — `LEARNING.md` : remplacer le paragraphe « arithmétiquement incapable » par le tableau de la spec § 9 (trois configurations, latences, RSS, distributions), en gardant la phrase sur le hachage comme cas historique ; ajouter une section *Files* (extracteurs, worker, provenance, page map). Guide 04 : « paste the text » devient « drop a file or paste text », liste des formats, ce que la provenance affiche, où télécharger l'original, la ré-extraction, le filtre de la section. `ARCHITECTURE.md` : le module `extract/`, le worker, `knowledge/` sous `dataDir` — et vérifier que `deploy/check.sh` (section « guide documents a setting ») ne cite rien qui n'existe pas.

- [ ] **Step 3 : Dockerfile, check.sh, CI** — après l'élagage d'onnxruntime :

```dockerfile
# pdfjs-dist ships two builds and their source maps; only `legacy/build` runs
# here. exceljs ships browser bundles under dist/ beside the lib/ it runs from.
RUN rm -rf node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/build \
           node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/*.map \
           node_modules/.pnpm/exceljs@*/node_modules/exceljs/dist
```

et dans l'étape d'exécution (celle qui installe tini, avant `USER metaclaude`) :

```dockerfile
# poppler's pdftotext reads a PDF's pages in reading order — the one engine
# measured to keep a two-column page's paragraphs whole (docs/LEARNING.md,
# Files). 26 MB. Without it the API falls back to pdfjs, names the fallback
# on every document it reads, and the doctor warns.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*
```

`deploy/check.sh` : une assertion « the image installs poppler-utils » (grep du Dockerfile) à côté de celles sur tini, et une « the image prunes what pdfjs-dist and exceljs do not run » ; `.github/workflows/ci.yml`, job `live` : `sudo apt-get install -y poppler-utils` avant `check:e2e` (déjà présent sur les runners Ubuntu, l'étape est là pour que le jour où il ne l'est plus, le test le dise). Puis `docker build -f docker/Dockerfile .` localement (la pile iso-prod de la mémoire) et, dans le conteneur : `pdftotext -v`, `node -e "import('pdfjs-dist/legacy/build/pdf.mjs').then(()=>console.log('ok'))"`, et un upload réel de `twocol.pdf` par l'API dont le document doit porter `extractor: pdf@poppler-22.12.0` — c'est le seul endroit où le worker et poppler s'exécutent sur l'image qui part en prod.

- [ ] **Step 4 : `check:e2e`** — dans la section connaissance : upload de `src/learning/extract/fixtures/bail.docx` (lu et base64 par le script), `results.check('a dropped docx is extracted, sectioned and located', status 201 && document.source.extractor === 'docx@1')`, recherche « préavis » → `results[0].lineStart > 0` et `heading === 'Résiliation par le locataire'`, `GET …/source` → 200 avec `content-disposition` `attachment`, `POST …/extract` → 200 ; puis upload de `twocol.pdf` et `results.check('a two-column PDF is read by poppler, articles in order', extractor commence par 'pdf@poppler-' && la recherche « dépôt de garantie » rend un passage de la page 1 contenant « deux mois »)`. Ces vérifications tournent hors `METACLAUDE_E2E_EXPECT_SEMANTIC` (la partie lexicale suffit) — c'est là que le **worker** et **poppler** sont prouvés sur CI.

- [ ] **Step 5 : `shots.mjs`** — semer un document depuis `bail.docx` et un `assurance.pdf` (portée : un workspace et deux workspaces), pour que la capture montre les badges de format et de portée. Lancer le banc une fois, regarder la carte et la rangée de filtres sur le téléphone : une rangée qui déborde ou un badge qui s'empile se corrige **avant** le changelog.

- [ ] **Step 6 : CHANGELOG dans `[Unreleased]`** — sous `### Added` : « **Drop files into the knowledge library.** … » (formats, portée multi-workspaces, provenance page/lignes, visualiseur, téléchargement, ré-extraction, filtre et recherche de la section) ; sous `### Changed` : le prédicat de portée, `PATCH`, la genèse qui lie les lignes, `?workspace=` enfin lu ; une entrée « **No reranker, and now the numbers say why under bge-m3 too** » avec le tableau court. Sous `### Fixed` : le lien de notification vers la page Mémoire qui ignorait son paramètre.

- [ ] **Step 7 : Tout vérifier** — `pnpm verify` (typecheck, tests, build, ratchets) ; `node deploy/ratchets.mjs --update` n'a le droit que de faire baisser des nombres ; `./deploy/check.sh` avec shellcheck sur le PATH ; `pnpm --filter @metaclaude/api check:e2e` en local ; `pnpm --filter @metaclaude/api check:browser` si un composant nouveau touche une page capturée (oui : Mémoire). Puis `node deploy/bump.mjs minor` (sans pipe), commit, `git tag` posé par la CI après push.

- [ ] **Step 8 : Commit final** — `git commit -am "v0.83.0 — la bibliothèque lit vos fichiers, les partage entre workspaces, et cite la page"` (le message est écrit par `bump.mjs` ; l'adapter au ton des précédents).

---

## Auto-revue du plan

**Couverture de la spec** — § 4 modèle : Task 2 (+ recréation de `document_usages`, Task 4) · § 5 extraction : Tasks 5-7 · § 6 provenance : Tasks 3, 4, 10, 12, 13 · § 7 portée : Tasks 1, 2, 4, 9, 12 · § 8 API : Task 9 (doctor Task 11) · § 9 réglages et reranker : Task 14 (banc + docs) · § 10 écran : Task 12 · § 11 cas limites : doublon (4, 9), nom hostile (9 via `safeFileName`), MIME vide (7), PDF chiffré/scan/corrompu (6), zip bomb (6 `filter` + worker 7), texte trop grand (7), workspace supprimé (4), pause sans renvoi (9, 12), titre seul (4), ré-extraction identique (4 hash) ou différente (4 `LEFT JOIN`), base vide (2), réindexation (4 : colonnes intactes), passages anciens sans lignes (`describeLocation` vide, 1), deep link mort (13), fichier manquant (9 : 404 ; 11 : doctor), Windows (8 `resolveInside`, 7 `new URL`) · § 12 tests : chaque tâche · § 13 hors périmètre : rien à faire.

**Types** — `ExtractedText`/`ExtractInput` (Task 5) utilisés tels quels en 6, 7, 9 ; `KnowledgeSearchHit = KnowledgeLocation & {…}` (Task 1) est ce que `search` renvoie (Task 4) et ce que `selectKnowledgeContext` lit (Task 10) ; `StoredSource` (Task 4) est ce que `sourceOf` rend et que la route `extract` consomme (Task 9) ; `Extractor` (Task 7) est le type de `context.extractor` (Task 8) injecté par le harness (Task 9).

**Risque nommé** — la migration 29 recrée `document_usages` ; elle n'est publiée nulle part avant la fin de ce lot, mais une fois poussée elle ne s'édite plus (migrations append-only). Tout ajout de colonne découvert en cours de route passe par une migration 30.

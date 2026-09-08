# Bibliothèque de connaissance : dépôt de fichiers, portée multi-workspaces, provenance

Date : 2026-09-08 · Statut : validé en séance, à implémenter

## 1. L'écart

La Bibliothèque de connaissance (section basse de la page Mémoire) accepte
aujourd'hui du **texte collé** dans un formulaire, rattaché à **un** workspace
ou au global (`documents.workspace_id`, NULL = global). Le besoin réel :

- **déposer des fichiers** tels quels — txt, md, csv, html, pdf, docx, xlsx,
  pptx — et que le système en extraie le texte lui-même ;
- les rendre visibles de **tous, un ou plusieurs** workspaces ;
- que chaque passage cité en session dise **d'où il vient** : document, page,
  lignes ;
- filtrer la section par workspace et chercher un document par titre.

Le pipeline de recherche (découpage en passages, index dense + BM25, fusion,
gardes de pertinence mesurées, budget d'injection) ne change pas. Ce lot
change ce qui entre dans ce pipeline et ce qui en ressort.

## 2. Décisions prises (validées)

| Question | Décision |
| --- | --- |
| Conserver le fichier d'origine | **Oui** : téléchargement et ré-extraction quand un extracteur s'améliore |
| Emplacement de la bibliothèque | Reste sur la page Mémoire ; la section gagne son propre filtre workspace et une recherche par titre |
| Notes de l'orateur (pptx) | **Incluses** dans le texte de chaque diapositive |
| Reranker | **Abandonné**, sur mesure (§ 9) ; le banc garde l'instrument et la documentation garde les chiffres |
| PDF à plusieurs colonnes | **Poppler `pdftotext`** dans l'image, en sous-processus ; pdfjs reste le repli nommé quand le binaire manque (§ 5, mesures § 3) |
| Prérequis côté production | **Aucun** : la prod est à 0.82.0 (la version de `main`), Node 22.23.2, limite mémoire 2 861 Mo, disque à 38 % ; le lot voyage dans l'image (+26 Mo) |
| Provenance | Document › section · page · lignes, dans le prompt, la genèse du run, la répétition, l'outil MCP |
| Portée | Le modèle `is_global` + table de liaison des skills (migration 26), réutilisé à l'identique |
| Doublons | Un fichier déjà déposé (même sha256) répond 409 en nommant le document existant |
| Contenu d'un document issu d'un fichier | **Lecture seule** : le texte est ce que l'extracteur a produit, la provenance page/ligne en dépend ; on ré-extrait, on n'édite pas |

## 3. Ce qui a été mesuré avant d'écrire ceci

Toutes les hypothèses ci-dessous ont été vérifiées par script (scratchpad,
Node 24, Windows) ; les chiffres serveur sont extrapolés ×3, le ratio mesuré
par `knowledge-ingest.test.ts` pour bge-m3.

**Extracteurs** (fixtures réelles générées avec `docx`, `exceljs`,
`pptxgenjs`, `pdf-lib`) :

| Format | Bibliothèque | Licence | Fixture | Extraction | Notes |
| --- | --- | --- | --- | --- | --- |
| docx | mammoth 1.12 → HTML → Markdown maison | BSD-2 | titres H1-H3, gras, tableau, liste | 22 ms | `convertToMarkdown` perd les tableaux et échappe les points : passer par HTML |
| xlsx | exceljs 4.4 | MIT | 2 feuilles, dates, formules avec résultat | 14 ms ; 40 000 lignes : 391 ms | dates résolues, formules → résultat en cache, lignes vides sautées |
| pptx | fflate 0.8 + lecture OOXML maison | MIT | 3 diapositives, tableau, notes | 1 ms | ordre des diapositives via `presentation.xml` + rels ; titre via placeholder `title`/`ctrTitle` ; notes via les rels de la diapositive |
| pdf | **poppler `pdftotext` 22.12** (paquet `poppler-utils` de bookworm, +26 Mo mesurés dans l'image), repli pdfjs-dist 6.3 (`legacy`) | GPL-2 (binaire appelé, non lié) / Apache-2.0 | 3 pages ; 300 pages : 1,25 s dans le conteneur | — | pages séparées par `\f` ; scan → sortie vide ; chiffré → exit 1 « Incorrect password » ; corrompu → exit 1 « Couldn't read xref table » ; lit l'entrée standard (`- -`) ; pdfjs exige `standardFontDataUrl` et Node ≥ 22.13 (image : 22.23.2 ✓) |

**PDF à plusieurs colonnes** — mesuré sur un PDF synthétique (deux colonnes
dessinées ligne à ligne), deux articles réels à deux colonnes (arXiv
1512.03385, ACL 2020.acl-main.1) et un document LaTeX `twocolumn` français
composé pour la fixture :

| Moteur | Synthétique | Articles réels | LaTeX deux colonnes |
| --- | --- | --- | --- |
| pdfjs, lignes groupées par ordonnée | colonnes **entremêlées** ligne à ligne | entremêlées | entremêlées |
| XY-cut maison sur les items pdfjs | ordre correct, titre collé | **échec** (aucune coupe de colonne : un pied de page centré chevauche la gouttière) | — |
| xpdf 4.00 (binaire de ce poste, absent de Debian) | correct | correct | — |
| **poppler `pdftotext` (défaut)** | entremêlées | **colonnes entières**, ordre des blocs parfois approximatif, césures recollées | **correct**, articles 1 à 6 dans l'ordre |
| PyMuPDF `sort=True` | entremêlées | — | — |

Un passage produit par pdfjs mélange deux colonnes phrase par phrase : rien
de retrouvable. Poppler garde chaque paragraphe entier ; c'est ce qui compte
pour la recherche et pour la citation. Il n'existe pas de bibliothèque
JavaScript pure qui fasse cette analyse de mise en page (pdf2md le dit
lui-même), et l'écrire est un projet à part. Poppler est donc le moteur, en
sous-processus (isolation gratuite, délai et `maxBuffer` de `execFile`) ;
pdfjs reste le **repli nommé** quand le binaire manque (poste de
développement sans poppler) : `extractor` vaut `pdf@poppler-22.12` ou
`pdf@pdfjs`, le doctor avertit quand poppler manque, et la ré-extraction
permet de reprendre un document extrait sous le repli. Les ligatures
(`ﬁ`) sont décodées par les deux moteurs sur une police portant sa table
Unicode ; le repli applique `NFKC` pour les polices qui ne l'ont pas.
| html | convertisseur maison (regex sur blocs) | — | page « sauvage » avec script, nav, entités | < 1 ms | scripts/styles/nav/footer retirés ; entités numériques et nommées courantes décodées |

Chaque bibliothèque refuse proprement une entrée corrompue (exception nommée,
pas de blocage). Aucune n'a de `postinstall` : rien à ajouter à
`onlyBuiltDependencies`. Empreinte disque : pdfjs 35 Mo (dont 12 Mo de
`build/` non-legacy et des `.map`), exceljs 23 Mo (dont 21 Mo de `dist/`
navigateur) — élagués dans l'image comme `onnxruntime-node`.

**Blocage de la boucle d'événements** : un PDF de 300 pages coûte 139 ms de
pire pause, un xlsx de 40 000 lignes 155 ms, ici ; ×3 sur le serveur. Une
extraction s'exécute donc dans un **worker thread** avec plafond mémoire et
délai — non pour la latence nominale, mais parce qu'un fichier hostile ou
énorme (zip bomb dans un docx, PDF de 2 000 pages) ne doit pas pouvoir geler
l'API qui supervise les runs.

**Worker et mémoire** : dans un worker plafonné à 512 Mo de tas, pdfjs lit
300 pages à 64 Mo de pic, 1 000 pages (4,7 Mo de texte) à 139 Mo, 3 000 pages
(14 Mo de texte, bien au-delà du plafond de 512 Kio d'un document) à 290 Mo
en 5,7 s. Sous un plafond de 64 Mo le même fichier est tué et le parent reçoit
un événement `error` « Worker terminated due to reaching memory limit », que
le `WorkerExtractor` traduit en refus nommé. Le plafond de 512 Mo laisse donc
un facteur supérieur à 10 sur le plus gros document acceptable.

**Typage** : les quatre bibliothèques typecheck sous NodeNext avec le `tsc` du
dépôt et `@types/node` 22 ; deux écarts trouvés et corrigés dans le plan
(pdfjs 6 n'a plus `isEvalSupported` ; exceljs veut un `ArrayBuffer`).

**docx d'autres producteurs** : mammoth détecte les titres quand l'id de
style est `Titre1` et le nom canonique `Heading 1` — la forme qu'écrit un Word
français, dont l'interface traduit le nom mais dont le XML garde le nom
anglais — et même sans `styles.xml` (il lit alors l'id de style du
paragraphe). Non testé, faute d'un tel fichier : un docx dont le nom de style
lui-même serait localisé (mon premier essai de cette variante n'avait pas
pris, la fixture écrivant `Heading 1` avec majuscule) ; un vrai docx issu du
Word de l'opérateur est à passer dans la fixture avant de clore le lot.
LibreOffice n'est pas installé ici ; son export (`Heading1`) est la forme de
la fixture.

**Offsets du chunker** (hypothèse : le texte d'un passage se retrouve mot pour
mot dans le contenu, hors préfixe de chevauchement) : sur 499 passages (corpus
d'évaluation, CLAUDE.md, LEARNING.md, un docx de 2 000 paragraphes, un mur de
texte sans ponctuation) : 466 verbatim, 33 re-joints par des espaces (les
paragraphes > `CHUNK_MAX` découpés en phrases), **0 perdu**. Les offsets de
début/fin sont donc dérivables au moment du découpage, pas par recherche a
posteriori.

**Schéma** : `ALTER TABLE ADD COLUMN` sur `document_chunks` (contenu externe
de `document_chunks_fts`) conserve les triggers, le `MATCH` et l'`integrity-check` ;
la suppression d'un workspace efface ses liaisons par cascade et laisse le
document ; le prédicat `is_global = 1 OR id IN (…)` répond exactement
global ∪ attachés.

**Serveur de production** (lu en direct) : 2 vCPU, 3,8 Go de RAM, conteneur
API à 1,44 Gio sur une limite de 2,79 Gio, 1,8 Go disponibles sur l'hôte.

## 4. Modèle de données

Migration append-only (`MIGRATIONS`, version suivante), `knowledge_files` :

```sql
ALTER TABLE documents ADD COLUMN is_global     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN source_name   TEXT;      -- nom déposé, nettoyé (safeFileName)
ALTER TABLE documents ADD COLUMN source_mime   TEXT;
ALTER TABLE documents ADD COLUMN source_bytes  INTEGER;
ALTER TABLE documents ADD COLUMN source_sha256 TEXT;      -- nomme le fichier sur disque
ALTER TABLE documents ADD COLUMN extractor     TEXT;      -- 'pdf@1', 'docx@1'… ce qui a produit content
CREATE UNIQUE INDEX idx_documents_source ON documents(source_sha256) WHERE source_sha256 IS NOT NULL;

CREATE TABLE document_workspaces (
  document_id  TEXT NOT NULL REFERENCES documents(id)  ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  PRIMARY KEY (document_id, workspace_id)
);
CREATE INDEX idx_document_workspaces_workspace ON document_workspaces(workspace_id);

ALTER TABLE document_chunks ADD COLUMN page_start INTEGER;  -- NULL : format sans pages
ALTER TABLE document_chunks ADD COLUMN page_end   INTEGER;
ALTER TABLE document_chunks ADD COLUMN line_start INTEGER;  -- 1-based, dans documents.content
ALTER TABLE document_chunks ADD COLUMN line_end   INTEGER;

UPDATE documents SET is_global = 1 WHERE workspace_id IS NULL;
INSERT INTO document_workspaces (document_id, workspace_id)
  SELECT id, workspace_id FROM documents WHERE workspace_id IS NOT NULL;

-- Ce qu'un run a vu doit survivre au remplacement du passage (ré-extraction) :
-- l'usage nomme désormais le document, garde l'id du passage sans clé
-- étrangère, et consultedFor rend « remplacé » quand le passage a disparu.
-- SQLite n'ajoute pas de clé étrangère à une table existante : recréation.
CREATE TABLE document_usages_v2 (
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_id    TEXT NOT NULL,
  score       REAL NOT NULL,
  PRIMARY KEY (run_id, chunk_id)
);
INSERT INTO document_usages_v2 SELECT u.run_id, c.document_id, u.chunk_id, u.score
  FROM document_usages u JOIN document_chunks c ON c.id = u.chunk_id;
DROP TABLE document_usages;
ALTER TABLE document_usages_v2 RENAME TO document_usages;
```

La reprise conserve l'invariant de la migration 26 : ce que chaque workspace
voit est identique des deux côtés (test qui seed l'ancienne forme et compare
au prédicat ancien). `workspace_id` reste comme trace du premier rattachement,
rien ne résout plus avec lui. Les passages existants gardent `line_*` NULL
jusqu'à la prochaine réécriture du document : la reprise **ne** re-découpe
pas (les vecteurs seraient à refaire) ; un document sans lignes est cité sans
lignes. `documents.embedding_model`, `chunk_count`, `content_hash` : inchangés.

Fichiers : `<dataDir>/knowledge/<sha256>.<ext>` (`config.knowledgeDir`, créé
au boot comme `uploadsDir`), écrits sous `resolveInside`. Un document par
empreinte de fichier. Le volume `metaclaude-data` est dans la sauvegarde
quotidienne (vérifié dans `deploy/bin/metaclaude-backup`).

## 5. Extraction

Module `apps/api/src/learning/extract/` :

- `index.ts` — `extractText(input: { name, mime, data: Buffer }): ExtractedText`
  avec `ExtractedText = { text: string; pageBreaks: number[]; pageUnit: 'page' | 'slide' | 'sheet' | null; extractor: string }`.
  `pageBreaks[i]` est l'offset (dans `text`, déjà normalisé : `\r\n`→`\n`,
  trim, ≤ 2 sauts consécutifs) où commence la page `i + 2`. Dispatch par MIME
  puis extension, sur la liste fermée `KNOWLEDGE_MIME_TYPES` de
  `packages/shared` (le pendant de `ATTACHMENT_MIME_TYPES`).
- `html.ts` — HTML → Markdown : `h1..h6` → `#`, `p/div/section…` → paragraphes,
  `ul/ol/li` → `- `, `table` → une ligne `| a | b |` **par ligne, chaque ligne
  son propre paragraphe** (une ligne de tableau n'est jamais coupée en deux par
  le découpage), `strong/em`, `br`, `a` → `texte (url)`, `script/style/nav/
  footer/head/svg/template` supprimés, entités décodées (numériques + table des
  nommées courantes). Sert aux `.html` déposés et au docx.
- `docx.ts` — mammoth `convertToHtml` puis `html.ts`. Les styles Titre n
  deviennent des `#`, donc des sections citables.
- `xlsx.ts` — exceljs. Une section par feuille dont le titre porte **la ligne
  d'en-tête** : `## Loyers 2026 — Mois | Échéance | Loyer | Charges | Total`,
  puis une ligne `| … |` par ligne non vide, chacune un paragraphe. Un passage
  de lignes est ainsi toujours embarqué et cité avec ses colonnes (le titre de
  section est préfixé à chaque passage par `chunkEmbeddingText`). Dates en
  ISO, formules → résultat, richText aplati, erreurs → leur code. `pageUnit:
  'sheet'`, une rupture par feuille.
- `csv.ts` — même sortie qu'une feuille unique (séparateur détecté `,` / `;` /
  tab, guillemets gérés). Un `.csv` déposé cesse d'être un bloc de texte brut.
- `pptx.ts` — fflate `unzipSync` avec `filter` bornant la taille déclarée de
  chaque entrée (64 Mio) ; ordre via `ppt/presentation.xml` + rels ; par
  diapositive `## Diapositive n — Titre` (placeholder `title`/`ctrTitle`, sinon
  sans titre), paragraphes `<a:p>` des formes, tableaux `<a:tbl>` en lignes
  `| … |`, puis `Notes : …` depuis `notesSlideN.xml`. `pageUnit: 'slide'`.
- `pdf.ts` — **poppler d'abord** : `spawn('pdftotext', ['-enc', 'UTF-8',
  '-', '-'])`, les octets sur l'entrée standard, délai de 60 s et sortie
  plafonnée à 8 Mio à la main (dépassée → `too-large`, le plafond de 512 Kio
  est de toute façon derrière) ; pages découpées sur `\f` puis `joinPages` ; exit ≠ 0 →
  `encrypted` si l'erreur standard dit « Incorrect password », `corrupt`
  sinon ; sortie vide → `no-text` (« un scan demande une OCR, non prise en
  charge ») ; `ENOENT` (binaire absent) → **repli pdfjs** `legacy/build/pdf.mjs`
  (`standardFontDataUrl` via `createRequire`, `disableFontFace`), lignes
  groupées par ordonnée (tolérance 2 pt), `NFKC`, `loadingTask` détruit dans
  un `finally`, `PasswordException` → `encrypted`. Aucun titre inventé
  (`heading` vide, `pageUnit: 'page'`). `extractor` = `pdf@poppler-<version>`
  (lue une fois par `pdftotext -v`) ou `pdf@pdfjs`. Le moteur est choisi par
  `PdfEngine` injectable, pour que les tests couvrent les deux branches et
  que le repli ne soit jamais un choix silencieux.
- `text.ts` — txt/md/json : tels quels (json indenté à 2 si compact, pour que
  le découpage ait des lignes).
- `worker.ts` — entrée `worker_threads` : reçoit `{ name, mime, data }`, répond
  `ExtractedText` ou une erreur sérialisée `{ code, message }`. Le parent
  (`WorkerExtractor`) crée un worker par extraction avec `resourceLimits:
  { maxOldGenerationSizeMb: 512 }` et un délai de 60 s ; dépassement ou mort
  du worker → `KnowledgeStoreError(422, …)` nommant la cause. Les tests
  unitaires couvrent les extracteurs en processus ; le chemin worker est
  couvert par `check:e2e` (le job CI `live` exécute la vraie `dist`), et par
  un test vitest qui s'exécute contre `dist/` et **dit** ce qui manque s'il
  saute — jamais un vert silencieux.

Erreurs, toutes nommées à l'opérateur : type refusé (415, en listant les types
acceptés), fichier vide (400), > 20 Mo (413), corrompu (400, avec la
bibliothèque qui a refusé), texte extrait vide (422), texte > 512 Kio après
extraction (413, en nommant le plafond et la taille obtenue), délai/mémoire
(422), doublon (409 + le document existant).

## 6. Provenance

**Découpage.** `chunkDocument` renvoie `{ seq, heading, text, start, end }` :
`start` est l'offset du premier morceau propre au passage (le préfixe `… ` de
chevauchement appartient au passage précédent), `end` la fin du dernier. Les
morceaux d'un paragraphe > `CHUNK_MAX` re-joints par des espaces sont
localisés par leur première et dernière phrase dans le paragraphe d'origine.
Un test tient l'**égalité stricte** de `heading`/`text` avec la sortie
actuelle sur le corpus d'évaluation et les fixtures (aucun vecteur ne change),
et vérifie `content.slice(start, end)` contre le texte pour les passages
verbatim.

**Stockage.** `KnowledgeStore.upsert` accepte `pageBreaks?` et `pageUnit?` ;
il calcule par passage `line_start/line_end` (1 + nombre de `\n` avant
`start`, idem `end`) et `page_start/page_end` par dichotomie dans `pageBreaks`.
Le store impose que le contenu reçu soit déjà sous forme normale quand une
carte de pages l'accompagne (sinon 500 explicite) : les offsets d'un
extracteur ne survivent pas à un `trim` fait après coup.

**Rendu, une seule fonction.** `packages/shared/src/knowledge.ts` :
`describeLocation({ pageUnit, pageStart, pageEnd, lineStart, lineEnd })` →
`{ page?: string; lines?: string }`, et le type `KnowledgeSearchHit` gagne
`pageUnit`, `pageStart`, `pageEnd`, `lineStart`, `lineEnd`, `sourceName`.
Consommateurs :

- le bloc injecté (`selectKnowledgeContext`) : `- **Bail › Résiliation**
  (page 2, lines 40–52)` et l'instruction devient « cite them when you rely on
  them (document title, section, page and lines as given) » ;
- la genèse du run (`consultedFor` + `RunGenesis.documents`) : même libellé,
  et chaque entrée est un lien vers `/memory?document=<id>&line=<n>` ;
- la répétition de recherche de la section ;
- l'outil MCP `search_notes` renvoie `page`, `lines`, `source` en plus.

Les libellés français passent par `t()` côté web ; le prompt reste en anglais.

**Visualiseur.** Un document issu d'un fichier s'ouvre dans un modal `xl` en
lecture seule : texte extrait numéroté ligne par ligne, une ligne cible
surlignée et amenée à l'écran, boutons *Télécharger l'original* et
*Ré-extraire*. Le formulaire d'édition d'un document collé garde son
`Textarea`. La page Mémoire lit `?document=&line=` — et lit enfin
`?workspace=` : `routes.memory(workspaceId)` est construit par `kernel.ts`
pour les notifications et **rien ne le lisait** (constaté en séance ; corrigé
dans ce lot car le lien de la genèse emprunte le même chemin).

## 7. Portée

- `packages/shared/src/api-contracts.ts` : `SaveKnowledgeRequest` gagne
  `reach: ExtensionReach`, optionnel : à la mise à jour, absent = inchangé
  (comme les skills) ; à la création, absent = dérivé de `workspaceId`
  (global si NULL, sinon ce seul workspace — le motif `attachOnCreate` du
  registre, qui garde valides le corpus d'évaluation, les bancs et
  `check:e2e`). Le formulaire et le dépôt envoient toujours `reach`. Nouveau
  `UploadKnowledgeRequest { name, mime, data (base64), reach, title? }` et
  `PatchKnowledgeRequest = patchSchema({ title, enabled, reach })` — jamais
  `.partial()` nu (ratchet `defaultingPartials`). `KnowledgeDocumentMeta` gagne
  `isGlobal`, `workspaceIds`, `source: { name, mime, bytes, extractor } | null`,
  `pageCount`.
- `KnowledgeStore` : `list({ workspaceId })` = global ∪ attachés ;
  `{ workspaceId: null }` = global seul ; sans option = tout, y compris les
  documents rattachés à rien. `candidateChunks` : même prédicat, une seule
  constante SQL partagée entre les deux (`REACH_PREDICATE`), pour que la liste
  et la recherche ne puissent pas diverger. `setReach(id, reach)` remplace
  l'ensemble, filtre les ids inconnus (le motif `registry.setReach`).
- Suppression d'un workspace : cascade sur les liaisons, le document reste
  (peut se retrouver « nulle part », état affiché comme tel par `ReachBadge`).
- Écran : `ReachPicker` dans le formulaire (global / cases à cocher, rien
  coché = nulle part), `ReachBadge` sur chaque carte à la place de `ScopeBadge`.
  Le dépôt préremplit la portée avec le filtre courant de la section (un
  workspace → ce workspace ; tout / global → global).
- Le workspace système (steward), le gateway MCP, le doctor : aucun code
  spécifique ; ils lisent par workspace et héritent du nouveau prédicat.

## 8. API

| Route | Corps / réponse |
| --- | --- |
| `POST /api/knowledge/upload` (bodyLimit 32 Mo, comme les pièces jointes) | `UploadKnowledgeRequest` → 201 `{ document }` ; 409 `{ document }` si l'empreinte existe |
| `POST /api/knowledge/:id/extract` | ré-extraction depuis le fichier conservé ; 404 sans fichier ; le hash décide s'il y a re-découpage ; met `extractor` à jour |
| `GET /api/knowledge/:id/source` | le fichier d'origine ; `content-disposition: attachment` sauf PDF (`inline`), `nosniff`, immutable (nommé par hash) — la règle des pièces jointes |
| `PATCH /api/knowledge/:id` | `PatchKnowledgeRequest` ; remplace le trio get-puis-save que la bascule *Pause* faisait jusqu'ici |
| `POST /api/knowledge` | inchangé + `reach` ; refuse `content` sur un document issu d'un fichier (409, « ré-extrayez plutôt ») |
| `GET /api/knowledge`, `/:id`, `/search`, `/reindex`, `DELETE /:id` | inchangés dans la forme ; les réponses portent les nouveaux champs ; `DELETE` efface aussi le fichier |

Audit : `knowledge.upload`, `knowledge.extract`, `knowledge.reach` (dans le
détail de `knowledge.update`). Doctor : une vérification `knowledge-files`
qui compte les documents dont le fichier manque sur disque (`warn`, nommant
les titres, borné à dix).

## 9. Réglages de recherche et étude du reranker

**Ce qui est conservé, parce que mesuré** : recherche hybride dense + BM25,
fusion `dense-first` sous bge-m3, préfixe titre + section embarqué avec chaque
passage, passages ~1100 caractères plafond 1600 et chevauchement 150, au plus
deux passages d'un même document, six passages et 9 000 caractères injectés
par run. Rien de cela n'a de raison mesurée de bouger ; la nouveauté de ce lot
est d'apporter des **sections utiles** aux formats qui n'en avaient pas (en-tête
de feuille, titre de diapositive, titres de styles Word) — c'est le levier de
la « recherche contextuelle » qui paie, déjà en place pour le Markdown collé.

**Reranker : rejeté, chiffres à l'appui.** Corpus d'évaluation du dépôt
(`copies=4`, 113 passages), bge-m3 en premier étage, cross-encoder sur les 24
premiers candidats, même métriques que `eval-retrieval.mjs` :

| Configuration | En vocabulaire (recall@5 / MRR) | Reformulées (recall@5 / MRR) | Latence 24 paires (ce poste) | RSS des deux modèles |
| --- | --- | --- | --- | --- |
| bge-m3 seul (référence) | 100 % / 100 % | 83,3 % / 83,3 % | — | ~600 Mo |
| + `Xenova/bge-reranker-base` q8 (283 Mo) | 100 % / 100 % | **50,0 % / 50,0 %** | 633 ms (médiane) | 1,5 Go |
| + `onnx-community/bge-reranker-v2-m3-ONNX` q8 (~570 Mo) | 100 % / 100 % | **66,7 % / 66,7 %** | 950 ms | 2,0 Go |
| + `gte-multilingual-reranker-base` | type de modèle non pris en charge par transformers.js 4.2 | | | |

Les deux reformulations perdues sont françaises (« puis-je partir avant la
fin sans pénalité ? » → préavis ; « on m'a cambriolé » → vol) : le
cross-encoder les descend sous le rang 5 alors que bge-m3 les avait au rang 1.
Les logits ne fournissent pas non plus de garde absolue : pertinents p10 −7,1
contre non pertinents p90 −6,6 (v2-m3), les distributions se chevauchent. Sur
le serveur (2 vCPU) la latence serait de l'ordre de 2 à 3 s par run et le
second modèle ne tient pas dans la limite mémoire du conteneur. Un rerank par
modèle de langage via le CLI ajouterait un démarrage de processus de plusieurs
secondes au chemin critique de chaque run, sans clé d'API pour faire autrement.

Réserve d'honnêteté : six questions reformulées, donc 16,7 points par
question ; la direction est la même avec deux modèles et les contraintes de
ressources suffisent seules à trancher. Le banc `scripts/eval-retrieval.mjs`
gagne `--rerank <modèle>` pour que la mesure soit rejouable depuis le dépôt,
et `docs/LEARNING.md` remplace « arithmétiquement incapable » (vrai sous
hachage, faux sous bge-m3 où 5/6 reformulées sont dans le pool) par ces
chiffres.

## 10. Écran (section Bibliothèque de connaissance)

- Rangée de filtres `FILTER_ROW` propre à la section : `WorkspaceScopeFilter`
  (état local, défaut *Tous les workspaces*, lit `?workspace=` à l'ouverture)
  et un champ *Chercher un titre* (filtrage client, insensible à la casse et
  aux accents, sur titre et nom de fichier). Restent visibles quand la liste
  filtrée est vide, avec « n documents » et le compte masqué.
- Zone de dépôt (glisser-déposer + bouton *Déposer des fichiers*, `multiple`,
  `accept` dérivé de `KNOWLEDGE_MIME_TYPES` + extensions). Envois séquentiels
  (un fichier de 20 Mo en base64 fait 27 Mo ; deux en parallèle sur un serveur
  à 2 vCPU n'ont pas de sens), liste d'avancement par fichier : *en cours*,
  *n passages*, ou l'erreur exacte de l'API, conservée à l'écran (un toast
  seul disparaît avant d'être lu). Plafond client : 20 Mo, type accepté.
- Carte : titre, badge de format (`PDF`, `DOCX`…), `ReachBadge`, *En pause*,
  *Vecteurs en attente*, `n passages · taille · n pages · il y a …`. Menu ⋮ :
  *Voir* (visualiseur), *Télécharger l'original*, *Ré-extraire*, *Modifier*
  (titre, portée), *Supprimer*. Interrupteur *Pause* → `PATCH`.
- Répétition de recherche : chaque résultat affiche `Titre › Section · p. 2 ·
  l. 40–52 · score`.
- Chaque bouton d'icône porte un `aria-label` ; la rangée de filtres est
  `[&>*]:shrink-0` et défile (jamais `flex` nu) ; les cibles tactiles suivent
  `TOUCH_TARGET_Y`.

## 11. Cas limites tenus

- Deux dépôts du même fichier : 409 nommant le document, pas de copie.
- Le même texte depuis deux fichiers différents (un .md et son .txt) : deux
  documents, comme aujourd'hui pour deux collages identiques.
- Fichier au nom hostile (`../../etc/passwd`, 300 caractères, sans extension) :
  `safeFileName`, extension dérivée du MIME quand elle manque ; le nom sur
  disque est l'empreinte.
- MIME vide ou fantaisiste (navigateurs qui envoient `''` pour un .md) :
  inférence par extension sur la liste fermée, sinon 415.
- PDF chiffré, PDF scanné, docx en fait un .doc renommé, zip bomb : refus
  nommé (§ 5), l'API reste servie (worker).
- Texte extrait > 512 Kio : 413 avec la taille obtenue ; l'opérateur scinde.
- Document rattaché à un workspace supprimé : reste dans la bibliothèque,
  badge *nulle part* ; un run d'un autre workspace ne le voit pas.
- Bascule *Pause* sur un document issu d'un fichier : `PATCH`, jamais de
  renvoi du contenu.
- Modification du titre seul : le hash du contenu ne change pas, aucun
  re-découpage, la provenance reste vraie.
- Ré-extraction avec un extracteur inchangé et un contenu identique : le hash
  court-circuite ; seul `extractor` et `updated_at` bougent.
- Ré-extraction qui change le texte : passages remplacés en bloc (les
  `document_usages` des runs passés pointent des passages disparus →
  `consultedFor` joint en `LEFT JOIN` et rend *passage remplacé* plutôt que
  d'omettre la ligne, sinon la genèse d'un ancien run perd ses citations).
- Migration sur une base où `documents` est vide : aucune ligne à reprendre,
  index et table créés — testé.
- Réindexation (changement d'embedder) : lit `document_chunks` et réécrit les
  vecteurs seulement, `line_*`/`page_*` intacts.
- Un passage sans `line_*` (antérieur à ce lot) est cité sans lignes ; le
  visualiseur s'ouvre sur la ligne 1.
- Deep link `?document=` vers un document supprimé : la page ouvre
  normalement avec un toast *Ce document n'existe plus*.
- Le fichier d'origine manque sur disque (restauration partielle) :
  téléchargement et ré-extraction répondent 404 nommé ; le doctor le signale ;
  le texte extrait reste interrogeable.
- Windows en développement : chemins via `resolveInside`, worker résolu par
  `new URL('./worker.js', import.meta.url)` dans `dist`.

## 12. Tests

- `packages/shared/src/domain.test.ts` / `api-contracts.test.ts` : les
  contrats acceptent ce que le navigateur envoie et refusent le reste (un
  `reach` sans `global`, un `data` vide, un `PATCH` qui n'entraîne aucun
  défaut) — le piège du schéma d'edge.
- `learning/extract/*.test.ts` : un test par extracteur sur sa fixture
  (fichiers binaires < 100 Ko sous `learning/extract/fixtures/`, générés par
  `scripts/make-knowledge-fixtures.mjs` conservé dans le dépôt), assertions
  sur les sections, les tableaux, les notes, les dates, les `pageBreaks`
  (offset exact de chaque page), et sur chaque refus nommé.
- `chunker.test.ts` : égalité stricte avec la sortie actuelle, offsets
  vérifiés, cas re-joints.
- `knowledge.test.ts` : prédicat de portée (global ∪ attachés, un tiers ne
  voit rien, nulle part), `setReach` remplace, provenance par passage (page 2,
  lignes 40–52 de la fixture PDF), 409 doublon, refus d'édition du contenu
  d'un document fichier, `LEFT JOIN` de `consultedFor`.
- `db/migrations.test.ts` : reprise vs ancien prédicat, base vide.
- `routes/learning.test.ts` : upload de bout en bout par la route (413, 415,
  409, 201), source, PATCH, extract, audit.
- `kernel/context.test.ts` : le bloc injecté porte page et lignes, le budget
  compte le libellé.
- `mcp-gateway.test.ts` : `search_notes` renvoie la provenance.
- Web : filtre et recherche de la section, dépôt (mock `upload`, progression,
  erreur conservée), `ReachPicker` dans le formulaire, badge, menu, visualiseur
  et deep link, genèse avec locator, `MemoryPage` lisant `?workspace=`.
- `check:e2e` : dépose la fixture docx, cherche une question, vérifie qu'un
  résultat porte `lineStart`, télécharge la source, ré-extrait.
- `scripts/shots.mjs` : un document issu d'un fichier dans la graine, pour
  que le banc visuel montre la carte réelle.
- Règle de la maison : chaque nouveau test est saboté une fois pour le voir
  rouge.

## 13. Hors périmètre (dit, pas oublié)

OCR des scans ; `.doc/.xls/.ppt` binaires et ODF (`.odt/.ods/.odp`, faisables
plus tard avec le même lecteur zip) ; images seules ; découpage paramétrable
par document ; page dédiée à la bibliothèque ; le reranker, abandonné sur
mesure (le banc garde `--rerank` si l'hôte change un jour de gabarit) ; les
mises en page que poppler lui-même ne démêle pas (tableaux complexes, texte
tourné, colonnes dessinées sans structure de bloc — le PDF synthétique du
tableau ci-dessus), qui gardent leurs paragraphes entiers mais dans un ordre
de blocs approximatif.

## 14. Prérequis côté production

Lu en direct le 2026-09-08 : la production exécute **0.82.0**, la version de
`main` ; Node 22.23.2 dans le conteneur (le Dockerfile épingle la même) ;
limite mémoire `METACLAUDE_MEMORY_LIMIT=2861m` pour 1,44 Gio utilisés ; disque
système à 38 %. Rien n'est à mettre à jour avant ce lot : poppler entre par
l'image (+26 Mo, 32 paquets Debian), le worker d'extraction reste sous la
limite mémoire avec plus de 1 Gio de marge, et le déploiement de 0.83 se fait
par le bouton habituel. La seule vérification à faire le jour du déploiement
est celle du doctor : `knowledge-files` en `ok` et `pdf-engine` en `ok`
(poppler présent), sinon l'image a été construite sans le paquet.

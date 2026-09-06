# Lot 0 — garde-fou responsive et correction des cinq défauts

> **Pour un exécutant agentique :** ce plan s'exécute **inline**, dans la session
> courante, via `superpowers:executing-plans`. La consigne permanente du
> propriétaire est « uniquement inline, pas de sous-agent » ; elle l'emporte sur
> la recommandation par défaut de `writing-plans`. Les étapes utilisent des cases
> à cocher (`- [ ]`) pour le suivi.

**But** : installer un contrôle navigateur permanent qui rend impossible la
réapparition d'un contrôle rogné ou inatteignable, puis corriger les cinq
défauts qu'il révèle aujourd'hui en production.

**Architecture** : un script Playwright autonome (`apps/api/scripts/
responsive.mjs`) qui démarre le vrai serveur sur le build de production, sème du
contenu adverse, et vérifie quatre invariants sur chaque route, à trois largeurs
et dans deux langues, dialogues ouverts. Chaque route reçoit un **témoin positif
injecté** : sans lui, « zéro défaut » ne se distingue pas d'une sonde cassée. Le
script est branché au job `browser` de la CI, qui installe déjà Chromium. Les
corrections sont ensuite les plus étroites possible — le lot 0 ne préjuge
d'aucun choix de refonte.

**Pile** : Node 24 · Playwright (`@playwright/test`, déjà dépendance de
`apps/api`) · Vitest + Testing Library (`apps/web`) · React 19 · Tailwind v4.

**Spec** : `docs/superpowers/specs/2026-09-06-ui-redesign-design.md`

## Contraintes globales

- **ESM, résolution NodeNext** : tout import relatif dans `apps/api` et
  `packages/shared` se termine par `.js`, même quand la source est en `.ts`.
  `apps/web` utilise le résolveur bundler et l'alias `@/`.
- **Tokens sémantiques Tailwind uniquement** : `bg-surface`, `text-ink`,
  `text-muted`, `border-line`, `text-accent`, `bg-accent-soft` et les couleurs
  d'état avec leurs variantes `-soft`. Jamais de classe de palette brute.
- **Toute copie nouvelle passe par `t()`** et rejoint `apps/web/src/locales/fr.ts`
  le jour où elle est écrite ; pluraliser avec `plural()`, jamais un ternaire.
  Les ratchets i18n sont à zéro et doivent y rester.
- **Base de non-régression** : `apps/web` ≥ 797 tests verts ;
  `packages/shared` 110 ; `apps/api` 2193 passés et **exactement** les 14 échecs
  Windows connus (`security/paths`, `security/directories`, `services/git`,
  `services/plugins`, `kernel/kernel`). Un quinzième est une régression.
- **`pnpm typecheck` après toute modification TypeScript, tests compris.**
  Vitest dépouille les types ; un run vert n'est pas un typecheck vert.
- **Jamais de `| tail` sur une commande dont on lit le code de sortie** : le
  pipeline masque l'échec.
- **L'entrée de journal s'écrit *dans* la section `[Unreleased]` vide**, jamais
  au-dessus. `node deploy/bump.mjs patch` refuse tant qu'elle est vide.
- **Pas de test qui lance le CLI Claude ni qui touche le réseau.**
- `deploy/ratchets.json` ne se desserre jamais.

---

## Structure des fichiers

| Fichier | Responsabilité |
|---|---|
| `apps/api/scripts/responsive.mjs` | **créé** — le contrôle : semence adverse, invariants, témoins positifs, code de sortie |
| `apps/api/package.json` | **modifié** — script `check:responsive` |
| `.github/workflows/ci.yml` | **modifié** — une étape dans le job `browser` |
| `apps/web/src/pages/DashboardPage.tsx:340-342` | **modifié** — défaut 1, la grille qui gonfle |
| `apps/web/src/pages/WorkspacesPage.tsx:83-104` | **modifié** — défaut 2, l'en-tête français trop long |
| `apps/web/src/pages/MemoryPage.tsx:1085,1326` | **modifié** — défaut 3, jetons insécables |
| `apps/web/src/components/ui/primitives.tsx:245-266` | **modifié** — défaut 4, `CardHeader` en `h2` |
| `apps/web/src/components/layout/AppShell.tsx:40-59,95-115,213-232` | **modifié** — défaut 5, `aria-current` sur `/w/:id` |
| `apps/web/src/components/ui/primitives.test.tsx` | **modifié** — niveau de titre |
| `apps/web/src/components/layout/AppShell.test.tsx` | **modifié** — section active sur `/w/:id` |
| `CHANGELOG.md`, `deploy/ratchets.json` | **modifiés** — publication |

---

## Task 1 : le contrôle responsive, qui doit d'abord échouer

**Files:**
- Create: `apps/api/scripts/responsive.mjs`
- Modify: `apps/api/package.json` (bloc `scripts`)

**Interfaces:**
- Consomme : `startServer`, `Client`, `USERNAME`, `PASSWORD`, `REPO_ROOT` de
  `apps/api/scripts/harness.mjs` ; `BoardService` depuis
  `apps/api/dist/services/board.js` ; `context.memory.remember`,
  `context.sessionRepo.create`, `context.runRepo.create`,
  `context.transcriptRepo.append`, `context.workspaceRepo.update`,
  `context.systemWorkspace.ensure()`.
- Produit : le script `pnpm --filter @metaclaude/api check:responsive`, sortie 0
  si et seulement si zéro défaut **et** tous les témoins capturés.

- [ ] **Étape 1 : écrire le contrôle**

Créer `apps/api/scripts/responsive.mjs` :

```js
/**
 * Contrôle responsive : aucun contrôle interactif n'est rogné ni inatteignable.
 *
 * Pourquoi ce contrôle existe, et pourquoi il ne ressemble pas au précédent.
 * `browser.mjs` mesurait `documentElement.scrollWidth - clientWidth` sur deux
 * pages. Trois raisons le rendaient aveugle :
 *
 *  1. Le rogneur de cette application n'est ni `body` ni `html` mais le `div`
 *     de l'AppShell en `overflow-hidden`, qui ARRÊTE la propagation : le
 *     document ne déborde jamais, quoi qu'il arrive dedans.
 *  2. Sous `isMobile`, `window.innerWidth` renvoie le viewport *visuel*, qui
 *     s'élargit avec le contenu qui déborde — mesuré à 530 pour un
 *     `documentElement.clientWidth` de 390. Plus le défaut est grave, plus il
 *     se masque. On ne compare donc qu'à `documentElement.clientWidth`.
 *  3. Le français est ~40 % plus long que l'anglais et c'est lui qui déborde.
 *
 * L'invariant retenu : un élément hors cadre est un défaut si et seulement si
 * le PREMIER ancêtre qui déborde n'est pas défilable horizontalement. Un
 * ancêtre défilable veut dire « atteignable en faisant défiler » — c'est le
 * cas des colonnes du board et des barres d'onglets, voulu. Un ancêtre en
 * `overflow: visible` veut dire « rogné par quelque chose plus haut ».
 *
 * Chaque route reçoit un témoin positif injecté. Sans lui, « zéro défaut » ne
 * se distingue pas d'une sonde cassée.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { Client, PASSWORD, REPO_ROOT, Results, startServer, USERNAME } from './harness.mjs';

const WEB_DIST = join(REPO_ROOT, 'apps', 'web', 'dist');
if (!existsSync(join(WEB_DIST, 'index.html'))) {
  console.error(`Pas de build web dans ${WEB_DIST}. Lancer \`pnpm build\` d'abord.`);
  process.exit(1);
}

const results = new Results();
const server = await startServer({ webDir: WEB_DIST, env: { NODE_ENV: 'production' } });
const { context } = server;
const now = Date.now();

/* ------------------------------ Semence adverse --------------------------- */
/*
 * Un déploiement vide ne peut pas déborder : un board sans carte, une mémoire
 * sans titre long, et le contrôle passe sur une application qu'il n'a pas
 * exercée. On sème donc ce qui déborde réellement — du français long, des
 * jetons insécables, une URL, un identifiant en capitales.
 */
const ws = context.workspaceRepo.update((await context.systemWorkspace.ensure()).id, {
  description:
    "L'espace de travail système de Metaclaude, celui depuis lequel l'agent intervient sur son propre déploiement",
});

const MEMOIRES = [
  ['semantic', "La chaîne d'audit est ordonnée par rowid et non par horodatage, parce que les identifiants portent un suffixe aléatoire"],
  ['semantic', 'METACLAUDE_WORKSPACES_DIR_MUST_NOT_BE_NESTED_INSIDE_METACLAUDE_DATA_DIR'],
  ['episodic', 'https://myclaude.jeyswork.com/api/system/update-apply?version=v0.56.5&requestedBy=jgouvier'],
];
for (const [kind, title] of MEMOIRES) {
  context.memory.remember({
    workspaceId: ws.id,
    kind,
    title,
    content: `${title}. ${'Le détail complet de cette mémoire tient en plusieurs phrases. '.repeat(5)}`,
    tags: ['configuration', 'piège-connu', 'production'],
    confidence: 0.8,
    shelf: 'durable',
  });
}

const { BoardService } = await import(
  pathToFileURL(join(REPO_ROOT, 'apps/api/dist/services/board.js')).href
);
const board = new BoardService(context.db);
const CARTES = [
  ['backlog', "Dessiner la légende de la constellation sur l'affichage mobile sans casser le thème clair", 'improvement'],
  ['backlog', 'ReconnexionSocketIntermittenteApresVeilleProlongeeDuTelephone', 'bug'],
  ['todo', "Reprendre entièrement la mise en page de l'écran des réglages, section par section", 'task'],
  ['in_progress', 'Corriger le rognage de la carte des espaces sur le tableau de bord en 390 pixels', 'bug'],
  ['review', "Courbes bêta dans l'analytique, avec les intervalles de crédibilité", 'improvement'],
  ['done', "Corriger la barre d'onglets iOS et la zone de l'indicateur d'accueil", 'bug'],
];
for (const [status, title, kind] of CARTES) {
  board.create({ workspaceId: ws.id, title, createdBy: 'user:jules', status, kind }, 'user:jules');
}

const session = context.sessionRepo.create({
  workspaceId: ws.id,
  title: "Reprise de la mise en page des réglages et de l'écran des automatisations",
  model: 'sonnet',
  effort: 'high',
  permissionMode: 'default',
});
const run = context.runRepo.create({
  sessionId: session.id,
  workspaceId: ws.id,
  prompt: "Reprends la mise en page de l'écran des réglages",
  policy: {
    model: 'sonnet', effort: 'high', permissionMode: 'default', thinking: 'adaptive',
    thinkingBudgetTokens: null, agentName: null, ultracode: false, source: 'workspace',
  },
  triggeredBy: 'user',
  category: 'engineering',
});
context.db
  .prepare('UPDATE runs SET status = ?, started_at = ?, finished_at = ? WHERE id = ?')
  .run('succeeded', now - 600_000, now - 60_000, run.id);
const EVENEMENTS = [
  {
    kind: 'user_message',
    text: "Reprends la mise en page, en commençant par https://myclaude.jeyswork.com/settings?tab=configuration&density=comfortable",
    attachments: [],
  },
  {
    kind: 'assistant_text',
    streaming: false,
    text:
      'Voici le plan. ' +
      "Chaque section devient un bloc séparé par un filet plutôt qu'une carte encadrée. ".repeat(3) +
      '\n\n```ts\nconst UnIdentifiantVolontairementTresLongPourTesterLeDebordement = 1;\n```\n',
  },
];
EVENEMENTS.forEach((event, seq) => {
  context.transcriptRepo.append(session.id, {
    ...event, id: `evt_resp${seq}`, runId: run.id, seq, at: now - 300_000 + seq * 1000,
  });
});

const client = new Client(server.baseUrl);
await client.login();
await client.call('/api/automations', {
  method: 'POST',
  body: {
    workspaceId: ws.id,
    name: 'Revue matinale du déploiement et des incidents de la nuit précédente',
    description: "Passe en revue les runs échoués, les cartes en attente et l'état du docteur",
    trigger: { type: 'schedule', cron: '0 9 * * *' },
    prompt: 'Fais la revue',
  },
});

/* -------------------------------- Invariants ------------------------------ */

const AUDIT = `
  (() => {
    const SEL = 'button, a[href], [role="button"], input, select, textarea, [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="switch"], [role="checkbox"]';
    // JAMAIS window.innerWidth : sous isMobile il s'élargit avec le débordement.
    const VW = document.documentElement.clientWidth;
    const VH = document.documentElement.clientHeight;
    const nameOf = (el) =>
      (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim() ||
       (el.labels && el.labels[0] ? el.labels[0].textContent : '') || '').replace(/\\s+/g, ' ').trim();
    const short = (el) => (nameOf(el) || '<' + el.tagName.toLowerCase() + '>').slice(0, 40);
    // Derrière une modale, Radix marque le reste aria-hidden : ce n'est pas un défaut.
    const inert = (el) => el.closest('[aria-hidden="true"], [inert]') !== null;
    const verdict = (el) => {
      for (let p = el.parentElement; p; p = p.parentElement) {
        if (p.scrollWidth > p.clientWidth + 1) {
          const ox = getComputedStyle(p).overflowX;
          return {
            scrollable: ox === 'auto' || ox === 'scroll',
            who: p.tagName + '.' + String(p.className).slice(0, 44),
          };
        }
      }
      return { scrollable: false, who: '(html)' };
    };

    const out = { counted: 0, clipped: [], excused: 0, unnamed: [], covered: [], headings: [] };

    for (const el of document.querySelectorAll(SEL)) {
      if (inert(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') continue;
      out.counted += 1;
      if (!nameOf(el)) out.unnamed.push('<' + el.tagName.toLowerCase() + '> .' + String(el.className).slice(0, 44));
      if (rect.right > VW + 1 || rect.left < -1) {
        const v = verdict(el);
        if (v.scrollable) out.excused += 1;
        else out.clipped.push(short(el) + ' [' + Math.round(rect.left) + '..' + Math.round(rect.right) + ']/' + VW + '  <- ' + v.who);
        continue;
      }
      if (rect.top < 0 || rect.bottom > VH) continue;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      if (!(hit && (hit === el || el.contains(hit) || hit.contains(el)))) {
        out.covered.push(short(el) + ' -> ' + (hit ? hit.tagName : 'null'));
      }
    }

    // Un saut de niveau (h1 -> h3) est un défaut d'accessibilité : le lecteur
    // d'écran annonce une sous-section qui n'a pas de section.
    let previous = 0;
    for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const level = Number(h.tagName[1]);
      if (previous && level > previous + 1) {
        out.headings.push('h' + previous + ' -> h' + level + ' : ' + h.textContent.trim().slice(0, 30));
      }
      previous = level;
    }
    return out;
  })()
`;

const TEMOIN = `(() => {
  const b = document.createElement('button');
  b.textContent = 'TEMOIN';
  b.style.cssText =
    'position:absolute;left:' + (document.documentElement.clientWidth + 40) +
    'px;top:120px;width:100px;height:30px';
  document.body.append(b);
})()`;

/* --------------------------------- Passage -------------------------------- */

const ROUTES = [
  ['/', 'accueil'],
  ['/workspaces', 'espaces'],
  [`/w/${ws.id}`, 'espace'],
  [`/w/${ws.id}/s/${session.id}`, 'session'],
  ['/board', 'board'],
  ['/memory', 'mémoire'],
  ['/automations', 'automatisations'],
  ['/agents', 'agents'],
  ['/plugins', 'extensions'],
  ['/analytics', 'analytique'],
  ['/help', 'aide'],
  ['/settings', 'réglages'],
];
const DIALOGUES = [
  ['/automations', 'New automation'],
  ['/memory', 'Add memory'],
  ['/board', 'New task'],
];
const LARGEURS = [
  { nom: '390', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { nom: '768', viewport: { width: 768, height: 1024 } },
  { nom: '1440', viewport: { width: 1440, height: 900 } },
];
const LANGUES = ['en-US', 'fr-FR'];

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);

for (const locale of LANGUES) {
  for (const largeur of LARGEURS) {
    const page = await browser.newPage({ locale, ...largeur });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[name="username"], #username', USERNAME);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });

    results.section(`${locale} · ${largeur.nom}px`);

    const inspecter = async (etiquette) => {
      const r = await page.evaluate(AUDIT);
      results.check(`${etiquette} : rien de rogné`, r.clipped.length === 0, r.clipped.join(' | '));
      results.check(`${etiquette} : rien de couvert`, r.covered.length === 0, r.covered.join(' | '));
      results.check(`${etiquette} : tout contrôle est nommé`, r.unnamed.length === 0, [...new Set(r.unnamed)].join(' | '));
      results.check(`${etiquette} : titres sans saut de niveau`, r.headings.length === 0, r.headings.join(' | '));
    };

    for (const [route, nom] of ROUTES) {
      await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      await inspecter(nom);

      // Le témoin : la sonde peut-elle encore échouer sur CETTE page ?
      await page.evaluate(TEMOIN);
      const sabote = await page.evaluate(AUDIT);
      results.check(
        `${nom} : la sonde peut échouer`,
        sabote.clipped.some((c) => c.includes('TEMOIN')),
        'le témoin positif injecté n’a pas été vu — la sonde ne prouve rien ici',
      );
    }

    for (const [route, ouvreur] of DIALOGUES) {
      await page.goto(`${server.baseUrl}${route}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      const bouton = page.getByRole('button', { name: ouvreur }).first();
      if ((await bouton.count()) === 0) {
        results.check(`dialogue « ${ouvreur} » : son ouvreur existe`, false, `absent de ${route}`);
        continue;
      }
      await bouton.click();
      await page.waitForTimeout(700);
      await inspecter(`dialogue « ${ouvreur} »`);
      await page.keyboard.press('Escape');
    }

    await page.close();
  }
}

await browser.close();
await server.stop();
// `finish()` imprime le total et renvoie DEJA un code de sortie (0 ou 1) :
// c'est l'API de harness.mjs, partagee avec browser.mjs et e2e.mjs.
process.exit(results.finish());
```

- [ ] **Étape 2 : déclarer le script**

Dans `apps/api/package.json`, ajouter à `scripts`, après `check:browser` :

```json
"check:responsive": "node scripts/responsive.mjs"
```

- [ ] **Étape 3 : confirmer l'API de `Results` (déjà vérifiée)**

`harness.mjs` expose `section(title)`, `check(label, ok, detail)` et
**`finish()`** — pas `report()`. `finish()` imprime le total et **renvoie
directement un code de sortie** (`0` si `failed === 0`, sinon `1`), d'où
`process.exit(results.finish())`. La classe est partagée avec `browser.mjs` et
`e2e.mjs` : ne pas la modifier.

Run : `grep -n "finish()" -A 4 apps/api/scripts/harness.mjs`
Attendu : `return this.failed === 0 ? 0 : 1;`

- [ ] **Étape 4 : le faire échouer, et vérifier qu'il échoue pour les bonnes raisons**

```bash
pnpm build
cd apps/api && node scripts/responsive.mjs; echo "sortie=$?"
```

Attendu : **sortie=1**, avec au minimum ces échecs —

- `fr-FR · 390px` → `accueil : rien de rogné` (3 contrôles, ancêtre
  `DIV.grid gap-4 lg:grid-cols-3`)
- `fr-FR · 390px` → `espaces : rien de rogné` (« Compte », `[376..408]/390`)
- toutes langues, toutes largeurs → `réglages : titres sans saut de niveau`,
  `analytique : …`, `automatisations : …`, `accueil : …` (`h1 -> h3`)
- **et 72 lignes « la sonde peut échouer » toutes vertes.** Si l'une échoue,
  le contrôle est inutilisable sur cette page : le corriger avant de continuer.

*Si le contrôle passe du premier coup, il est faux.* Les défauts sont mesurés
et présents ; un vert ici signifie que la sonde ne regarde pas ce qu'elle croit.

- [ ] **Étape 5 : commit**

```bash
git add apps/api/scripts/responsive.mjs apps/api/package.json
git commit -m "check:responsive — le contrôle qui voit ce que le précédent ne pouvait pas voir"
```

---

## Task 2 : défaut 4 — le saut de niveau de titre

Traité avant les défauts de mise en page parce qu'il a **une seule cause** et
qu'il produit le plus grand nombre d'échecs : `PageHeader` rend un `<h1>`,
`CardHeader` rend un `<h3>`, donc chaque page saute un niveau, sur tous les
écrans à la fois.

**Files:**
- Modify: `apps/web/src/components/ui/primitives.tsx:245-266`
- Test: `apps/web/src/components/ui/primitives.test.tsx`

**Interfaces:**
- Produit : `CardHeader` accepte `level?: 2 | 3 | 4` (défaut `2`).

- [ ] **Étape 1 : écrire le test qui échoue**

Ajouter à `apps/web/src/components/ui/primitives.test.tsx` :

```tsx
describe('le niveau de titre d’une carte', () => {
  it('est h2 par défaut : une carte posée sous le h1 de la page ne saute pas de niveau', () => {
    renderWithProviders(<CardHeader title="Configuration" />);
    expect(screen.getByRole('heading', { name: 'Configuration', level: 2 })).toBeDefined();
  });

  it('descend quand la carte est réellement imbriquée sous une section', () => {
    renderWithProviders(<CardHeader title="Mot de passe" level={3} />);
    expect(screen.getByRole('heading', { name: 'Mot de passe', level: 3 })).toBeDefined();
  });
});
```

- [ ] **Étape 2 : le faire échouer**

Run : `cd apps/web && npx vitest run src/components/ui/primitives.test.tsx -t "niveau de titre"`
Attendu : ÉCHEC — le premier cas ne trouve pas de titre de niveau 2 (il est en 3),
le second échoue à la compilation sur `level` inconnu.

- [ ] **Étape 3 : implémenter**

Dans `apps/web/src/components/ui/primitives.tsx`, remplacer `CardHeader` :

```tsx
export function CardHeader({
  title,
  description,
  actions,
  className,
  level = 2,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /**
   * Le niveau du titre, `h2` par défaut.
   *
   * `PageHeader` rend le `h1` de la page ; une carte posée directement dessous
   * est donc une section de premier rang. Rendre un `h3` sautait un niveau sur
   * chaque écran — mesuré à 24 sauts, dans les deux langues et aux trois
   * largeurs. Descendre à 3 est légitime quand la carte est réellement
   * imbriquée sous une section qui porte déjà un `h2`.
   */
  level?: 2 | 3 | 4;
}) {
  const Heading = `h${level}` as const;
  return (
    <div className={cn('flex items-start justify-between gap-4 border-b border-line p-4', className)}>
      <div className="min-w-0 space-y-1">
        <Heading className="truncate text-sm font-semibold text-ink">{title}</Heading>
        {description ? <p className="text-xs leading-relaxed text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
```

- [ ] **Étape 4 : vérifier**

```bash
cd apps/web && npx vitest run src/components/ui/primitives.test.tsx
```
Attendu : tout passe.

- [ ] **Étape 5 : la suite complète, puis le typecheck**

```bash
cd apps/web && npx vitest run
pnpm typecheck
```
Attendu : ≥ 797 tests verts, typecheck sortie 0. Une carte qui rendait un `h3`
attendu par un test existant apparaîtra ici : lui passer `level={3}` si elle
est réellement imbriquée, sinon corriger le test.

- [ ] **Étape 6 : commit**

```bash
git add apps/web/src/components/ui/primitives.tsx apps/web/src/components/ui/primitives.test.tsx
git commit -m "une carte est une section, pas une sous-section"
```

---

## Task 3 : défaut 1 — la grille du tableau de bord qui gonfle

**Files:**
- Modify: `apps/web/src/pages/DashboardPage.tsx:340-342`

**Interfaces:** aucune — correction locale de classes.

- [ ] **Étape 1 : reproduire, et comprendre la cause**

Un élément de grille a `min-width: auto` : il refuse de rétrécir sous la largeur
minimale de son contenu. La liste d'espaces ne coupe pas ses lignes, donc la
colonne gonfle à 542 px (697 en français) dans un panneau de 358 px, avec
`overflow-x: visible` — **rien ne défile, le contenu est rogné**.

Run : `cd apps/api && node scripts/responsive.mjs 2>&1 | grep -A 2 "accueil : rien de rogné"`
Attendu : l'échec, avec `<- DIV.grid gap-4 lg:grid-cols-3`.

- [ ] **Étape 2 : corriger**

Dans `apps/web/src/pages/DashboardPage.tsx`, ligne 340 :

```tsx
{/* `min-w-0` sur les enfants : un élément de grille a `min-width: auto` et
    refuse de rétrécir sous la largeur minimale de son contenu. Sans lui, la
    carte des espaces gonflait à 542 px (697 en français) dans une colonne de
    358 sur téléphone, et comme la grille est en `overflow-x: visible`, rien
    ne défilait — les liens étaient simplement hors d'atteinte. */}
<div className="grid gap-4 lg:grid-cols-3 [&>*]:min-w-0">
```

- [ ] **Étape 3 : vérifier au navigateur**

```bash
pnpm build && cd apps/api && node scripts/responsive.mjs 2>&1 | grep "accueil"
```
Attendu : `accueil : rien de rogné` vert dans les six combinaisons, et
`accueil : la sonde peut échouer` toujours vert.

- [ ] **Étape 4 : commit**

```bash
git add apps/web/src/pages/DashboardPage.tsx
git commit -m "un élément de grille refuse de rétrécir sous son contenu"
```

---

## Task 4 : défaut 2 — l'en-tête des espaces, en français

Sur `/workspaces` à 390 px, `ContentHeader` porte deux boutons libellés
(`Masquer les archivés`, `Nouveau`) **plus** le groupe d'état du téléphone
(connexion, notifications, compte). En anglais l'ensemble tient ; en français
il déborde, et ce qui sort est le dernier élément de la rangée — le menu du
compte. Le repli des libellés sous `sm` est le geste déjà retenu en 0.56.5 pour
l'en-tête du board : on le reprend, par cohérence.

**Files:**
- Modify: `apps/web/src/pages/WorkspacesPage.tsx:83-104`

- [ ] **Étape 1 : lire l'existant**

Run : `sed -n '83,105p' apps/web/src/pages/WorkspacesPage.tsx`

- [ ] **Étape 2 : replier les libellés sous `sm`**

Remplacer les deux boutons d'action de `ContentHeader`. Chacun garde un
`aria-label` **explicite** : un libellé en `hidden sm:inline` est en
`display: none`, donc hors du nom accessible, et le bouton serait anonyme
exactement sur l'écran où le libellé disparaît.

```tsx
<Button
  variant="secondary"
  size="sm"
  onClick={() => setShowArchived((current) => !current)}
  aria-label={showArchived ? t('Hide archived') : t('Show archived')}
>
  <Archive className="size-4" aria-hidden />
  <span className="hidden sm:inline">
    {showArchived ? t('Hide archived') : t('Show archived')}
  </span>
</Button>
<Button
  variant="primary"
  size="sm"
  onClick={() => setCreating(true)}
  aria-label={t('New workspace')}
>
  <Plus className="size-4" aria-hidden />
  <span className="hidden sm:inline">{t('New')}</span>
</Button>
```

- [ ] **Étape 3 : la copie nouvelle doit être traduite le jour où elle est écrite**

`New workspace` existe-t-elle déjà dans le catalogue ?

Run : `grep -n "'New workspace'" apps/web/src/locales/fr.ts`
Si absente, l'ajouter : `'New workspace': 'Nouvel espace',`

- [ ] **Étape 4 : vérifier**

```bash
cd apps/web && npx vitest run src/pages/WorkspacesPage.test.tsx
pnpm typecheck
node deploy/ratchets.mjs
```
Attendu : tests verts, typecheck 0, ratchets i18n toujours à zéro.

```bash
pnpm build && cd apps/api && node scripts/responsive.mjs 2>&1 | grep "espaces"
```
Attendu : `espaces : rien de rogné` vert en `fr-FR · 390px`.

- [ ] **Étape 5 : commit**

```bash
git add apps/web/src/pages/WorkspacesPage.tsx apps/web/src/locales/fr.ts
git commit -m "le menu du compte ne sort plus de l'écran en français"
```

---

## Task 5 : défaut 3 — les jetons insécables de la mémoire

Un titre de mémoire peut être un identifiant en capitales ou une URL. Sans
`break-words`, il ne se coupe pas : il est rogné à 390 px, **sans ellipse**,
donc rien ne signale au lecteur qu'il manque du texte.

**Files:**
- Modify: `apps/web/src/pages/MemoryPage.tsx:1085,1326`

- [ ] **Étape 1 : localiser les trois blocs**

Run :
```bash
grep -n 'text-\[13.5px\] font-medium text-ink' apps/web/src/pages/MemoryPage.tsx
grep -n 'whitespace-pre-wrap' apps/web/src/pages/MemoryPage.tsx
```

- [ ] **Étape 2 : corriger**

Ligne 1326 — le titre d'une mémoire :

```tsx
{/* `break-words` : un titre de mémoire est souvent un identifiant ou une URL,
    donc un seul mot que rien ne coupe. Mesuré à +300 px hors du cadre en
    390 px, sans ellipse pour le signaler. */}
<h3 className="min-w-0 break-words text-[13.5px] font-medium text-ink">{memory.title}</h3>
```

Ligne 1085 — le titre d'un enseignement, même raison :

```tsx
<h3 className="break-words text-[13.5px] font-medium text-ink">{insight.title}</h3>
```

Et le corps en `whitespace-pre-wrap` de la même carte : ajouter `break-words`
à sa liste de classes.

- [ ] **Étape 3 : vérifier**

```bash
pnpm build && cd apps/api && node scripts/responsive.mjs 2>&1 | grep "mémoire"
cd apps/web && npx vitest run src/pages/MemoryPage.test.tsx
```
Attendu : le contrôle est vert sur `mémoire` dans les six combinaisons ; les
tests unitaires de la page restent verts.

- [ ] **Étape 4 : commit**

```bash
git add apps/web/src/pages/MemoryPage.tsx
git commit -m "un titre de mémoire qui est une URL se coupe"
```

---

## Task 6 : défaut 5 — la section active sur `/w/:id`

Le rail marque la section active par le `aria-current` que `NavLink` pose
lui-même. `/w/ws_x` ne correspond à aucune entrée, donc **aucune** section
n'est annoncée comme active sur l'écran d'un espace ni sur celui d'une session.

**Files:**
- Modify: `apps/web/src/components/layout/AppShell.tsx:40-59, 95-115, 213-232`
- Test: `apps/web/src/components/layout/AppShell.test.tsx`

**Interfaces:**
- Produit : `NavEntry` gagne `matches?: (pathname: string) => boolean`.

- [ ] **Étape 1 : écrire le test qui échoue**

Ajouter à `apps/web/src/components/layout/AppShell.test.tsx` :

```tsx
describe('la section active', () => {
  it('reste « Espaces » quand on est dans un espace ou dans une session', () => {
    renderWithProviders(<AppShell>contenu</AppShell>, {
      route: '/w/ws_1/s/ses_1',
    });
    const espaces = screen.getAllByLabelText('Workspaces');
    expect(espaces.some((el) => el.getAttribute('aria-current') === 'page')).toBe(true);
  });
});
```

`renderWithProviders` accepte bien `route` — vérifié : `src/test/render.tsx`
le passe à `MemoryRouter initialEntries={[route]}`, avec `'/'` par défaut. Rien
d'autre à mettre en place.

- [ ] **Étape 2 : le faire échouer**

Run : `cd apps/web && npx vitest run src/components/layout/AppShell.test.tsx -t "section active"`
Attendu : ÉCHEC — aucun élément ne porte `aria-current="page"`.

- [ ] **Étape 3 : implémenter**

Dans `AppShell.tsx`, étendre le type et l'entrée :

```tsx
interface NavEntry {
  to: string;
  label: string;
  icon: ReactNode;
  /** Shown in the phone tab bar. Space is limited, so not everything qualifies. */
  primary?: boolean;
  /**
   * Routes this entry owns beyond its own path.
   *
   * `NavLink` marks itself current by comparing to `to`, so `/w/:id` and
   * `/w/:id/s/:id` matched nothing and no section was announced as active on
   * the two screens an operator spends the most time in.
   */
  matches?: (pathname: string) => boolean;
}
```

```tsx
{ to: '/workspaces', label: 'Workspaces', icon: <FolderGit2 />, primary: true,
  matches: (path) => path === '/workspaces' || path.startsWith('/w/') },
```

Puis, dans le rail comme dans la barre d'onglets, dériver l'état actif :

```tsx
{NAV.map((entry) => {
  const owned = entry.matches?.(location.pathname) ?? false;
  return (
    <Tooltip key={entry.to} content={t(entry.label)} side="right">
      <NavLink
        to={entry.to}
        end={entry.to === '/'}
        aria-current={owned ? 'page' : undefined}
        className={({ isActive }) =>
          cn(
            'flex size-9 items-center justify-center rounded-lg transition-colors',
            '[&>svg]:size-[18px]',
            isActive || owned
              ? 'bg-accent-soft text-accent'
              : 'text-subtle hover:bg-raised hover:text-ink',
          )
        }
        aria-label={t(entry.label)}
      >
        {entry.icon}
      </NavLink>
    </Tooltip>
  );
})}
```

Appliquer la même dérivation à la barre d'onglets du téléphone (`NAV.filter(
(entry) => entry.primary)`), en conservant `end={entry.to === '/'}`.

> `aria-current` posé explicitement n'entre pas en conflit avec celui de
> `NavLink` : sur la route `/workspaces` elle-même, les deux valent `page`.

- [ ] **Étape 4 : vérifier**

```bash
cd apps/web && npx vitest run src/components/layout/AppShell.test.tsx
pnpm typecheck
```
Attendu : tout passe, typecheck 0. `AppShell.test.tsx` tient déjà les deux
moitiés de la règle des encoches : elles doivent rester vertes.

- [ ] **Étape 5 : commit**

```bash
git add apps/web/src/components/layout/AppShell.tsx apps/web/src/components/layout/AppShell.test.tsx
git commit -m "l'espace et la session appartiennent à la section Espaces"
```

---

## Task 7 : brancher le contrôle à la CI, et publier

**Files:**
- Modify: `.github/workflows/ci.yml` (job `browser`)
- Modify: `CHANGELOG.md`, `deploy/ratchets.json`, les quatre `package.json`

- [ ] **Étape 1 : le passage complet doit être vert**

```bash
pnpm build
cd apps/api && node scripts/responsive.mjs; echo "sortie=$?"
```
Attendu : **sortie=0**, avec les 72 lignes « la sonde peut échouer » vertes.
Un vert sans elles ne vaut rien.

- [ ] **Étape 2 : ajouter l'étape à la CI**

Dans `.github/workflows/ci.yml`, job `browser`, après l'étape `Browser check` :

```yaml
      # Le contrôle responsive : douze routes, trois largeurs, deux langues,
      # dialogues ouverts, sur un déploiement peuplé de contenu adverse. Chaque
      # route injecte un témoin positif — sans lui, « zéro défaut » ne se
      # distingue pas d'une sonde cassée.
      - name: Responsive check
        env:
          METACLAUDE_E2E_NO_AGENT: '1'
        run: pnpm --filter @metaclaude/api check:responsive
```

- [ ] **Étape 3 : la suite complète et les ratchets**

```bash
pnpm typecheck
pnpm test:run
node deploy/ratchets.mjs
./deploy/check.sh
```
Attendu : typecheck 0 ; `apps/web` ≥ 797 verts ; `shared` 110 ; `apps/api` 2193
passés et exactement les 14 échecs Windows connus ; ratchets sans desserrage.
`check.sh` : si `shellcheck` est absent il imprime un `skip` — ce run répond
alors à une question plus petite que celle qui garde la poussée.

- [ ] **Étape 4 : écrire l'entrée de journal DANS la section `[Unreleased]` vide**

Ne jamais insérer une seconde section `[Unreleased]` au-dessus de la
précédente : `bump.mjs` lit la première, la trouve vide et refuse.

```markdown
## [Unreleased]

### Ajouté

- Un contrôle responsive permanent (`check:responsive`), en CI : douze routes,
  trois largeurs, deux langues, dialogues ouverts, sur un déploiement peuplé de
  contenu adverse. Chaque route injecte un témoin positif, sans quoi « zéro
  défaut » ne se distinguerait pas d'une sonde cassée.

### Corrigé

- Le tableau de bord rognait trois contrôles sur téléphone : un élément de
  grille refuse de rétrécir sous la largeur minimale de son contenu, la carte
  des espaces gonflait à 542 px (697 en français) dans une colonne de 358, et
  la grille étant en `overflow-x: visible`, rien ne défilait.
- Le menu du compte sortait de l'en-tête des espaces en français, où les
  libellés sont plus longs qu'en anglais.
- Un titre de mémoire qui est une URL ou un identifiant se coupe désormais au
  lieu d'être rogné sans ellipse.
- Une carte rend un titre de niveau 2 et non 3 : chaque écran sautait un niveau
  sous son `h1`, mesuré à 24 sauts dans les deux langues et aux trois largeurs.
- L'écran d'un espace et celui d'une session marquent la section « Espaces »
  comme active ; aucune ne l'était.
```

- [ ] **Étape 5 : publier**

```bash
node deploy/bump.mjs patch
```
*Sans `| tail`* : le pipeline masquerait le refus et la chaîne `&&` continuerait
sur une version non incrémentée que la CI rejetterait.

```bash
git add -A
git commit -m "v0.56.6 — voir ce que la sonde précédente ne pouvait pas voir"
git push
```

- [ ] **Étape 6 : surveiller la CI, puis déployer**

Attendre le vert (le job `browser` exécute maintenant les deux contrôles), puis :

```bash
bash <scratchpad>/deploy-0510.sh v0.56.6 /tmp/mca
```
Ne jamais interroger le serveur par SSH en boucle : quarante connexions en sept
minutes ont fait bannir le poste. Le script attend sur `/api/health`.

---

## Auto-revue

**Couverture de la spécification (§ 7.1 et § 4).** Le § 7.1 exige douze routes,
trois largeurs, deux langues, dialogues ouverts, contenu adverse, témoin positif
par route, et les invariants rognage / atteignabilité / nom accessible /
hiérarchie des titres / `aria-current` / cible de touche ≥ 44 px.

**Deux écarts assumés, à porter par un lot ultérieur :**

1. **La cible de touche n'est pas dans ce script.** `browser.mjs` la mesure déjà,
   par sa technique d'aire de contact sous `pointer: coarse`, et la dupliquer
   ici produirait deux mesures qui divergeraient. Elle reste où elle est ; le
   lot 3 les réunira quand la coquille bougera.
2. **`aria-current` n'est pas vérifié par le script**, seulement par le test
   unitaire de la tâche 6 — c'est le bon niveau : c'est un attribut, pas une
   géométrie.

**Balayage des marqueurs inachevés** : aucun `TBD`, aucun « à compléter »,
aucune étape sans son code.

**Cohérence des types** : `CardHeader({ level })` est déclaré en tâche 2 et
utilisé nulle part ailleurs ; `NavEntry.matches` est déclaré en tâche 6 et
consommé dans le même fichier. Aucun nom n'est employé avant d'être défini.

**Les deux inconnues ont été levées avant d'écrire le plan, et l'une d'elles
m'avait fait écrire du code faux** : `Results` n'expose pas `report()` mais
`finish()`, qui renvoie déjà un code de sortie — le script appelait une méthode
inexistante. `renderWithProviders`, lui, accepte bien `route` et le passe à
`MemoryRouter`. Aucune vérification n'est donc reportée à l'exécution.

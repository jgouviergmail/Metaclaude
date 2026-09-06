# Refonte de l'interface — conception

**Date** : 2026-09-06 · **Version de départ** : 0.56.5 · **Périmètre** : `apps/web`,
plus un contrat de routes dans `packages/shared` et six points d'appel dans `apps/api`.

Ce document est en français, contrairement au reste de `docs/`, parce qu'il est
un document de travail relu par le propriétaire du produit et qu'il ne fait pas
partie du corpus servi par l'écran d'aide (`lib/help.ts` ne balaie que
`docs/guide/*.md`).

---

## 1. Le problème

L'interface est décrite par son utilisateur comme « dense, peu lisible, mal
organisée ». La mesure confirme, et en désigne la cause mécanique : **il existe
un vocabulaire de contrôles et aucun vocabulaire de structure.**

`components/ui/` fournit `Button`, `Input`, `Badge`, `Card`, `Meter`, `Stat`,
`Tooltip`. Il ne fournit ni `Page`, ni `Section`, ni `Grid`, ni `Toolbar`, ni
`DataList`, ni `SettingRow`. Chaque écran réinvente donc sa largeur, sa
gouttière et son rythme. Les chiffres qui en découlent :

| Mesure | Valeur | Lecture |
|---|---|---|
| Tailles de texte distinctes | **17** (11 littérales, 493 occurrences + 6 échelons Tailwind, 70) | aucune échelle |
| Valeurs `max-w-*` distinctes | **13** sur 38 occurrences | aucune règle de largeur |
| Paddings distincts | **50** | rythme improvisé |
| Rayons distincts | 10 | vocabulaire non tenu |
| `<Card>` + `border border-line` | 67 + 71 = **138 boîtes** | la boîte ne hiérarchise plus rien |
| Rangées `flex` sans `wrap` ni `col` | **338**, dont 97 `flex-1` | surface de risque du défaut de débordement |
| Routes du front écrites en dur | **86**, dont **6 dans `apps/api`** | les deux côtés peuvent déjà diverger |
| Fichier le plus long | `AgentsPage.tsx`, **2584 lignes** | conséquence directe de l'absence de gabarit |

Le socle, lui, est sain : tokens sémantiques OKLCH, thèmes clair et sombre en
lockstep, contraste mesuré par `styles/contrast.test.ts`, Tailwind v4, React 19,
Radix, TanStack Query. **Rien n'est à jeter dans les fondations.**

---

## 2. Décisions arbitrées

Quatre choix ont été tranchés par le propriétaire, ils ne sont pas rouverts ici.

1. **Périmètre** — structure *et* organisation. On reconstruit la couche de mise
   en page et on revoit l'architecture de l'information. Les fonctions ne
   changent pas ; leur agencement, oui. C'est le seul ordre qui évite de migrer
   chaque écran deux fois.
2. **Densité réglable par l'utilisateur** — compacte (défaut) et confortable,
   dans les préférences.
3. **Navigation à cinq entrées** — Accueil, Espaces, Board, Mémoire, Système,
   identiques dans le rail et dans la barre d'onglets du téléphone. Le bouton
   « More » disparaît : plus aucune section n'est structurellement moins
   accessible sur téléphone.
4. **Identité raffinée** — on garde l'indigo, le sombre d'abord, les neutres
   chauds, le logo à l'anneau ouvert et la lueur d'ambiance. On corrige
   l'échelle typographique, la police et l'élévation.

Deux décisions prises par l'ingénieur, énoncées plutôt que soumises :
livraison par lots successifs déployables ; la page Session est dans le
périmètre, traitée en dernier parce qu'elle porte le streaming, les
approbations et le composeur.

---

## 3. Faits établis par la mesure

Cette section existe pour que rien, plus bas, ne repose sur une intuition.
Chaque ligne a été obtenue par sonde et non par lecture de code.

### 3.1 Le moteur de test

- Les tests de `apps/web` tournent sous **happy-dom 20.11.6**, pas jsdom
  (`apps/web/vite.config.ts:78`). Les cinq pièges consignés dans `CLAUDE.md`
  visent le mauvais moteur et doivent être corrigés.
- **`getBoundingClientRect()` renvoie `0×0`** : aucune mise en page. Aucun test
  unitaire ne peut détecter un débordement, un rognage ou une cible de touche.
- **Le CSS de Tailwind v4 est illisible par happy-dom** : `@layer`,
  l'imbrication CSS et `@custom-variant` cassent *toute* la feuille.
  `@media (width >= 40rem)`, `oklch()`, `@property`, `:where()` et `@supports`
  passent. Un harnais « vrai CSS en unitaire » exigerait un pipeline maison sur
  une API semi-interne : **écarté**, ce serait de la fausse confiance.
- **Le cache de style calculé est invalidé par une mutation du DOM, jamais par
  un changement de viewport.** Règle : fixer la largeur *avant* le rendu.
- **Une propriété personnalisée commutée par `[data-density]` fonctionne**
  (8px → 14px vérifié) : l'architecture de densité est testable unitairement.
- `ResizeObserver` et `IntersectionObserver` sont natifs : aucun mock à écrire.
- `env()` est vidée du CSSOM mais **conservée dans `getAttribute('style')`**.

### 3.2 Le navigateur

- **`window.innerWidth` est inutilisable sous émulation mobile** : mesuré à 530
  pour un `documentElement.clientWidth` de 390, parce que le viewport *visuel*
  s'élargit avec le contenu qui déborde. **Plus le défaut est grave, plus il se
  masque.** Toute sonde doit utiliser `documentElement.clientWidth`.
- Le contrôle actuel `no horizontal overflow` de `scripts/browser.mjs` est
  aveugle au défaut réel : le rogneur n'est ni `body` ni `html` mais le `div`
  de l'`AppShell` en `overflow-hidden`, qui **arrête la propagation**. La
  section téléphone ne visite d'ailleurs que `/` et `/settings`, jamais un
  dialogue, jamais en français.
- L'invariant qui fonctionne : **un élément hors cadre est un défaut si et
  seulement si le *premier* ancêtre qui déborde n'est pas défilable
  horizontalement.** Vérifié sans faux positif sur 12 routes × 3 largeurs
  × 2 langues, avec **72 témoins positifs capturés sur 72**.
- Un `text-overflow: ellipsis` produit `scrollWidth > clientWidth` **par
  construction** : une sonde de texte qui l'ignore produit 55 faux positifs
  pour 3 vrais.
- La CI exécute déjà un vrai Chromium (`playwright install --with-deps
  chromium`, job `browser`), donc un garde-fou navigateur est câblable.

### 3.3 La police

Mesuré, pas estimé : **Inter variable 400–700, sous-ensemble `latin` = 47 kB**
(`latin-ext` = 83 kB **et n'est pas nécessaire**). La plage `latin` est
`U+0000-00FF, U+0131, U+0152-0153, …` : les 14 caractères français testés —
`é à ç ù ê ô ï œ Œ « » ’ € ·` — sont tous couverts, `Œ`/`œ` compris. À comparer
aux 189 kB de JS initial ; chargée en parallèle, `font-display: swap`, elle ne
bloque pas le rendu. `fontSrc: ["'self'", 'data:']` : aucune modification de CSP.

### 3.4 La base de non-régression

| Paquet | Référence | Statut |
|---|---|---|
| `apps/web` | **797 / 797** en 9,6 s, 92 fichiers | vert |
| `packages/shared` | 110 / 110 | vert |
| `apps/api` | 2193 passés, **14 échecs** dans 5 fichiers | écart Windows connu et documenté ; CI Linux verte |

Couplage des tests : **1086 requêtes sémantiques** (`getByRole` 481,
`getByText` 508, `getByLabelText` 97) contre **98 structurelles**
(`querySelector` 66, `.className` 26, `toHaveClass` 6). **91,7 % des tests
survivent à un changement de présentation** — le risque de migration est bien
plus faible qu'il n'y paraît.

---

## 4. Défauts existants, à corriger avant la refonte

Découverts par l'audit contradictoire, tous présents en production en 0.56.5.

| # | Écran | Condition | Défaut |
|---|---|---|---|
| 1 | `/` | 390 px, les deux langues | 3 contrôles rognés : la carte des espaces gonfle à 542 px (697 en français) dans une colonne de 358, `min-width: auto` sur un élément de grille, `overflow-x: visible` donc rien ne défile |
| 2 | `/workspaces` | 390 px, **français uniquement** | « Compte » coupé dans l'en-tête, `[376..408]/390` |
| 3 | `/memory` | 390 px | 3 blocs coupés sans ellipse (identifiant long +300 px, URL) : illisibles et non signalés |
| 4 | 6 écrans | toutes langues, toutes largeurs | **24 sauts de niveau de titre `h1 → h3`** — défaut d'accessibilité systématique |
| 5 | `/w/:id` | toutes | aucun `aria-current` : la section active n'est pas signalée |

Non tranché : un cas « couvert » vu une fois sur le tableau de bord en français
(« Demander à Metaclaude » recouvert par un lien), non reproduit sous la sonde
resserrée. À réexaminer, non compté comme défaut.

---

## 5. Architecture cible

### 5.1 Tokens

**Échelle typographique à six rôles** — `display`, `title`, `heading`, `body`,
`label`, `caption` — chacun portant taille, graisse et interlignage. Un
composant choisit un rôle, jamais une taille. Remplace 17 valeurs distinctes.

**Densité par tokens commutés**, jamais par branchement dans les composants :

```css
:root { --mc-row-h: 32px; --mc-stack: 8px;  --mc-section-gap: 24px; --mc-text-body: 13px; }
:root[data-density='comfortable'] { --mc-row-h: 40px; --mc-stack: 14px; --mc-section-gap: 36px; --mc-text-body: 14px; }
```

Le mécanisme est celui, déjà éprouvé, de `.dark`. Un test unique tient le
contrat ; aucun composant ne connaît la densité. La **couverture** de la
fonction se mesure par le ratchet `literalTextSizes` (référence 493) : tant
qu'il ne descend pas, la densité ne produit rien sur les écrans concernés.

**Police** — Inter variable, sous-ensemble `latin` seulement, servie depuis
`/fonts`, préchargée, `font-display: swap`. Le mono reste la pile système : les
blocs de code sont déjà bons et cela économise ~60 kB.

**Élévation** — moins de cadres, davantage de groupement par le blanc et le
filet. `contrast.test.ts` est étendu à tout nouveau token.

### 5.2 Les onze primitives de structure

Dans un nouveau `components/ui/layout.tsx`, testées une fois, sans aucune
connaissance d'un écran particulier :

| Primitive | Rôle |
|---|---|
| `Page` | détient **la** largeur maximale, via `width="prose \| standard \| wide \| full"` |
| `PageHeader` | titre, sous-titre, actions, emplacement de navigation secondaire |
| `Section` | bande titrée ; **détient le niveau de titre** (corrige le défaut n° 4) |
| `Toolbar` | filtres et actions, repli correct, feuille sur téléphone si débordement |
| `Grid` | grille responsive avec la gouttière de densité ; `min-width: 0` par défaut (corrige la cause du défaut n° 1) |
| `DataList` / `Row` | la liste dense : libellé, valeur, méta, actions |
| `SettingRow` | libellé + aide révélée + contrôle |
| `Field` | libellé, indice, erreur, contrôle |
| `SegmentedControl` | porte le contrat responsive qui a coûté le déclencheur *Event* : **grille à deux colonnes sous le point de rupture, rangée calée à gauche au-dessus**. Une grille à N colonnes égales sur bureau étire les libellés sur toute la largeur et se lit mal — vérifié sur l'écran-témoin |
| `Tabs` | **un seul** enrobage de Radix ; supprime les trois imports directs |
| `StatTile` | l'indicateur chiffré, dans une grille et non dans une carte |

### 5.3 Trois gabarits pour treize écrans

- **T1 Tableau de bord** — grille 12 colonnes, zones de poids inégal.
- **T2 Liste + détail** — liste dense et détail ; le détail devient plein écran
  sur téléphone. Sert Espaces, Mémoire, Automations, Agents, Plugins, Board,
  Sessions.
- **T3 Réglages** — navigation secondaire + sections de `SettingRow`.

C'est la réponse à « évolutive » : un écran nouveau choisit un gabarit au lieu
de partir d'une page blanche, et un fichier de 2584 lignes ne peut pas
réapparaître.

### 5.4 Navigation et **contrat de routes**

Cinq entrées, même ordre dans le rail et la barre d'onglets. La navigation
secondaire vit dans l'en-tête de page, donc au même endroit sur les deux
écrans. Sous *Système* : Automations, Agents & compétences, Plugins,
Analytique, Réglages, Aide.

**Exigence née de la mesure.** 86 littéraux de route existent, dont six dans
`apps/api` :

| Fichier | Route | Ce qui casse si elle change |
|---|---|---|
| `routes/integrations.ts:67,73` | `/settings?…` | **retour OAuth Google**, flux externe |
| `services/push.ts:314,348` | `/w/:id/s/:id` | notifications push de la PWA installée |
| `kernel/kernel.ts:1009` | `/memory?workspace=…` | lien de notification, avec paramètre |
| `kernel/kernel.ts:1253` | `/w/:id/s/:id` | lien d'approbation |
| `services/scheduler.ts:518` | `/automations` | notification d'automatisation |
| `context.ts:342` | `/settings` | notification système |

La couverture de tests de `/automations`, `/agents`, `/plugins`, `/analytics`
et `/help` est **nulle** : une refonte les casserait en silence.

**Décision** : les routes deviennent un contrat dans
`packages/shared/src/routes.ts`, avec des **constructeurs** et non de simples
constantes (`routes.memory({ workspace })`, `routes.session(ws, s)`), consommé
par le front *et* par l'API. C'est la règle que `CLAUDE.md` pose déjà pour les
entités, jamais appliquée aux URL. Elle corrige au passage une dérive déjà
possible aujourd'hui. Le typecheck désigne alors chaque appelant lors d'un
renommage.

### 5.5 La palette de commandes

`cmdk` est déjà installé. Chaque écran enregistre ses actions dans un registre
unique : une action nouvelle devient atteignable sans qu'on lui trouve une
place à l'écran. C'est le second mécanisme d'évolutivité, après les gabarits.

---

## 6. Écran par écran

- **Accueil** — grille au lieu d'une colonne : le brief prend la largeur,
  l'état et les quotas la colonne étroite. L'onboarding se replie dès qu'il est
  entamé. Corrige le défaut n° 1.
- **Espaces** — liste + détail ; les indicateurs de non-lu sont conservés.
  Corrige le défaut n° 2.
- **Board** — les cinq colonnes tiennent à l'écran ; les deux groupes de
  filtres cessent de se ressembler ; vue liste par statut sur téléphone plutôt
  qu'un défilement horizontal.
- **Mémoire** — la constellation devient un onglet ; la liste dense passe
  devant. `break-words` sur les titres : corrige le défaut n° 3.
- **Système** — une page, six onglets. Les 8 cartes empilées de Settings
  (et leurs 8 en-têtes) deviennent des sections séparées par un filet.
- **Session** — colonne de lecture bornée (~72 caractères), composeur ancré,
  appels d'outils repliés par défaut.

---

## 7. Garde-fous

### 7.1 `check:responsive`, contrôle permanent

Ajouté au job `browser` de la CI, à côté de `check:browser` :

- 12 routes × 3 largeurs (390 / 768 / 1440) × **2 langues** ;
- dialogues ouverts, pas seulement les pages ;
- sur un déploiement **peuplé de contenu adverse** (titres longs, jetons
  insécables, URL) — un board vide ne peut pas déborder ;
- **témoin positif obligatoire par route** : sans lui, « zéro défaut » ne se
  distingue pas d'une sonde cassée ;
- invariants : rognage (premier ancêtre débordant non défilable),
  atteignabilité au centre, nom accessible présent, hiérarchie des titres,
  `aria-current`, cible de touche ≥ 44 px sous `pointer: coarse`.

### 7.2 Cinq ratchets, tous prototypés et capturés par sabotage

| Ratchet | Référence | Plafond |
|---|---|---|
| `hardcodedRoutes` | 86 | **0** |
| `literalTextSizes` | 493 | décroissant |
| `cardAsLayout` | 67 | décroissant |
| `rawMaxWidth` (hors `full`/`none`) | 28 | 0 |
| `adHocTabs` | 3 | 0 |

`adHocTabs` mesure l'import direct de `@radix-ui/react-tabs` hors
`components/ui` : aucun faux positif n'est possible. Les autres sont des
budgets décroissants, pas des verdicts, ce qui les met à l'abri du piège du
ratchet textuel consigné dans `CLAUDE.md`.

---

## 8. Plan de test

### 8.1 Ce que chaque niveau peut prouver

| Niveau | Prouve | Ne peut pas prouver |
|---|---|---|
| **N1 unitaire** (happy-dom) | logique, état, rôles ARIA, noms accessibles, commutation des tokens de densité, contrats de classes | toute géométrie : débordement, rognage, cible de touche, vrai CSS |
| **N2 contrat** (dérivé des schémas) | qu'un champ nouveau casse le test le jour où il est ajouté | le rendu |
| **N3 navigateur** (Chromium réel) | rognage, atteignabilité, cibles de touche, CSP, a11y, matrice largeur × langue × densité | le jugement esthétique |
| **N4 banc** (captures) | densité perçue, hiérarchie, équilibre | rien automatiquement — c'est pour des yeux |

### 8.2 Trois règles imposées par les mesures

1. **La largeur se fixe avant le rendu**, jamais après : le cache de style de
   happy-dom n'est invalidé que par une mutation du DOM. Un assistant
   `renderAtWidth(width, ui)` l'impose, avec restauration à 1024 en `afterEach`.
2. **Jamais `window.innerWidth`** dans une sonde : `documentElement.clientWidth`.
3. **Tout contrôle nouveau doit d'abord être capturé par un témoin positif.**
   Un test qui n'a jamais échoué ne prouve rien — trois tests du noyau l'ont
   déjà appris à ce dépôt.

### 8.3 Matrice de la campagne de revue

Déroulée à chaque lot, et intégralement en revue de code finale :

| Axe | Valeurs |
|---|---|
| Largeur | 390, 768, 1440 |
| Langue | fr-FR, en-US |
| Densité | compacte, confortable |
| Thème | clair, sombre |
| Contexte | page, dialogue ouvert, panneau latéral ouvert |
| Contenu | vide, nominal, adverse (titres longs, jetons insécables) |

Le produit complet est trop large pour être exhaustif à chaque lot : la CI
déroule **largeur × langue × contenu adverse** ; densité et thème sont couverts
par le banc à chaque lot et par la CI au lot 9.

### 8.4 Tests unitaires ajoutés

- Une suite par primitive de structure (onze).
- Un test du contrat de densité : les tokens changent, les composants non.
- Un test du contrat de routes : chaque constructeur produit l'URL attendue, et
  un test dérivé qui échoue si une route littérale réapparaît côté API.
- Une suite par écran migré, reprenant les assertions sémantiques existantes.

---

## 9. Lots et portes

| Lot | Contenu | Porte de sortie |
|---|---|---|
| **0** | `check:responsive` en CI + correction **ciblée** des défauts 1 à 5 | zéro défaut, témoins capturés, CI verte |
| **1** | Tokens, échelle typographique, police (47 kB mesurés), densité, **correction des cinq pièges `CLAUDE.md` qui nomment jsdom** | `literalTextSizes` commence à baisser ; poids du bundle mesuré |
| **2** | Les onze primitives + leurs tests | couverture des primitives, ratchets en place |
| **3** | Contrat de routes, coquille, rail, onglets, palette | `hardcodedRoutes` → 0 ; **écran-témoin photographié et soumis** |
| **4** | Système (6 onglets) | le plus gros gain de densité |
| **5** | Accueil | — |
| **6** | Mémoire et Board | — |
| **7** | Espaces | — |
| **8** | Session | prudence maximale : streaming, approbations, composeur |
| **9** | Passe finale : banc, deux densités, deux thèmes, deux langues | matrice complète |

**Correction ciblée contre refonte.** Le lot 0 corrige les cinq défauts par
l'intervention la plus étroite possible — `min-width: 0` sur la grille,
`break-words` sur les titres, un niveau de titre juste — sans anticiper la
refonte. Les lots 5, 6 et 7 refont ensuite ces écrans, et les primitives
`Grid` et `Section` rendent alors la correction structurelle. Ce n'est pas du
travail fait deux fois : le lot 0 livre la correction à un utilisateur qui
subit le défaut aujourd'hui, et le `check:responsive` interdit sa réapparition
pendant toute la migration.

**Porte explicite au lot 3.** L'écran-témoin est photographié au banc et soumis
avant de continuer. Juger la direction sur l'application réelle coûte moins
cher que de découvrir au lot 7 qu'elle ne convient pas.

---

## 10. Anti-régression

À chaque lot, sans exception :

- `pnpm typecheck` — sortie 0. **Vitest n'est pas un typecheck** : il dépouille
  les types. Le piège a déjà coûté une version non taguée.
- `apps/web` : **797 tests au minimum**, aucun échec.
- `packages/shared` : 110 / 110.
- `apps/api` : 2193 passés et **exactement les 14 échecs Windows connus** —
  un quinzième est une régression.
- `node deploy/ratchets.mjs` : aucun desserrage. Un plafond ne se desserre qu'à
  la main, et le commit doit dire pourquoi.
- `check:responsive` : zéro défaut, témoins capturés sur chaque route.
- Ratchets i18n déjà à zéro : toute copie nouvelle est traduite le jour où elle
  est écrite, et pluralisée par `plural()`, jamais par un ternaire.
- Jamais de `| tail` sur une commande dont on lit le code de sortie.

---

## 11. Cas limites à couvrir

- **Le français est 40 % plus long** : c'est lui qui déborde. Défaut n° 2
  invisible en anglais. Toute la matrice le porte.
- **`hidden sm:inline` retire le libellé du nom accessible** (9 occurrences
  aujourd'hui, 0 contrôle sans nom — cet invariant doit tenir).
- **Un seul calque par encoche** : la barre d'onglets du téléphone détient
  l'inset du bas, `<main>` réserve sa hauteur totale, `body` ne pade que le
  haut et les côtés. Deux calques ont déjà livré l'application cassée deux fois.
- **PWA installée contre onglet de navigateur** : les insets valent 0 partout
  où l'on teste habituellement.
- **`prefers-reduced-motion`** : toute animation nouvelle s'y soumet.
- **Contraste** des nouveaux tokens dans les deux thèmes, y compris le texte
  posé sur une surface pleine (`success`/`danger`), où trois combinaisons sur
  quatre échouaient jadis.
- **Ordre de focus** après la refonte de la navigation ; `aria-current` sur
  chaque route, y compris `/w/:id`.
- **Jetons insécables** : identifiants, URL, chemins Windows.
- **Densité × largeur × langue** : une ligne compacte en français à 390 px est
  le pire cas de l'application.
- **Radix active sur `pointerdown`** : un `fireEvent.click` seul ne fait rien.
  Et `MenuItem` avec `selected` rend `menuitemcheckbox`, pas `menuitem`.
- **Pas de `jest-dom`** : `toBeDisabled` n'est pas un matcher.

---

## 12. Risques et points ouverts

1. **Le lot 8.** La page Session porte trois mécanismes signalés défaillants ce
   mois-ci. Elle est traitée en dernier, avec la matrice complète.
2. **`hardcodedRoutes` → 0 est ambitieux** : 86 occurrences, dont les
   définitions de `<Route path>` d'`App.tsx`, qui doivent elles aussi consommer
   le contrat. Si le plafond zéro s'avère impraticable, il descend par paliers
   et le commit dit pourquoi.
3. **La densité confortable ne vaut que sa couverture.** Le ratchet
   `literalTextSizes` est la mesure honnête : tant qu'il stagne, la fonction
   est décorative sur les écrans non migrés. À dire, plutôt qu'à masquer.
4. **Le cas « couvert » du tableau de bord** reste non tranché.
5. **Le corpus de `docs/guide`** est servi par l'écran d'aide et référence des
   routes : le lot 3 doit le relire.

---

## 13. Ce que ce document ne fait pas

Il ne contient aucun chiffre non mesuré. Les quatre estimations de la première
version — poids de la police, surcoût de la densité, faisabilité des ratchets,
risque de la refonte de navigation — ont été soit mesurées, soit remplacées par
une mesure vérifiable, soit retirées.

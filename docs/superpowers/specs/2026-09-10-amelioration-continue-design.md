# Amélioration continue des consignes : analyse systémique avant code

Date : 2026-09-10 · Statut : **livré en v0.91.0** — voir le § 12 pour les cinq
décisions de ce document que la mesure a renversées en chemin
· Version de référence à l'analyse : 0.90.1 (prod et dépôt alignés)

## 0. Résumé

Le besoin : que les apprentissages du système ne se limitent plus à écrire des
mémoires et à choisir un modèle, mais lisent les exécutions dans leur ensemble
et **proposent des révisions des consignes** — le prompt système d'un
workspace, le corps et la description d'un skill, le prompt et la description
d'un sous-agent — d'après ce qui a marché, ce qui n'a pas marché et les
erreurs, sans sur-réagir à un cas isolé.

Ce que le code fait aujourd'hui, vérifié fichier par fichier : trois boucles
(mémoire, politique de modèle, réflexion) qui changent le *contexte* injecté et
le *modèle* choisi, jamais les *consignes*. Le conseiller propose des skills
et des sous-agents **nouveaux** et refuse par construction toute proposition
portant le nom d'un existant. Aucune table ne sait quel skill ou quel
sous-agent un run a eu à disposition ni lequel il a invoqué ; la colonne
`skills.use_count` est affichée et n'est jamais incrémentée.

Ce que la production dit, mesuré le 2026-09-10 sur la base réelle : 63 runs en
huit jours, aucun échec, deux notes de l'opérateur, **zéro invocation** de
skill ou de sous-agent alors que cinq de chaque sont activés. Le signal
« ce qui ne fonctionne pas » n'est donc pas dans `status = failed` ; il est
dans les transcriptions (corrections de l'opérateur, outils en erreur,
consignes ignorées) et dans la **non-utilisation** de ce qui est monté.

La conception retenue : une quatrième boucle, sur le modèle exact des trois
autres — **les faits en code, le jugement à un modèle borné, la décision à une
personne**. Une instrumentation déterministe par run ; une fenêtre d'évidence
par workspace ; des observations calculées sans modèle ; un arbitre sans
outil, à schéma, qui rédige une révision minimale et cite ses preuves ; des
garde-fous contre la sur-réaction écrits en code et tenus par un banc ; une
proposition dans la boîte de réception existante, avec le diff et les runs
cités ; l'application par l'opérateur seulement, réversible, et un suivi qui
dit à la fenêtre suivante si la révision a changé quelque chose.

Six lots atomiques, chacun livrable seul et vert à `pnpm verify`. Le premier
ne coûte aucun appel de modèle et rend déjà vrai un chiffre qui ment.

---

## 1. Dépouillement du besoin

### 1.1 L'intention réelle

La phrase de départ nomme trois cibles (prompt système du workspace, skills,
sous-agents), une source (les exécutions), un critère (usages, réussites,
échecs, erreurs) et un piège (sur-réagir au ponctuel). Derrière, l'intention
est celle des lois de `docs/ROADMAP.md` appliquées à un quatrième registre :
un système qui s'améliore de façon **inspectable** et **réversible**, où la
machine propose et la personne dispose. Le mot « optimisation » ne désigne pas
une réécriture : dans ce dépôt, chaque passe mesurée a montré que la réponse
correcte la plus fréquente est « rien à changer » (réflexion, consolidation,
distillation de skill). Il en ira de même ici, et le système doit pouvoir le
dire.

### 1.2 Les non-dits, explicités

- **« Prompt système d'un workspace »** est, dans le produit, le champ
  `settings.systemPromptAppend` (≤ 20 000 caractères,
  `packages/shared/src/domain.ts:203`), assemblé dans le préfixe mis en cache
  avec la directive de langue et l'étagère *standing*
  (`apps/api/src/kernel/kernel.ts:1086-1115`). Le `CLAUDE.md` du répertoire
  d'un workspace ordinaire est un fichier du dépôt de l'opérateur, découvert
  par le CLI (`settingSources: ['project']`, `supervisor.ts:1141`) : c'est du
  code, hors périmètre d'une édition automatique. Celui du workspace système
  est régénéré à chaque démarrage et `NOTES.md` appartient à l'opérateur
  (`services/system-workspace.ts:25-29`). **Cible retenue : `systemPromptAppend`
  seul.**
- **Un skill** est une ligne du registre (`skills.body`, `skills.description`)
  matérialisée avant chaque run en `.claude/skills/<nom>/SKILL.md`
  (`services/registry.ts:523-590`). Le CLI décide de l'ouvrir d'après sa
  *description* : réviser la description est souvent le levier, pas le corps.
- **Un sous-agent** est une ligne `agents` passée au SDK par `options.agents`
  (`supervisor.ts:1344`) ; il peut aussi être l'agent *principal* d'une
  session (`policy.agentName` → `options.agent`, `supervisor.ts:1156`).
- **Les automatisations** ont un prompt (`automations.prompt`) et sont les
  runs qui se répètent le plus : 18 des 63 runs de prod (`loop`, `automation`,
  `system`). Elles ne sont pas nommées dans la demande ; elles sont la
  quatrième cible naturelle du même mécanisme, et la seule où une vraie
  statistique existe (même prompt, N exécutions). Voir la question résiduelle
  Q1.
- **« Ce qui fonctionne et ce qui ne fonctionne pas »** doit être défini avec
  les signaux réellement disponibles (§ 2), pas avec des notes qui n'existent
  pas.
- **« Ne pas sur-réagir »** est une propriété à tenir **en code** — seuils,
  refroidissements, une proposition par cible, banc à plafond de faux
  positifs — et non par une phrase dans un prompt : la porte mémoire a mesuré
  qu'un modèle n'applique pas seul une règle de ce genre (`gatekeeper.ts`,
  « Four more rules sit after the model, because the bench showed it would
  not apply them itself »).

### 1.3 Hypothèses confrontées au code

| Hypothèse | Vérification | Verdict |
|---|---|---|
| Le conseiller couvre déjà le besoin | `services/advisor.ts:567-572` refuse un skill ou un agent dont le nom existe ; `accept()` (639-663) ne sait que *créer*, désactivé. Le dossier (804-881) ne lit que la première ligne des prompts et des erreurs, jamais une transcription | **Faux positif** : il propose du neuf, jamais une révision |
| La réflexion pourrait proposer des révisions à chaque run | `reflexion.ts:37-83` : schéma volontairement petit (leçons, un skill) ; un run n'est pas une évidence (`LEARNING.md` § tiers) | Rejeté : ce serait la sur-réaction par construction |
| L'usage des skills est suivi (`useCount`) | `grep use_count` : seule `memories.use_count` est écrite (`learning/memory.ts:805`) ; `skills.use_count` est lue par `registry.ts:153` et affichée par l'intendant (`steward.ts:554`) | **Colonne morte** : elle vaut 0 pour toujours, en prod aussi (5 skills, tous à 0) |
| L'usage d'un sous-agent est visible | Événements `subagent` (nom, statut `ok`/`error`, résumé — `domain.ts:587-596`) et appels `Task` (`AgentInput.subagent_type`, SDK) dans la transcription | Vrai, mais **nulle part agrégé** |
| Un skill invoqué laisse une trace | Le CLI invoque un skill par un appel d'outil `Skill` ; le SDK ne déclare pas d'interface `SkillInput` (vérifié dans `sdk-tools.d.ts`) et la prod n'en contient aucun | **Forme du fil à mesurer** en lot 0 avec `scripts/sdk-probe.mjs`, fixture bâtie sur la capture (leçon `rate_limits`) |
| Les genres d'insight `pattern` et `preference` servent | `api-contracts.ts:396` les déclare ; aucun émetteur dans `apps/api/src` | **Membres morts** (la même famille que les déclencheurs sans émetteur) |
| Il faut un système de versions des consignes | La consolidation refuse d'appliquer une proposition dont l'empreinte a bougé (`routes/learning.ts:491-499`, `consolidation.fingerprint`) ; une proposition acceptée est une ligne conservée | **Faux négatif** : la proposition, qui porte `before`/`after` et l'empreinte, *est* l'historique |
| Il faut une nouvelle boîte de réception | `advisor_proposals` + `AdvisorCard` + `system_proposals`/`system_proposal_decide` existent ; ce qui *agit* à l'acceptation y va (loi 2) | Réutiliser ; ajouter un genre |
| Il faut une bibliothèque de diff | `components/transcript/DiffView.tsx` rend un diff unifié ; `lib/markdown.ts:260` le parse ; aucun producteur côté API (pas de paquet `diff`) | Un producteur de diff unifié par lignes (LCS, ~60 lignes, testé) à écrire côté API |
| Les appels de modèle de fond ont un gabarit | `learning/structured-call.ts` : haiku, 3 tours, 120 s, sans outil, `withLanguage` ; bancs `scripts/eval-memory-gate.mjs` | Réutiliser tel quel |
| Une passe de fond doit marquer qu'elle a tourné | `runs.reflected_at` (migration 25) et son docteur ; `advisor_state` | Même discipline : une ligne par revue, même vide |
| L'intendant pourrait accepter une proposition | `steward.proposalDecide` accepte tout genre (ring 2, car un skill accepté est créé *désactivé*) | Une révision appliquée est *vivante* : **refus explicite** pour ce genre (§ 4, A7) |

### 1.4 Biais traqués

- **Faux positif principal** : croire que « le conseiller le fait déjà ». Il ne
  lit pas les transcriptions, ne peut pas viser un existant, et tourne en run
  agentique sur le modèle par défaut du workspace (opus en prod, 40 runs sur
  63) — non bornable et non bancable.
- **Faux négatif principal** : réinventer un registre de propositions, un
  versioning, une file de revue, un diff côté web. Tout existe.
- **Biais de mesure** : conclure « rien ne marche mal » de `0 failed`. Les
  transcriptions montrent des outils en erreur (`calendar_list_events` 2/10,
  `advisor_propose_agent` 1/1, `system_insight_status` 1/2) et une
  interruption ; le signal est qualitatif.

---

## 2. Ce que la production dit (2026-09-10, lecture seule)

Sonde : `probe-learning.mjs` (scratchpad), quarante requêtes `SELECT`,
validées sur la base locale puis rejouées sur la prod en une session SSH.

| Mesure | Valeur |
|---|---|
| Workspaces | 4 (`metaclaude`, `journaliste`, `personnel`, `test`), tous `dontAsk`, réflexion et mémoire actives, `advisorAuto` off partout |
| `systemPromptAppend` | 6 656 car. (journaliste), 529, 453, 0 |
| Runs | 63 sur 8 jours (61 la première semaine), 62 réussis, 1 interrompu, **0 échoué** ; coût 17,2 $ |
| Déclencheurs | user 44 · loop 10 · api 7 · automation 1 · system 1 |
| Catégories | chat 31 · review 19 · research 8 · debug 2 · autres 3 |
| Notes de l'opérateur | **2** runs notés (1 ↑, 1 ↓) |
| Politique | explicit 42 · learned 21 ; servis : opus 40 (13,3 $), haiku 13, sonnet 8, opus[1m] 2 |
| Skills | 5 activés (1 auto-généré, 1 global) ; `use_count` = 0 partout ; **0 appel `Skill`** dans 173 appels d'outil |
| Sous-agents | 5 activés ; **0 appel `Task`, 0 événement `subagent`**, 0 session avec agent principal |
| Automatisations | 6, toutes actives et continues : Morning review (6 runs), Recherche IA et LLM (9), Revue hebdomadaire (2), Alerte échec ×3 (1) |
| Insights | lesson 15 acceptés / 26 rejetés ; failure 2 rejetés ; consolidation 22 (pré-rejetés) ; skill_proposal 1 appliqué |
| Verdicts de la porte | 82 décisions : kept 18, skipped 38, forgotten 15, over-budget 11 ; niveaux : lesson 26, state 25, redundant 14, fact 9, preference 4, episodic 4 |
| Conseiller | 4 demandes, 3 acceptations, 1 rejet |
| Mémoires | 27 lignes dont 26 vivantes (4 standing globales épinglées) ; 155 rappels sur 63 runs |
| Transcriptions | 7 événements et 10 ko par run en moyenne (max 16 / 46 ko) ; 0,5 Mo au total |
| Audit opérateur | skill.update 86 · workspace.update 55 · agent.update 44 · insight.rejected 38 · skill.delete 31 · automation.update 29 · insight.accepted 23 |

Conséquences de conception, chacune tirée d'une ligne du tableau :

1. **Le volume est petit** (≈ 60 runs/semaine, 2 à 34 par workspace). Toute
   « récurrence » se juge à n ≈ 10–30 ; les seuils s'expriment en runs
   distincts *et* en jours distincts, et « pas assez d'évidence » est la
   réponse ordinaire.
2. **Les notes n'existent pas** (2/63) et la récompense inférée est plate
   (0,70–0,78, tout réussit). L'évidence vient des transcriptions et de
   l'usage, pas d'un scalaire.
3. **La non-utilisation est le premier défaut à faire remonter** : dix
   extensions montées, zéro invocation. Une description qui ne déclenche
   jamais est un poids mort dans chaque préfixe ; le système doit le voir et
   proposer une description-déclencheur, ou signaler la mise en veille.
4. **L'opérateur révise déjà à la main** (86 + 44 + 55 + 29 modifications) et
   triage les insights (61 décisions). Une proposition avec diff atterrit
   dans un usage réel, pas dans une file ignorée.
5. **Les transcriptions sont minuscules** : une revue lisant 30 à 40 runs
   tient dans 60–100 ko, soit un appel haiku de quelques centimes. Le coût
   n'est pas le sujet ; le bornage l'est quand même (croissance, quota).
6. **Les automatisations sont la seule source de statistiques honnêtes**
   (même prompt, 9 exécutions) — argument pour Q1.

---

## 3. Architecture cible

### 3.1 Trois approches, une retenue

- **A — Étendre le run du conseiller** : lui donner les transcriptions et un
  outil de révision. Rejeté comme mécanisme principal : run agentique non
  borné (opus par défaut, `WebSearch` possible), non bancable, dossier
  aujourd'hui limité à des premières lignes, et une seule autonomie pour
  tout. Conservé comme *voie de dépôt* : l'outil `advisor_propose_revision`
  sert aussi au conseiller et à l'intendant quand une personne leur demande
  une relecture.
- **B — Une passe structurée, comme la porte et la consolidation** :
  instrumentation déterministe, fenêtre d'évidence, observations en code,
  arbitre sans outil à schéma, règles après le modèle, banc. **Retenue** :
  c'est le gabarit que le dépôt a mesuré trois fois (`gatekeeper`,
  `consolidation`, `synthesis`), et le seul où « ne pas sur-réagir » est une
  propriété du code.
- **C — À chaque run, dans la réflexion** : rejetée, sur-réaction par
  construction (un run n'est pas une évidence, `LEARNING.md`).

### 3.2 Le principe

> Les faits en code, le jugement à un modèle borné, la décision à une
> personne, et une ligne qui dit que la passe a tourné.

Quatre boucles au lieu de trois (`docs/LEARNING.md` gagne une section
« Loop 4 — Revision: are the instructions right? ») :

| Boucle | Échelle | Ce qui change |
|---|---|---|
| Mémoire | heures–mois | le contexte injecté |
| Politique | dizaines de runs | modèle et effort |
| Réflexion | un run | ce qui est retenu |
| **Révision** | **une fenêtre de runs par workspace (semaine)** | **les consignes, sur acceptation** |

### 3.3 Les composants

**(a) Instrumentation par run — `run_extension_usages`.** Écrite à la fin de
chaque run, sans modèle, depuis deux sources déjà en main : la liste des
extensions *disponibles* (skills matérialisés, `registry.resolve(workspace)`
pour les agents) et la transcription (`tool_call` `Skill`, `tool_call` `Task`
avec `subagent_type`, événements `subagent` et leur statut). Une ligne par
(run, genre, extension) avec `available`, `invoked`, `failed`. Même forme que
`memory_usages` et `document_usages`, même cascade sur `runs`. C'est ce qui
rend calculable « disponible dans N runs, jamais invoqué » et « invoqué, en
erreur k fois sur n », et ce qui alimente enfin `skills.use_count`
(incrément à la fin du run, un seul écrivain ; les statistiques de fenêtre se
dérivent de la table, pas de la colonne — voir A5).

**(b) La fenêtre d'évidence.** Par workspace : les runs finis depuis
`reviewed_through_at` (curseur dans `revision_state`), au plus
`WINDOW_MAX_RUNS`, groupés **par session et dans l'ordre** — le prompt du run
suivant d'une session *est* la réaction de l'opérateur à la réponse
précédente, ce qui donne le signal « correction » sans heuristique lexicale.
Chaque run est résumé par une projection bornée (`RUN_EXCERPT`), bâtie sur
`transcript-view.ts` (`finalAnswer`, `toolsCalled`) et sur la forme de
`buildTranscriptSummary` : prompt, catégorie, statut, outils et erreurs,
extensions disponibles/invoquées, extrait de la réponse, coût, tours, durée,
mémoires injectées, verdicts de porte (`redundant` = « l'assistant redit ses
consignes »).

**(c) Les observations déterministes — sans modèle.** Calculées en code sur la
fenêtre, avec leurs seuils, avant tout appel :

| Clé | Règle | Ce qu'elle nourrit |
|---|---|---|
| `unused-extension` | extension disponible dans ≥ `OBSERVATION_MIN_RUNS` runs *pertinents* (cosinus description ↔ prompt ≥ plancher dense du profil, `retrievalProfile(family)`) sur ≥ `OBSERVATION_MIN_DAYS` jours, jamais invoquée | révision de la description (condition de déclenchement) ou signal « à mettre en veille » |
| `extension-errors` | sous-agent invoqué ≥ 3 fois, ≥ 50 % en `error` | révision du prompt de l'agent |
| `tool-errors` | même outil en erreur dans ≥ 3 runs sur ≥ 2 jours | contexte pour l'arbitre (consigne manquante sur l'outil) |
| `automation-drift` | même automatisation : tours ou coût p95 > 2 × médiane, ou ≥ 2 interruptions | révision du prompt de l'automatisation (Q1) |
| `instructions-oversize` | `systemPromptAppend` > 70 % du plafond, ou étagère standing tronquée | signal de compaction |

Sous la famille `hash`, le cosinus ne porte pas de sens (`LEARNING.md`,
Embeddings) : `unused-extension` passe en mode « faible » (≥ 15 runs
disponibles, aucun invoqué) et le dit dans la ligne de revue.

**(d) L'arbitre — un appel sans outil, à schéma.** `structuredCall` avec
`withLanguage`, prompt système propre à la révision, entrée = les cibles
(texte entier jusqu'à `TARGET_MAX_CHARS`, sinon **exclues de la révision** :
un modèle ne décide que de ce qu'on lui montre, règle `ARBITER_EXCERPT`) +
la fenêtre résumée + les observations + les propositions déjà rejetées.
Sortie :

```
{ findings: [{ key, targetRef, kind, summary, runIds[], confidence }],
  revisions: [{ targetRef, field, after, rationale, findingKeys[] }] }
```

Deux étages, décidés par le banc du lot 3 : un **criblage** (haiku) qui
répond « rien » ou « ceci récidive », puis une **rédaction** (haiku ou sonnet
selon le banc) uniquement quand le criblage a trouvé. Un appel qui répond
« rien » coûte ce qu'il coûte au premier tour.

**(e) Les garde-fous contre la sur-réaction — en code, après le modèle.**

| Règle | Où | Pourquoi |
|---|---|---|
| Une révision cite ≥ 1 observation ou constat dont les `runIds` sont **dans la fenêtre** (les inconnus sont retirés ; sous le plancher, la révision tombe, motif journalisé) | code | la porte n'accepte qu'un voisin *montré* — même discipline |
| Un constat vaut à partir de `OBSERVATION_MIN_RUNS` runs distincts sur `OBSERVATION_MIN_DAYS` jours (ou sessions) distincts | code | un cas isolé ne devient jamais une proposition |
| Une seule proposition **en attente** par cible ; refroidissement `TARGET_COOLDOWN_DAYS` après un rejet, `TARGET_MIN_INTERVAL_DAYS` après toute proposition | `revision_targets` | ne pas harceler |
| Une clé de constat rejetée n'est pas re-proposée pendant le refroidissement, et l'arbitre voit la liste des rejets | code + prompt | l'opérateur a déjà répondu |
| Au plus `PROPOSALS_PER_REVIEW` par revue ; `after ≠ before` ; longueurs dans les schémas existants ; `REVISION_MAX_CHANGED_RATIO` de lignes changées, sinon « proposer plus petit » | code | une révision est minimale, jamais une réécriture |
| Empreinte de la cible au moment de la proposition ; l'application refuse si elle a bougé (409) | code | motif `consolidation` |
| Fenêtre ouverte seulement à `REVIEW_MIN_RUNS` runs nouveaux **et** `REVIEW_MIN_DAYS` depuis la dernière revue | `sweep` | ni trop tôt ni sur trois runs |
| Banc `scripts/eval-instruction-review.mjs` : corpus étiqueté de fenêtres (synthétiques ou expurgées), plafond de fausses propositions sur la pire passe | script | ce que le prompt n'a pas le droit d'aggraver |

**(f) La proposition — genre `revision` dans `advisor_proposals`.** Payload
validé deux fois (dépôt et acceptation, comme les autres genres) :

```
RevisionPayload = {
  target: { kind: 'workspace'|'skill'|'agent'|'automation', id, name, scope: 'workspace'|'global' },
  field: 'systemPromptAppend'|'description'|'body'|'prompt',
  before, after, beforeFingerprint, diff,          // diff unifié, produit côté API
  evidence: [{ runId, sessionId, workspaceId, note }],
  findings: [{ key, kind, summary, runIds }],
  reviewId
}
```

`accept` applique par les services existants — `workspaceRepo.update`
(après `systemWorkspace.guard`), `registry.upsertSkill({ id, … })` /
`upsertAgent({ id, … })` (la portée n'est pas touchée), `scheduler.update` —
avec une ligne d'audit `revision.apply` nommant la cible et le champ.
`dismiss` pose le refroidissement. **`revert`** (nouveau) ré-applique `before`
si l'empreinte courante est celle d'`after` ; sinon 409 « modifié depuis ».

**(g) Le suivi — la boucle se ferme.** À la revue suivante, pour chaque
révision appliquée dans la fenêtre précédente, le code recalcule le constat
qui l'avait motivée (déterministe quand il l'était, sinon demandé à
l'arbitre) et écrit `followUp: { windowRuns, recurred }` sur la proposition.
Une révision dont le constat récidive est une évidence pour `revert`, montrée
telle quelle. C'est ce qui répond littéralement à « ce qui fonctionne et ce
qui ne fonctionne pas » : le système juge aussi ses propres révisions.

**(h) Planification, quota, coût.** Balayage horaire (`setInterval`, `unref`,
comme `advisor.sweep`), gate hebdomadaire par workspace, opt-in
`settings.improvementAuto` (défaut `false`, même raison qu'`advisorAuto` :
une décision, pas une découverte), une revue en vol à la fois, saut silencieux
si `quota.utilization(workspace.path)` dépasse le seuil de l'autopilote
(ouvert sur `null`, `board-autopilot.ts:126-128`). Déclenchement manuel par
route et bouton (Mémoire → « Revoir les consignes », à côté de « Distiller un
skill »). Ordre de grandeur : ≤ 100 ko de prompt, haiku, ≤ 0,05 $ par revue ;
quatre workspaces par semaine < 1 $/mois contre 17 $/semaine de runs. La
directive de langue suit `learning/language.ts`.

**(i) « Enregistrer que la passe a tourné » — `revision_reviews`.** Une ligne
par revue : workspace, fenêtre, runs examinés, observations, constats,
propositions déposées, révisions écartées et pourquoi, modèle, durée. Le
docteur (`improvement`) lit la table ; le brief compte les propositions en
attente ; la page Mémoire affiche « Dernière revue : il y a 3 jours, 12 runs,
rien à changer ». Sans cette ligne, quatre issues seraient indiscernables
(fenêtre pas prête, rien trouvé, tout écarté par les règles, appel mort) —
exactement le piège de `reflected_at`.

**(j) Les surfaces.**

- *Tableau de bord* : `AdvisorCard` rend une proposition `revision` avec une
  carte dédiée — badge de cible, portée (avertissement si globale : la
  révision touche tous les workspaces, comme « Make global »), résumé,
  `DiffView` repliable, preuves cliquables (`routes.session(...)`, texte nu si
  le run a été purgé), Accepter / Rejeter ; une section repliable
  « Révisions appliquées » avec Annuler et le suivi.
- *Mémoire* : bouton « Revoir les consignes » (workspace sélectionné) ; toast
  avec l'issue et un lien vers le tableau de bord ; ligne « Dernière revue ».
- *Réglages du workspace → Autonomie* : interrupteur `improvementAuto` sous
  celui du conseiller.
- *Agents & skills* : `useCount` devient vrai ; rien d'autre.
- *Intendant* : `system_proposals` liste les révisions ; `system_proposal_decide`
  refuse `accept` sur ce genre et le dit ; `advisor_propose_revision` est
  pré-approuvé par l'union existante (`context.ts:572`).
- *Notifications* : `SYSTEM_TOPIC` « N révisions proposées » avec lien.

### 3.4 Frontières explicites

- **Règle de l'opérateur ≠ révision de consigne.** Une convention que
  l'opérateur énonce va sur l'étagère *standing* par la porte mémoire (chemin
  existant). L'arbitre en est informé et ne propose jamais d'ajouter au
  prompt une règle déjà sur l'étagère : ce serait le second registre que
  `metaclaude_memory` a été écrit pour empêcher.
- **Modèle et effort ne sont pas des consignes.** Le coût par modèle est donné
  en contexte ; une révision ne cible que du texte. Le bandit et les réglages
  gardent leur domaine.
- **Jamais de cible générée ou tierce** : `CLAUDE.md`, `NOTES.md`, skills de
  plugins. Une copie de la bibliothèque installée dans le registre est une
  cible (elle appartient à l'opérateur).
- **Aucune application automatique**, ni par le balayage ni par l'intendant.

---

## 4. Arbitrages majeurs

- **A1 — Une passe structurée, pas un agent** (§ 3.1). Bornée, bancable,
  quelques centimes ; le run agentique reste une voie de dépôt.
- **A2 — Les faits avant le modèle.** Les observations à seuils sont
  calculées en code et transmises chiffrées ; le modèle n'a pas à « sentir »
  une récurrence. Motif mesuré par la porte : les règles structurelles ont
  divisé les fausses conservations par deux quand le prompt seul n'y
  arrivait pas.
- **A3 — Réutiliser `advisor_proposals`, pas `insights`.** Une révision agit
  à l'acceptation ; c'est la définition de la boîte de réception
  (`advisor.ts:1-24`). Les insights restent « ce qui a été appris ».
- **A4 — La proposition est l'historique.** `before`, `after`, empreinte et
  `revert` suffisent ; pas de table de versions (YAGNI, et motif
  consolidation).
- **A5 — `use_count` reste un compteur à vie, incrémenté en fin de run ; les
  statistiques de fenêtre viennent de `run_extension_usages`.** La rétention
  purge les runs, donc un dérivé *décroîtrait* ; un compteur monotone à
  écrivain unique est honnête. Les agents n'ont pas de colonne : la table
  répond (pas de valeur dérivée stockée en plus).
- **A6 — Le diff est produit côté API** et stocké dans le payload : le web
  sait déjà rendre un diff unifié, et un payload qui porte son diff se rend
  hors ligne et sans dépendance.
- **A7 — L'intendant ne peut pas accepter une révision.** Une automatisation
  ou un skill accepté est créé désactivé ; une consigne révisée est en vigueur
  au run suivant. Le ring 2 est « réversible en un geste » : `revert` le rend
  vrai pour la personne, pas pour un run non surveillé.
- **A8 — Opt-in par workspace, défaut off**, cohérent avec `advisorAuto` ;
  le bouton manuel marche toujours.
- **A9 — Schéma du payload dans `api-contracts.ts`**, type importé côté web,
  garde de forme sans Zod à l'exécution (comme `RunGenesis`) : le chunk
  d'entrée ne bouge pas (ratchet `initialJsGzipKb` à 196).
- **A10 — Les cibles trop longues sont exclues de la révision, pas
  tronquées** (`TARGET_MAX_CHARS` = 12 000, au-dessus des 6 656 mesurés) :
  motif `ARBITER_EXCERPT`.
- **A11 — Constantes en code, pas de réglages d'exécution** au premier lot ;
  un bouton vaut mieux que cinq curseurs, et `retrievalProfile` montre où un
  nombre vit quand il est mesuré.

### Constantes proposées (toutes dans `learning/improvement.ts`, chacune avec sa mesure en commentaire)

| Constante | Valeur | Justification |
|---|---|---|
| `REVIEW_MIN_RUNS` | 8 | un workspace de prod produit 8 à 34 runs/semaine |
| `REVIEW_MIN_DAYS` | 7 | cadence hebdomadaire, cohérente avec les automatisations en place |
| `WINDOW_MAX_RUNS` | 40 | ≤ 100 ko de prompt à 1,8 ko par run et 12 ko par cible |
| `OBSERVATION_MIN_RUNS` / `_DAYS` | 3 / 2 | « ponctuel » = un run ou un jour |
| `PROPOSALS_PER_REVIEW` | 3 | « three that matter over ten that pad » (prompt du conseiller) |
| `TARGET_MIN_INTERVAL_DAYS` / `TARGET_COOLDOWN_DAYS` | 7 / 14 | une proposition par cible et par fenêtre ; un refus tient deux fenêtres |
| `REVISION_MAX_CHANGED_RATIO` | 0,4 | au-delà, c'est une réécriture |
| `RUN_EXCERPT` / `TARGET_MAX_CHARS` | 1 800 / 12 000 | § 2, conséquence 5 ; A10 |

---

## 5. Questions résiduelles (décisions métier)

- **Q1 — Les prompts d'automatisation sont-ils une cible ?** Recommandation :
  oui dès le lot 2. Même mécanisme, coût marginal faible, et c'est la seule
  cible avec une vraie statistique (9 exécutions d'un même prompt en prod).
- **Q2 — L'intendant peut-il rejeter une révision ?** Recommandation : oui
  (inerte), jamais accepter (A7).
- **Q3 — Une révision d'une cible globale exige-t-elle une évidence dans
  ≥ 2 workspaces ?** Recommandation : non à ce volume (quatre workspaces) ;
  la carte affiche la portée et le workspace de l'évidence, et l'opérateur
  tranche.
- **Q4 — Cadence et seuils** : les constantes du § 4 sont proposées ; un
  réglage d'exécution ne viendra que si l'usage le demande (A11).

Aucune de ces questions ne bloque le lot 0 ni le lot 1.

---

## 6. Cartographie des impacts

### 6.1 Base de données (migrations, en ajout seulement, `db/schema.sql.ts`)

- `run_extension_usages (run_id → runs ON DELETE CASCADE, kind, extension_id, name, available, invoked, failed, PRIMARY KEY (run_id, kind, extension_id))`, index `(kind, extension_id)`.
- `revision_state (workspace_id PK → workspaces CASCADE, reviewed_through_at, last_review_at, last_attempt_at)`.
- `revision_targets (kind, target_id, workspace_id, last_proposed_at, last_dismissed_at, dismissed_keys TEXT, PRIMARY KEY (kind, target_id))`.
- `revision_reviews (id PK, workspace_id → CASCADE, at, window_from, window_to, runs_examined, observations TEXT, findings TEXT, proposed, dropped TEXT, model, duration_ms)`, index `(workspace_id, at DESC)`.
- `advisor_proposals` inchangée (le genre est validé en code ; pas de `CHECK`).
- Rétention : `revision_reviews` purgée par le janitor au même horizon que les insights ; `run_extension_usages` suit la cascade des runs.

### 6.2 Contrats (`packages/shared`)

- `WorkspaceSettings.improvementAuto: z.boolean().default(false)` (`domain.ts`) — le défaut porte la décision pour les lignes existantes, comme `delegable`.
- `AdvisorProposalKind` + `'revision'` ; `RevisionPayload`, `RevisionReview`, `RevisionFollowUp` dans `api-contracts.ts` ; `SkillDefinition.useCount` inchangé mais vrai.
- `routes.ts` : aucune URL nouvelle côté web (le tableau de bord et Mémoire existent).

### 6.3 API (`apps/api/src`)

| Fichier | Changement |
|---|---|
| `kernel/kernel.ts` (`learn`) | après la réflexion : écrire `run_extension_usages` (disponibles + invoqués depuis la transcription), incrémenter `skills.use_count` |
| `learning/extension-usage.ts` (nouveau) | extraction pure : événements → usages ; fixture bâtie sur la capture du lot 0 |
| `learning/improvement.ts` (nouveau) | fenêtre, observations, arbitre (`invoke` injectable), règles, `review(workspaceId)`, `sweep()`, suivi |
| `learning/unified-diff.ts` (nouveau) | diff unifié par lignes (LCS), pur, testé |
| `services/advisor.ts` | `PAYLOADS.revision`, `propose` sans le conflit de nom pour ce genre, `accept` qui applique, `dismiss` qui refroidit, `revert`, `listHistory` |
| `kernel/advisor-tools.ts` | `advisor_propose_revision` (ring 2) + catalogue |
| `services/steward.ts` | `proposalDecide` refuse `accept` sur `revision` |
| `routes/advisor.ts` | `POST …/revert`, `GET …?status=accepted&kind=revision` |
| `routes/learning.ts` | `POST /api/workspaces/:id/review-instructions` (202/204, garde en vol), `GET /api/workspaces/:id/revision-reviews` |
| `routes/workspaces.ts` | rien : `improvementAuto` passe par `patchSchema(WorkspaceSettings)` |
| `services/doctor.ts` | contrôle `improvement` (revues en retard, extensions mortes) |
| `services/brief.ts` | compte des révisions en attente |
| `context.ts` | câblage, balayage horaire, `readOnlyRun` inchangé |
| `janitor.ts` | purge de `revision_reviews` |

### 6.4 Web (`apps/web/src`)

| Fichier | Changement |
|---|---|
| `components/dashboard/RevisionProposalCard.tsx` (nouveau) | carte avec `DiffView`, preuves, verbes ; classes de contrat mobile |
| `components/dashboard/AdvisorCard.tsx` | branche sur le genre ; `KIND_LABELS` exhaustif force la mise à jour ; section « appliquées » |
| `pages/MemoryPage.tsx` | bouton « Review the instructions », ligne « Dernière revue » |
| `components/workspace/WorkspaceSettingsModal.tsx` | interrupteur Autonomie |
| `lib/api.ts` | 4 méthodes (toutes appelées, ratchet `uncalledClientMethods`) |
| `locales/fr.ts` | chaque chaîne nouvelle, `plural()` pour les comptes |

### 6.5 LLM, jetons, quotas

- Un appel de fond par revue (deux si rédaction), haiku par défaut, sans outil, 120 s, 3 tours ; sous abonnement il consomme la fenêtre commune : saut si le quota est haut (§ 3.3 h).
- Une révision de `systemPromptAppend` acceptée **réécrit le préfixe en cache** de chaque session à son run suivant (mesuré : ×70 d'écriture de cache une fois). La carte le dit ; c'est le même coût qu'une édition manuelle.
- Le prompt de l'arbitre est borné par construction (`WINDOW_MAX_RUNS`, `RUN_EXCERPT`, `TARGET_MAX_CHARS`) : ≤ 100 ko.

### 6.6 Documentation et gardes

- `docs/LEARNING.md` (boucle 4, chiffres de prod), `docs/ARCHITECTURE.md`
  (section conseiller), `docs/guide/04`, `07`, `11`, `docs/SECURITY.md`
  (texte écrit par un modèle, lu avant acceptation ; l'intendant n'applique
  pas), `CHANGELOG.md` dans `[Unreleased]`.
- Ratchets : `tests`/`testFiles` montent (`--update`), i18n à zéro,
  `deadImports` 0, `defaultingPartials` 0, `hardcodedRoutes` 0,
  `uncalledClientMethods` ne monte pas. Aucun plafond n'est desserré.
- `check.sh` : les nouveaux écrans cités dans le guide existent (Mémoire,
  Tableau de bord, Réglages du workspace) ; aucune variable d'environnement
  nouvelle.

---

## 7. Matrice des risques

| Risque | Prob. | Impact | Mitigation | Preuve |
|---|---|---|---|---|
| Sur-réaction : proposition sur un cas isolé | moyenne | forte (confiance perdue) | seuils, refroidissements, une par cible, banc à plafond | tests unitaires des règles ; banc avec fenêtres « rien à changer » |
| Injection par transcription → texte de révision | faible | forte | jamais d'application automatique ; intendant refusé ; diff lu ; plafonds de taille | test `steward` ; test « runIds hors fenêtre écartés » |
| Révision d'une cible globale sur l'évidence d'un workspace | moyenne | moyenne | badge de portée + workspace d'évidence ; Q3 | test composant |
| Forme du fil `Skill` supposée | certaine si non mesurée | forte (usage jamais vu) | capture `sdk-probe` en lot 0, fixture depuis la capture | e2e : un run avec un skill nommé dans le prompt produit une ligne d'usage |
| Cible modifiée entre proposition et acceptation | moyenne | faible | empreinte, 409 | test route |
| Runs purgés par la rétention → preuves mortes | certaine à terme | faible | carte dégradée ; suivi calculé sur la fenêtre courante seulement | test composant « run purgé » |
| Famille `hash` : « non utilisé » sans pertinence | faible (bge-m3 en prod) | moyenne | mode faible et mention dans la revue | test avec profil `hash` |
| Deux revues en vol | faible | faible | drapeau en vol (motif catch-up) | test route 409 |
| Boucle serrée sur un appel mort | faible | moyenne | `last_attempt_at`, pas de retry avant le prochain balayage | test `sweep` |
| Chunk d'entrée alourdi | faible | moyenne | schéma en `api-contracts.ts` (A9) | ratchet |
| Corpus de banc avec données personnelles | certaine si copié de prod | forte (dépôt public) | corpus synthétique/expurgé, revu | relecture |
| `pnpm verify` rouge sous Windows par charge | connue | nulle | `--workspace-concurrency=1` (fiche mémoire) | — |

---

## 8. Cas limites à éprouver

Nominaux : fenêtre prête et revue vide ; fenêtre avec un constat et une
révision ; acceptation puis suivi « n'a pas récidivé » ; rejet puis
refroidissement.

Alternatifs et dégradés : workspace sans run ; moins de `REVIEW_MIN_RUNS`
runs ; runs tous d'une même session le même jour (≥ 3 runs, 1 jour → aucun
constat) ; cible plus longue que `TARGET_MAX_CHARS` (observée, jamais révisée) ;
arbitre qui cite un run absent, une cible absente, un `after` identique, une
réécriture entière ; appel mort ou JSON illisible (revue enregistrée
`failed`, rien proposé, curseur non avancé) ; timeout ; quota haut (saut
journalisé) ; famille `hash` ; langue `auto` ; workspace système (append
autorisé, `guard` conservé) ; skill global vs attaché ; skill de plugin (jamais
cible) ; cible supprimée avant acceptation (409) ; `revert` après une édition
manuelle (409) ; deux acceptations concurrentes (la seconde 409 par
statut, motif `decide … WHERE status = 'pending'`) ; intendant qui tente
`accept` ; run purgé dans les preuves ; proposition rejetée dont la clé
revient dans la fenêtre suivante (supprimée) ; `Task` sans `subagent_type`
(agent générique, non attribué) ; sous-agent `error` puis `ok` dans le même
run ; automatisation continue (même session) ; balayage pendant une revue
manuelle.

---

## 9. Plan de test directeur (socle TDD)

Chaque test nouveau est prouvé rouge avant vert (sabotage de la ligne
couverte). Les tests ne lancent jamais le CLI ; le banc, oui.

| Niveau | Fichier | Ce qui est tenu |
|---|---|---|
| TU | `learning/extension-usage.test.ts` | extraction depuis une fixture *capturée* ; `Task` avec/sans type ; `subagent` ok/error ; disponibles sans invocation ; skill de plugin ignoré |
| TU | `learning/unified-diff.test.ts` | ajout, suppression, remplacement, vide, sans fin de ligne ; re-parsable par `parseDiff` (test partagé lisant `lib/markdown.ts` depuis le web) |
| TU | `learning/improvement.test.ts` | fenêtre (curseur, plafond, groupement par session) ; chaque observation à son seuil, un run/jour sous le seuil ; profil `hash` ; règles après modèle (runIds inconnus, cible absente, `after` identique, ratio, cap, refroidissement, clé rejetée) ; `sweep` (opt-in, min runs, min jours, quota, en vol, `last_attempt_at`) ; suivi `recurred` ; ligne de revue écrite dans **tous** les cas |
| TU | `services/advisor.test.ts` | `propose` révision sans conflit de nom ; `accept` applique par cible (workspace, skill avec portée conservée, agent, automatisation) ; `dismiss` refroidit ; `revert` (ok, 409 empreinte) ; payload invalide refusé au dépôt et à l'acceptation |
| TU | `services/steward.test.ts`, `kernel/system-tools.test.ts` | `accept` refusé sur `revision`, `dismiss` permis ; catalogue = serveur ; pré-approbation contient le nouvel outil |
| TU | `kernel/tool-forwarding.test.ts` | dérivé du schéma de `advisor_propose_revision` : chaque champ atteint la façade, chaque optionnel retiré à son tour |
| TU | `kernel/kernel.test.ts` | `learn` écrit `run_extension_usages` et incrémente `use_count` une fois ; un run interrompu n'écrit pas d'invocation fantôme |
| TU | `services/doctor.test.ts`, `services/brief.test.ts` | contrôle `improvement` ; compte des révisions |
| Contrat | `packages/shared/src/domain.test.ts` | `improvementAuto` par défaut ; `patchSchema` ne réinjecte pas les défauts ; `RevisionPayload` refuse `after` hors plafond du champ |
| Intégration (harness) | `routes/advisor.test.ts`, `routes/revision-review.test.ts` | 202/204, 409 en vol, `revert`, historique ; corps drainés (leçon `server-harness`) |
| Web | `RevisionProposalCard.test.tsx` | diff rendu, preuves liées et « run purgé », verbes, `aria-label`, contrat de classes du rang de boutons (`grid grid-cols-2 sm:flex`), portée globale signalée |
| Web | `AdvisorCard.test.tsx`, `MemoryPage.test.tsx`, `WorkspaceSettingsModal.test.tsx` | branche par genre ; bouton et toast ; interrupteur envoyé et rond-trip inchangé |
| Web | `lib/api.test.ts` | pas de double sérialisation |
| Banc (manuel) | `scripts/eval-instruction-review.mjs` + `instruction-review-corpus.json` | trois passes, pire passe : zéro proposition sur les fenêtres « rien », rappel des fenêtres étiquetées ; comparaison haiku/sonnet |
| e2e (manuel) | `scripts/e2e.mjs` | un run avec un skill nommé dans le prompt → une ligne d'usage invoquée ; un run avec sous-agent → statut attribué |

Simulations à préparer avant le lot 3 : générateur de fenêtres synthétiques
(N runs, S sessions, D jours, constats injectés) pour saboter chaque seuil
et voir la proposition apparaître puis disparaître.

---

## 10. Plan d'actions séquencé

Chaque lot : tests d'abord et prouvés rouges, code, `pnpm typecheck`,
`pnpm -r --workspace-concurrency=1 test:run`, `pnpm build`,
`node deploy/ratchets.mjs --update`, entrée `[Unreleased]`, bump `minor` au
premier lot visible.

- **Lot 0 — La vérité de l'usage (aucun appel de modèle).** Capture de la
  forme du fil `Skill`/`Task` avec `sdk-probe.mjs` (prompt qui nomme le skill,
  `process.platform` noté) ; `learning/extension-usage.ts` ; migration
  `run_extension_usages` ; écriture en fin de run ; `use_count` incrémenté ;
  Agents & skills et intendant affichent un chiffre vrai ; docteur
  « extensions mortes » (disponibles dans ≥ 20 runs, jamais invoquées —
  un compte brut, sans notion de pertinence, valable sous toute famille
  d'embeddings).
  Valeur seule : un compteur qui ment cesse de mentir, et la prod dit combien
  d'extensions ne servent jamais.
- **Lot 1 — Le registre des révisions.** Contrats (`RevisionPayload`, genre),
  `unified-diff.ts`, `AdvisorService.proposeRevision/accept/dismiss/revert`,
  refus de l'intendant, routes, audit, `advisor_propose_revision` + catalogue +
  `tool-forwarding`. Après ce lot, une personne peut demander à l'intendant
  ou au conseiller « relis ce skill » et recevoir un diff à accepter.
- **Lot 2 — La fenêtre et les observations (déterministes).**
  `revision_state`, `revision_targets`, `revision_reviews` ; fenêtre ;
  observations à seuils ; `GET …/revision-reviews` ; ligne « Dernière revue ».
  Toujours aucun appel de modèle ; les constats déterministes apparaissent
  dans la revue.
- **Lot 3 — L'arbitre et ses garde-fous.** Prompt, schéma, criblage +
  rédaction, règles après modèle, `review()` manuel (route, bouton, toast),
  `sweep()` opt-in + quota + en vol, notification, suivi `followUp`, banc +
  corpus, choix du modèle mesuré.
- **Lot 4 — Les surfaces.** `RevisionProposalCard`, `AdvisorCard`,
  historique et `revert`, interrupteur Autonomie, `fr.ts`, contrats mobiles,
  capture `shots.mjs` avant/après regardée une fois.
- **Lot 5 — Le système se décrit.** `LEARNING.md` boucle 4 avec les chiffres,
  `ARCHITECTURE.md`, guides 04/07/11, `SECURITY.md`, docteur et brief
  finalisés, `check.sh` vert sur les sections documentaires.

Hors lot, à noter dans le journal : les genres `pattern` et `preference`
d'`Insight` n'ont pas d'émetteur ; à retirer ou à émettre, décision séparée.

---

## 11. Grille d'auto-évaluation

- **Complétude et robustesse.** Chaque brique nommée existe et a été lue à la
  ligne ; chaque manque a été prouvé par le code (conflit de nom du
  conseiller, colonne morte, membres d'énumération sans émetteur) et non
  supposé. La seule inconnue restante — la forme exacte d'un appel `Skill`
  sur le fil — est identifiée, avec son instrument et sa place (lot 0), et
  ne bloque aucune décision de conception. Oui, l'analyse est jugée
  complète, viable et sans zone de flou bloquante.
- **Hypothèses confrontées au code réel.** Douze hypothèses, douze
  vérifications citées (§ 1.3) ; les mesures du § 2 viennent de la base de
  prod réelle, en lecture seule, par une sonde validée d'abord en local.
- **Jetons, coûts, quotas, registres, mobile.** Bornes explicites du prompt
  et du nombre d'appels, garde de quota réutilisée, coût de cache d'une
  révision d'append nommé ; quatre tables en ajout seulement avec cascade et
  rétention ; schéma hors du chunk d'entrée ; contrats de classes mobiles et
  `aria-label` prévus et testés.
- **Prêt à démarrer.** Le lot 0 est spécifié fichier par fichier avec ses
  tests ; les lots suivants dépendent de lui dans l'ordre donné et d'aucune
  question résiduelle. Le plan d'implémentation détaillé (par tâche, TDD)
  s'écrit à l'approbation de ce document.

---

## 12. Ce qui a été livré, et ce qui a changé en chemin

Livré le 2026-09-10 en v0.91.0. Le plan des six lots a été tenu dans l'ordre.
**Cinq décisions de ce document ont été renversées par la mesure ou par le
code** ; elles sont ici pour qu'on ne les rejoue pas.

1. **Pas de test de pertinence pour « extension jamais utilisée » (§ 3.3 c).**
   Le plan proposait un cosinus description ↔ prompt avec le plancher dense du
   profil. Écarté : chaque plancher de `retrieval.ts` est une *mesure de la
   recherche*, en réutiliser un pour une question jamais mesurée fait dire deux
   choses à un même nombre — et deux choses différentes sur deux déploiements,
   puisque la famille `hash` ne porte aucun sens. La règle est un comptage brut
   (`UNUSED_MIN_RUNS = 12` runs sur 2 jours), valable sous toute famille.
2. **Pas de table `revision_targets` (§ 6.1).** Le refroidissement se dérive de
   `advisor_proposals` : une ligne rejetée porte sa date, une révision annulée
   porte `revertedAt`. Une seconde table aurait été une copie stockée de ce que
   ces lignes disent déjà — le piège de la valeur dérivée qu'on range.
3. **`RevisionPayload` reste dans `api-contracts.ts` (§ 4, A9), et la carte ne
   le parse pas.** Le plan disait « schéma dans api-contracts, type importé
   côté web » ; la première implémentation a quand même appelé `safeParse` dans
   le navigateur, ce qui tire tout le module dans le chunk d'entrée : **196 ko
   gzip → 201**. La carte lit le payload par une garde de deux lignes, le
   serveur garde ses deux validations, et la carte elle-même est chargée à la
   demande (le diff est allé avec elle). Reste +1 ko, assumé et inscrit dans le
   ratchet.
4. **La règle « pas une réécriture » ne s'applique qu'au-dessus de six
   lignes.** Le ratio seul refusait le cas le plus utile de tous : transformer
   « Reviews migrations. » en condition de déclenchement fait 100 % du texte.
   Et `changedLineRatio` a été redéfini — il comptait une ligne remplacée deux
   fois, si bien qu'un même plafond voulait dire deux choses selon la forme de
   l'édition.
5. **Le banc n'a rien pu dire à trois passes.** Deux prompts très différents y
   étaient indiscernables et un sabotage ne bougeait pas le chiffre. À cinq
   passes sur dix fenêtres : cinq sur-réactions et un raté contre une et zéro.
   La conclusion honnête à trois passes était « ce banc ne sait pas trancher »,
   pas « les règles ne servent à rien ».

**Deux défauts d'ancien trouvés par la mesure**, tous deux invisibles parce que
rien n'échouait : l'outil de délégation s'appelle `Agent` et non `Task` (trois
endroits faux depuis quatre versions), et `skills.use_count` était affiché sur
deux écrans sans qu'aucun chemin de code ne l'incrémente.

**Question résiduelle Q1 tranchée : oui.** Les prompts d'automatisation sont
une cible, comme recommandé.

**Vérifications vivantes** (à rejouer après tout changement de la boucle) :
`cd apps/api && node scripts/e2e.mjs` → 97/97, dont un vrai run qui ouvre un
skill et dont l'usage est compté ; `node scripts/browser.mjs` → 27/27 ;
`node scripts/eval-instruction-review.mjs 5 haiku` → au pire une sur-réaction
et aucun raté.

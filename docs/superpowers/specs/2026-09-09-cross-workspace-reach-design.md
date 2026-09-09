# Portée inter-workspaces : ce qu'un run peut consulter, et à quel prix

Date : 2026-09-09 · Statut : analysé et mesuré, plan à valider avant implémentation

## 1. L'écart, mesuré en production

Le 2026-09-09, l'application LIA a interrogé Metaclaude par la passerelle MCP
(session `MCP: LIA`, workspace `metaclaude`) : « Quel est le nom de la femme de
Jérôme ? ». Réponse : « Je n'ai pas cette information. Rien dans ce que je peux
lire (CLAUDE.md, NOTES.md, mémoires, `system_overview`) ne mentionne l'épouse
de Jérôme. »

Ce que la base de production dit de ce run (lecture seule, sonde dans le
conteneur) :

| Fait | Mesure |
| --- | --- |
| Le fait demandé existe | mémoire `durable`, épinglée, confiance 1, workspace **`personnel`** : « Foyer de Jérôme : Hua Ni (épouse), Mathéo (fils), Yang (chatte) » |
| Ce que le token LIA atteint | `workspace_ids = [metaclaude]`, portées `run`+`read`, plafond `acceptEdits` |
| Outils appelés par les 4 runs de LIA | **zéro** — chaque run ne porte que `user_message`, `assistant_text`, `result` |
| Ce que le run a reçu en rappel | les seules mémoires *globales* (deux conventions `standing`) ; aucune mémoire d'un autre workspace |
| Coût des deux réponses « je ne sais pas » | 0,057 $ (haiku) et 0,152 $ (sonnet, préfixe de 37 658 tokens écrit en cache) |
| Délégations jamais faites | `runs.triggered_by = 'delegation'` : 0 ligne sur l'ensemble du déploiement |

Deux détails de cette réponse valent une ligne chacun : le modèle affirme avoir
lu `system_overview` alors qu'**aucun outil n'était monté** (la briefing sur
disque du workspace système lui dit d'y commencer, et le run `api` ne reçoit
pas ces outils — il a comblé l'écart par une phrase) ; et le rappel contenait
la convention globale « Déléguer : une question groupée, et la source nommée »,
injectée dans un run qui **n'a aucun moyen de déléguer**.

### Le rappel bon marché aurait répondu

Rejeu du corpus de prod (les 24 titres de mémoires, contenus des deux mémoires
familiales) dans le vrai `MemoryStore`, sous l'embedder de prod (`Xenova/bge-m3`,
révision épinglée, téléchargé pour la mesure) et sous le hachage :

| Question | Portée `metaclaude` (ce que le run a vu) | Portée « tous les workspaces » |
| --- | --- | --- |
| « Quel est le nom de la femme de Jérôme ? » | bge-m3 : rien · hash : 2 conventions hors sujet | bge-m3 : **Foyer de Jérôme… 1er** · hash : 2e (le frère, « sa femme », passe devant) |
| Le prompt complet de LIA (« L'utilisateur veut te tester : … ») | bge-m3 : 2 conventions · hash : 1 | bge-m3 : **1er** · hash : absent du top 5 (« L'utilisateur… » attire les mauvaises lignes) |
| « Comment s'appelle l'épouse de Jérôme ? » | rien | bge-m3 : **1er** · hash : **1er** |
| « Où habite le père de Jérôme ? » | rien | bge-m3 : 3e · hash : **1er** |

Conclusion de la mesure : sur l'embedder qui tourne en prod, une recherche
mémoire élargie aux autres workspaces trouve la réponse **au premier rang, sans
appel de modèle**. Sous le hachage, la requête doit être formulée (mot-clé
« épouse ») plutôt que collée telle quelle — ce qui plaide pour un *outil* que
l'agent appelle avec sa propre requête, et contre une injection automatique du
prompt brut (§ 4).

## 2. Pourquoi : quatre couches, chacune correcte seule

1. **Le rappel d'un run est « son workspace + le global », par construction.**
   `kernel.ts` (retrieve memory / knowledge) appelle les deux magasins avec
   `workspaceId: workspace.id` ; `memory.ts` traduit en
   `workspace_id = ? OR workspace_id IS NULL`, `knowledge.ts` en `reachClause`.
   C'est la séparation des projets, voulue et documentée (docs/LEARNING.md,
   « Retrieval unions them »). Aucune couche de rappel ne regarde ailleurs.
2. **Les seuls verbes inter-workspaces sont retirés aux runs `api`.**
   - `delegate` (superviseur, `delegationDirectory`) : `if (triggeredBy ===
     'delegation' || triggeredBy === 'api') return silent` — motif écrit :
     « la portée d'un token n'est pas une suggestion ».
   - `metaclaude_system` (les verbes du steward, dont `system_memory_search`
     sans workspace = *toute* la mémoire, et `system_run_ask`) : monté pour le
     workspace système **sauf** `api` et `delegation`.
   - `metaclaude_memory` (`memory_search`) : jamais monté pour le workspace
     système, et de toute façon borné au workspace du run.
   Un run démarré par la passerelle n'a donc **aucun** outil Metaclaude, quel que
   soit le workspace visé ; dans le workspace système il en a même *moins* que
   la briefing sur disque lui décrit.
3. **La passerelle elle-même ne sait pas chercher ailleurs.** `ask_workspace`
   et `start_run` visent un workspace ; `search_notes` ne couvre que la
   **bibliothèque** (jamais les mémoires) d'un workspace + le global. Le fait
   demandé est une mémoire : aucun outil de la passerelle ne pouvait le
   trouver, même avec un grant plus large.
4. **Le grant du token ne sert qu'à « puis-je démarrer ici »**. Un token qui
   nomme trois workspaces obtient trois agents étanches, pas un assistant qui
   les connaît tous. Rien dans le code ne dérive une *portée de consultation*
   du grant — et c'est la seule autorité qu'un run `api` possède.

Ce n'est pas un bug local : c'est l'absence d'une notion — *ce qu'un run a le
droit de consulter en dehors de chez lui* — et la seule implémentation qui
existe (la délégation) coûte un run complet et est réservée aux humains.

## 3. Décision (révisée en séance) : un appel MCP est traité comme l'interface

Principe fixé par l'opérateur : **le jeton dit à quelle porte l'application
peut frapper ; derrière la porte, Metaclaude se comporte exactement comme
depuis l'interface.** La responsabilité de « où chercher » est portée par le
paramétrage de Metaclaude et du workspace appelé, jamais par l'application.

Ce que cela retire — les deux règles qui bridaient un run `api` :

| Règle actuelle | Après |
| --- | --- |
| `delegationDirectory` : `api` → silencieux ([supervisor.ts:738](../../../apps/api/src/kernel/supervisor.ts#L738)) | un run `api` a l'annuaire et `delegate` **aux mêmes conditions qu'un run humain** : pairs `delegable` non archivés, coche `delegate` requise en `dontAsk` |
| `metaclaude_system` retiré pour `api` ([supervisor.ts:1064-1066](../../../apps/api/src/kernel/supervisor.ts#L1064-L1066)) | un run `api` du workspace système est **le steward complet** : `system_memory_search` sur toutes les mémoires, `system_run_ask`, etc. |

Ce qui reste spécifique aux runs `api`, parce que personne ne répond à une
carte : le **plafond** du jeton (`capPermissionMode`), inchangé. Et la
profondeur un de la délégation, inchangée : un run délégué ne délègue pas.

Ce que cela implique, à écrire noir sur blanc (SECURITY.md, guide 07, carte
des jetons) : **accorder `metaclaude` à un jeton accorde à l'application tout
ce que le steward sait faire**, lecture de toutes les mémoires et démarrage de
runs partout compris, dans la limite du plafond. Un jeton sur un workspace
ordinaire atteint ses voisins selon la case « laisser les autres workspaces
consulter celui-ci » et la pré-approbation de `delegate` dans le workspace
appelé. L'annuaire injecté nomme donc d'autres workspaces à un run que
l'application a démarré ; c'est accepté par le grant.

Le run `delegation` reste sans outils inter-workspaces : un run `api` qui
délègue obtient une réponse, pas un second bond.

**Option de coût, conservée dans le lot :** `search_workspaces`, recherche sans
modèle dans les mémoires et la bibliothèque des pairs (mêmes pairs que
l'annuaire, ring 1 pré-approuvé, résultats attribués au workspace d'origine).
Motif : une délégation coûte un run complet (0,34 $ mesuré sur opus) et des
minutes ; la mesure du § 1 montre qu'une recherche répond au premier rang pour
zéro appel de modèle. Pour le workspace système, `system_memory_search` joue
déjà ce rôle et rien n'est ajouté.

## 4. Ce qui ne change pas

- Le plafond du jeton, la session `MCP: <nom>` par workspace, sa rotation, la
  limite de requêtes par jeton, l'audit sous `token:<nom>`.
- Pas d'injection automatique inter-workspaces dans le préambule (coût par run,
  contamination des contextes, et le prompt brut cherche moins bien qu'une
  requête formulée — § 1).
- Pas de joker « tous les workspaces » sur le jeton : nommer `metaclaude` est
  déjà la porte vers tout, et c'est un choix explicite.
- `delegationDirectoryChars = 0` reste l'interrupteur unique.

## 5. Tokens, coûts, quotas

| Poste | Aujourd'hui | Après |
| --- | --- | --- |
| Réponse « je ne sais pas » de LIA | 0,06–0,15 $ | même run + `system_memory_search` (résultat ≤ ~1–2 k tokens), réponse trouvée |
| Préfixe en cache d'un run `api` | 37 658 tokens mesurés pour le workspace système | + l'annuaire des pairs (≤ 3 000 caractères, stable par session) ; réécrit une fois quand la liste des pairs change |
| Délégation depuis un run `api` | impossible | run complet chez le pair, deux slots de concurrence, `ASK_TIMEOUT` 10 min < `runTimeoutMs` 20 min → « still running » + `run_status` (contrat existant) |
| Automatisations | inchangé | inchangé |

## 6. Cas limites

1. Jeton sur `metaclaude`, plafond `dontAsk` → tous les `system_*` pré-approuvés
   s'exécutent sans carte (déjà le cas pour le steward planifié) ; plafond
   `plan` → rien ne s'exécute.
2. Jeton sur un workspace ordinaire en `dontAsk` sans coche `delegate` →
   annuaire présent pour `search_workspaces`, pas de `delegate` (paramétrage du
   workspace, conforme au principe).
3. Voisin `delegable = false` → invisible et inatteignable, comme pour un humain.
4. Run délégué par un run `api` → aucun verbe inter-workspaces ; mode du pair,
   **plafonné par le ceiling** (sinon un pair en `default` ouvrirait une carte
   sans personne) — c'est le seul ajout au noyau.
5. Déploiement à un seul workspace → rien de monté, note existante.
6. `search_workspaces` : pair sans `memoryEnabled`/`knowledgeEnabled` → arme
   absente ; document partagé par deux pairs → rendu une fois ; corpus lexical
   < 3 lignes → arme dense seule.
7. Briefing du workspace système pour un run `api` : désormais **vraie** (les
   outils qu'elle décrit sont montés) — le mensonge mesuré disparaît sans
   phrase spéciale.

## 7. Plan d'actions

**Lot 1 — lever les deux règles.** `supervisor.ts` : retirer `api` des deux
conditions ; `kernel.delegate` accepte un `ceiling` optionnel et plafonne le
run délégué ; `startForToken` transmet le plafond au superviseur via
`RunRequest` (champ `ceiling: ApiTokenCeiling | null`, posé depuis
`run.policy.permissionMode` — pas de colonne). Tests : les deux tests qui
figeaient le retrait deviennent « traité comme un run humain » ; nouveau test
du plafonnement du run délégué.

**Lot 2 — `search_workspaces`** (option de coût) : `workspaceIds` dans les deux
magasins, outil dans le serveur `metaclaude`, annuaire qui nomme les verbes
montés, pré-approbation ring 1, test de forwarding dérivé du schéma.

**Lot 3 — passerelle** : `search_notes` couvre aussi les mémoires (additif :
champ `kind`) ; descriptions d'outils.

**Lot 4 — doc, UI, changelog** : SECURITY.md (« retirée » → « comme depuis
l'interface, sous le plafond ; `metaclaude` = le steward entier »), guide 05 et
07, ARCHITECTURE.md, carte des jetons (phrase d'avertissement quand
`metaclaude` est coché), `fr.ts`, entrée dans `[Unreleased]`, `bump minor`.

**Lot 5 — `check:e2e`** : jeton sur `metaclaude`, mémoire dans un autre
workspace, `ask_workspace` → la réponse cite le workspace ; `console.error` sur
chaque frame pour voir l'appel d'outil.

## 8. Plan de test

- `supervisor.test.ts` : run `api` reçoit annuaire + `delegate` aux mêmes
  conditions qu'un run `user` (table origine × mode × coche) ; run `api` du
  workspace système reçoit `metaclaude_system` ; run `delegation` ne reçoit
  rien (existant).
- `kernel.test.ts` : `delegate` avec `ceiling` → mode du run délégué =
  `min(défaut du pair, ceiling)` ; sans → inchangé ; profondeur un (existant).
- `mcp-gateway.test.ts` / `gateway.test.ts` : `search_notes` rend mémoires et
  passages avec `kind` ; liste des six outils inchangée.
- Magasins : `workspaceIds` (lot 2), rejeu du corpus du § 1 sous hachage.
- Web : copies traduites, ratchets à zéro.
- Chaque test neuf saboté une fois avant d'être compté ; `pnpm verify`,
  `./deploy/check.sh`, `node deploy/ratchets.mjs`.

/**
 * The evaluation corpus: a small, realistic library and the questions a
 * person would actually ask of it.
 *
 * It lives in `src` rather than in a test file because two callers need the
 * *same* corpus — the test that guards retrieval against regression, and the
 * bench script that explores changes to it. A corpus that drifted between
 * them would make every comparison meaningless.
 *
 * The documents are deliberately the mix this deployment holds: French
 * administrative prose, where the answer is a number buried in a sentence,
 * and English technical prose, where the answer is often an exact
 * identifier. Two documents overlap on purpose (a lease and its amendment,
 * both about notice periods) because disambiguating near-duplicates is the
 * case a bag-of-words arm handles worst.
 *
 * Every query names what it probes. A metric that moves without a query
 * whose probe explains *why* is a metric nobody can act on.
 */

import type { LabelledQuery } from './eval.js';

export interface EvalDocument {
  /** Stable id used to build chunk labels: `${id}#${seq}`. */
  id: string;
  title: string;
  content: string;
}

export const EVAL_DOCUMENTS: readonly EvalDocument[] = [
  {
    id: 'bail',
    title: 'Bail — 12 rue des Lilas',
    content: `# Bail d'habitation

## Loyer et charges
Le loyer mensuel s'élève à 950 euros hors charges, auxquels s'ajoute une
provision de 110 euros pour les charges récupérables. Le règlement intervient
le 5 de chaque mois par virement.

## Résiliation par le locataire
Le locataire peut donner congé à tout moment. Le délai de préavis est de trois
mois, ramené à un mois lorsque le logement se situe en zone tendue. Le congé
est notifié par lettre recommandée avec accusé de réception.

## Dépôt de garantie
Le dépôt de garantie correspond à un mois de loyer hors charges. Il est
restitué dans un délai de deux mois après la remise des clés, déduction faite
des sommes justifiées restant dues.

## Travaux et entretien
Les réparations locatives incombent au locataire. Les travaux de mise aux
normes et le remplacement des équipements vétustes restent à la charge du
bailleur.`,
  },
  {
    id: 'avenant',
    title: 'Avenant au bail — garage',
    content: `# Avenant

## Objet
Le présent avenant ajoute la location d'un emplacement de stationnement
couvert, portant le numéro 14, au contrat principal.

## Loyer complémentaire
L'emplacement est loué 65 euros par mois, sans provision de charges.

## Résiliation de l'emplacement
La location de l'emplacement peut être résiliée indépendamment du logement,
avec un préavis d'un mois, sans que cela n'affecte le bail d'habitation.`,
  },
  {
    id: 'assurance',
    title: 'Contrat multirisque habitation',
    content: `# Multirisque habitation

## Déclaration d'un sinistre
Tout sinistre doit être déclaré à l'assureur dans les cinq jours ouvrés
suivant sa constatation. Ce délai est ramené à deux jours ouvrés en cas de
vol ou de tentative d'effraction.

## Franchise
Une franchise de 150 euros s'applique à chaque dégât des eaux. Les dommages
électriques relèvent d'une franchise distincte de 300 euros.

## Exclusions
Les dommages résultant d'un défaut d'entretien manifeste ne sont pas
couverts, non plus que les objets de valeur non déclarés au contrat.`,
  },
  {
    id: 'runbook',
    title: 'Deployment runbook',
    content: `# Deployment

## Health gating
The deploy script waits for the container health check before switching
traffic. A container that never reports healthy is rolled back automatically
after ninety seconds.

## Database migrations
Migrations run on boot, inside the same transaction that records them, so a
crash mid-migration leaves no partial state. They are append-only: never edit
a shipped statement.

## Ports and addresses
The API listens on METACLAUDE_PORT_8787 inside the network namespace. The
proxy is the only service bound to a public interface.

## Rolling back
A failed deploy restores the previous image tag and re-runs the health gate.
Volumes are never touched by a rollback.`,
  },
  {
    id: 'conventions',
    title: 'Engineering conventions',
    content: `# Conventions

## Imports
Relative imports in the API and shared packages must end in .js, even when
the source file is TypeScript. The web app uses the bundler resolver instead.

## Contracts
Every entity is declared once as a Zod schema and its TypeScript type is
inferred from it. Add a field to the shared package first, or the two sides
drift apart.

## Comments
Comments explain why, not what. A comment that restates the code is noise; one
that records a decision or a trap is not.`,
  },
];

/**
 * Distractors: documents that share the register and much of the vocabulary
 * of the real ones without answering any labelled query.
 *
 * They exist because the first measurement on the five documents above
 * returned 100% on every metric — which said nothing about retrieval and
 * everything about the instrument: seventeen chunks with a window of five is
 * barely a filter. A corpus that cannot separate a good pipeline from a bad
 * one cannot be used to judge a change to it.
 *
 * The hard part is adding difficulty without adding ambiguity. These stay
 * clear of every labelled answer's *subject* while sharing its language —
 * délai, montant, euros, jours, procédure, résiliation on the French side;
 * rollback, transaction, suffix, health on the English side. The harness
 * refuses to run if any label resolves to zero or several chunks, which
 * catches literal collisions; keeping the subjects disjoint is what handles
 * the rest.
 *
 * `replicate` then multiplies them with distinct numbers and references, to
 * reach the scale a personal library actually reaches — and to create the
 * near-duplicate pressure that a growing shelf really produces.
 */
const DISTRACTOR_SEEDS: readonly EvalDocument[] = [
  {
    id: 'mutuelle',
    title: 'Complémentaire santé — garanties',
    content: `# Complémentaire santé

## Remboursement des consultations
La consultation d'un médecin traitant est remboursée à hauteur de 100 % du
tarif de convention. Le délai de traitement d'une demande est de dix jours
ouvrés à compter de la réception des justificatifs.

## Optique et dentaire
Un forfait de 200 euros par période de deux ans couvre la monture et les
verres. Les prothèses dentaires font l'objet d'un plafond annuel distinct.

## Résiliation du contrat
Le contrat se reconduit tacitement chaque année. La résiliation intervient
par lettre adressée deux mois avant l'échéance annuelle.`,
  },
  {
    id: 'energie',
    title: 'Contrat de fourniture d’électricité',
    content: `# Fourniture d'électricité

## Puissance souscrite
La puissance souscrite est de 9 kVA. Une modification prend effet le premier
jour du mois suivant la demande, sans frais.

## Facturation
Les factures sont émises tous les deux mois sur la base d'un index relevé ou
estimé. Le montant de la régularisation apparaît sur la facture annuelle.

## Interruption de fourniture
Une coupure pour impayé ne peut intervenir qu'après une mise en demeure
restée sans effet pendant quinze jours.`,
  },
  {
    id: 'travail',
    title: 'Contrat de travail — cadre',
    content: `# Contrat de travail

## Période d'essai
La période d'essai est fixée à quatre mois, renouvelable une fois par accord
écrit des deux parties.

## Rémunération
La rémunération annuelle brute s'établit à 54 000 euros, versée sur douze
mensualités, à laquelle s'ajoute une part variable.

## Congés
Le salarié bénéficie de vingt-cinq jours ouvrés de congés payés, auxquels
s'ajoutent les jours de réduction du temps de travail.`,
  },
  {
    id: 'cgu',
    title: 'Conditions générales d’utilisation',
    content: `# Conditions générales

## Compte utilisateur
La création d'un compte suppose l'acceptation des présentes conditions. Les
identifiants sont personnels et ne peuvent être cédés.

## Données personnelles
Les données sont conservées pendant trois ans à compter du dernier contact.
Une demande de suppression est traitée sous trente jours.

## Modification des conditions
Toute modification est notifiée un mois avant son entrée en vigueur.`,
  },
  {
    id: 'copro',
    title: 'Règlement de copropriété',
    content: `# Règlement de copropriété

## Parties communes
L'entretien des parties communes relève du syndic. Les charges sont réparties
selon les tantièmes attachés à chaque lot.

## Assemblée générale
La convocation est adressée vingt et un jours au moins avant la réunion.
Les décisions se prennent aux majorités prévues par la loi.

## Nuisances
Les travaux bruyants sont interdits avant huit heures et après vingt heures,
ainsi que les dimanches et jours fériés.`,
  },
  {
    id: 'backup',
    title: 'Backup and restore procedure',
    content: `# Backups

## Nightly archive
A host timer stops the application for a few seconds, archives every volume,
and writes a marker file the doctor reads. A missing marker becomes a visible
warning rather than a silent gap.

## Restoring
Restore replays the archive into fresh volumes and refuses to run against a
directory that already holds data. The operator confirms twice.

## Retention
Seven daily archives and four weekly ones are kept. Pruning happens after a
successful archive, never before.`,
  },
  {
    id: 'styleguide',
    title: 'Frontend style guide',
    content: `# Style guide

## Tokens
Only semantic tokens are used for colour: surface, ink, muted, line, accent.
Raw palette classes break the light theme and a ratchet refuses them.

## Spacing
Spacing follows a four-pixel scale. Components own their internal spacing;
layout owns the space between them.

## Motion
Motion is informative rather than decorative, and everything holds still
under a reduced-motion preference.`,
  },
  {
    id: 'oncall',
    title: 'On-call handbook',
    content: `# On call

## Paging
A page fires when the error rate crosses the threshold for five consecutive
minutes. Flapping alerts are suppressed for an hour after resolution.

## Escalation
An unacknowledged page escalates after ten minutes to the secondary, then to
the engineering lead.

## Postmortems
Every page that reached a human gets a written postmortem within five working
days, blameless and focused on the failed control.`,
  },
];

/**
 * Multiply the distractor seeds, varying the numbers and references so the
 * copies are near-duplicates rather than duplicates — the pressure a growing
 * personal shelf really applies.
 */
export function replicate(seeds: readonly EvalDocument[], copies: number): EvalDocument[] {
  const out: EvalDocument[] = [];
  for (let index = 0; index < copies; index += 1) {
    for (const seed of seeds) {
      out.push({
        id: `${seed.id}-${index}`,
        title: `${seed.title} (dossier ${100 + index})`,
        // Shift every standalone number deterministically: same shape, other
        // facts, so nothing here can accidentally answer a labelled query.
        content: seed.content.replace(/\b(\d{1,5})\b/g, (match) => String(Number(match) + index + 1)),
      });
    }
  }
  return out;
}

/** The corpus a measurement runs against: the real documents plus noise. */
export function evalCorpus(distractorCopies = 4): EvalDocument[] {
  return [...EVAL_DOCUMENTS, ...replicate(DISTRACTOR_SEEDS, distractorCopies)];
}

/**
 * The questions, each naming the weakness it probes.
 *
 * Relevant ids are `${documentId}#${chunkSeq}` — resolved against whatever
 * chunking the store actually performed, so a change to the chunker shows up
 * here as a labelling failure rather than silently shifting the ground truth.
 * The harness that consumes these resolves them by *content*, not by seq, for
 * exactly that reason; see `resolveLabels`.
 */
export const EVAL_QUERIES: readonly (Omit<LabelledQuery, 'relevant'> & {
  /** A distinctive substring of each passage that answers the query. */
  answers: readonly string[];
})[] = [
  {
    query: 'quel est le délai de préavis pour quitter le logement ?',
    answers: ['Le délai de préavis est de trois mois'],
    probes: 'French paraphrase: the query says "quitter", the passage says "donner congé".',
  },
  {
    query: 'combien de temps pour récupérer le dépôt de garantie ?',
    answers: ['restitué dans un délai de deux mois'],
    probes: 'French paraphrase over a number the passage states in words.',
  },
  {
    query: 'préavis pour résilier le garage',
    answers: ["avec un préavis d'un mois"],
    probes: 'Near-duplicate disambiguation: the lease also discusses préavis.',
  },
  {
    query: 'sous quel délai déclarer un vol ?',
    answers: ['ramené à deux jours ouvrés en cas de'],
    probes: 'The answer is a clause inside a sentence about a different delay.',
  },
  {
    query: 'montant de la franchise dégât des eaux',
    answers: ['franchise de 150 euros'],
    probes: 'French exact-ish lookup: a number the lexical arm should find.',
  },
  {
    query: 'METACLAUDE_PORT_8787',
    answers: ['METACLAUDE_PORT_8787'],
    probes: 'Exact identifier: purely the lexical arm’s job.',
  },
  {
    query: 'what happens when a deploy never becomes healthy?',
    answers: ['rolled back automatically'],
    probes: 'English paraphrase across a heading boundary.',
  },
  {
    query: 'why do imports need a .js suffix?',
    answers: ['must end in .js'],
    probes: 'English lookup where the query word "suffix" never appears.',
  },
  {
    query: 'how are database migrations applied safely?',
    answers: ['inside the same transaction that records them'],
    probes: 'English paraphrase: "safely" against "no partial state".',
  },
  {
    query: 'qui paie le remplacement d’un équipement vétuste ?',
    answers: ['restent à la charge du bailleur'],
    probes: 'French paraphrase requiring the whole sentence, not a keyword.',
  },
];

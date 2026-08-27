/**
 * Le français de Metaclaude.
 *
 * Les clés sont les phrases anglaises telles qu'elles apparaissent dans les
 * composants (motif gettext) : une entrée absente retombe sur l'anglais,
 * jamais sur une clé nue. Ce module n'entre jamais dans le chunk d'entrée —
 * il est chargé par un `import()` dynamique au premier passage en français.
 *
 * Conventions : vouvoiement ; « workspace » reste « workspace » (le terme
 * technique du produit) ; « run » reste « run » ; les libellés de colonnes
 * du board suivent l'usage kanban français.
 */

export const fr: Record<string, string> = {
  /* Navigation */
  Dashboard: 'Accueil',
  Workspaces: 'Espaces',
  Memory: 'Mémoire',
  Automations: 'Automatisations',
  Analytics: 'Analytique',
  Help: 'Aide',
  Settings: 'Réglages',
  More: 'Plus',

  /* Sign-in */
  'Sign in': 'Se connecter',
  'Your private agentic OS.': 'Votre OS agentique privé.',
  "No account exists yet.": "Aucun compte n'existe encore.",
  Username: "Nom d'utilisateur",
  Password: 'Mot de passe',
  'Enter the code from your authenticator app.':
    "Saisissez le code de votre application d'authentification.",
  'A recovery code also works here.': 'Un code de récupération fonctionne aussi ici.',
  'Verification code': 'Code de vérification',
  '123456 or ABCDE-FGHJK': '123456 ou ABCDE-FGHJK',
  Verify: 'Vérifier',
  'Use a different account': 'Changer de compte',
  or: 'ou',
  'Sign in with a passkey': 'Se connecter avec une passkey',
  'This instance is private. Every action is recorded in a hash-chained audit log.':
    "Cette instance est privée. Chaque action est consignée dans un journal d'audit chaîné par hachage.",
  'Could not reach the server. Check that it is running.':
    "Impossible de joindre le serveur. Vérifiez qu'il est démarré.",
  'That passkey did not sign in. Try your password.':
    "Cette passkey n'a pas fonctionné. Essayez votre mot de passe.",

  /* Appearance */
  Appearance: 'Apparence',
  'These preferences live in this browser only.':
    'Ces préférences ne vivent que dans ce navigateur.',
  Language: 'Langue',
  'The guide and the changelog stay in English for now.':
    'Le guide et le journal des modifications restent en anglais pour le moment.',
  Theme: 'Thème',
  Light: 'Clair',
  Dark: 'Sombre',
  System: 'Système',
  Transcript: 'Transcription',
  "Show the model's reasoning": 'Afficher le raisonnement du modèle',
  'Collapsible blocks showing how the agent worked through the problem.':
    "Des blocs repliables montrant comment l'agent a raisonné.",
  'Expand tool calls by default': "Déplier les appels d'outils par défaut",
  "Show each tool's full input and result instead of a one-line summary.":
    "Afficher l'entrée et le résultat complets de chaque outil plutôt qu'un résumé d'une ligne.",
  /* Settings */
  'Signed in as {name} ({role})': 'Connecté en tant que {name} ({role})',
  'Settings sections': 'Sections des réglages',
  Security: 'Sécurité',
  'Audit log': "Journal d'audit",
  'Changing it signs out every device, including this one.':
    'Le changer déconnecte tous les appareils, y compris celui-ci.',
  'Current password': 'Mot de passe actuel',
  'At least 12 characters. Length matters more than symbols.':
    'Au moins 12 caractères. La longueur compte plus que les symboles.',
  'New password': 'Nouveau mot de passe',
  'Confirm new password': 'Confirmer le nouveau mot de passe',
  'The passwords do not match.': 'Les mots de passe ne correspondent pas.',
  'Use at least 12 characters.': 'Utilisez au moins 12 caractères.',
  'Change password': 'Changer le mot de passe',
  'Password changed. Sign in again with the new one.':
    'Mot de passe changé. Reconnectez-vous avec le nouveau.',
  'Could not change the password.': 'Impossible de changer le mot de passe.',
  'Two-factor authentication': 'Authentification à deux facteurs',
  'A second factor is what keeps a leaked password from becoming a compromised agent OS.':
    "Un second facteur empêche un mot de passe compromis de devenir un OS agentique compromis.",
  on: 'activée',
  off: 'désactivée',
  '{n} recovery code(s) remaining.': '{n} code(s) de récupération restant(s).',
  'Consider re-enrolling to get a fresh set.':
    'Pensez à réenrôler pour en obtenir de nouveaux.',
  'Re-enrol': 'Réenrôler',
  'Turn off': 'Désactiver',
  'Set up': 'Configurer',
  'Confirm your password': 'Confirmez votre mot de passe',
  'Re-enrolling replaces your current authenticator and issues new recovery codes.':
    'Réenrôler remplace votre authentificateur actuel et émet de nouveaux codes de récupération.',
  'Enrolling a device changes how you sign in, so it needs your password.':
    "Enrôler un appareil change votre façon de vous connecter : votre mot de passe est requis.",
  Cancel: 'Annuler',
  Continue: 'Continuer',
  'Set up two-factor authentication': "Configurer l'authentification à deux facteurs",
  'Add this secret to your authenticator app, then confirm with the code it shows.':
    "Ajoutez ce secret à votre application d'authentification, puis confirmez avec le code affiché.",
  Confirm: 'Confirmer',
  "Can't scan? Enter this setup key instead":
    'Scan impossible ? Saisissez plutôt cette clé de configuration',
  'Code from your app': 'Code de votre application',
  'Save your recovery codes': 'Conservez vos codes de récupération',
  'Each works once, in place of a code from your app. This is the only time they are shown.':
    "Chacun fonctionne une fois, à la place d'un code de votre application. Ils ne seront plus jamais affichés.",
  'I have saved them': 'Je les ai conservés',
  Copied: 'Copié',
  'Could not copy': 'Copie impossible',
  'Copy all': 'Tout copier',
  'Turn off two-factor authentication?': "Désactiver l'authentification à deux facteurs ?",
  "Confirm with your password. This weakens your account's security.":
    'Confirmez avec votre mot de passe. Cela affaiblit la sécurité de votre compte.',
  'That password is incorrect.': 'Ce mot de passe est incorrect.',
  'Two-factor authentication is on.': "L'authentification à deux facteurs est activée.",
  'That code was not accepted. Check your device clock.':
    "Ce code n'a pas été accepté. Vérifiez l'horloge de votre appareil.",
  'Two-factor authentication is off.': "L'authentification à deux facteurs est désactivée.",
  'Signed-in devices': 'Appareils connectés',
  'Anything you do not recognise should be signed out immediately.':
    'Déconnectez immédiatement tout ce que vous ne reconnaissez pas.',
  'Sign out others': 'Déconnecter les autres',
  'this device': 'cet appareil',
  'unknown address': 'adresse inconnue',
  active: 'actif',
  'Sign out this device': 'Déconnecter cet appareil',
  'Signed out that device': 'Appareil déconnecté',
  'Signed out {n} other device(s)': '{n} autre(s) appareil(s) déconnecté(s)',
  Doctor: 'Docteur',
  'Every self-check the system knows how to run — database, audit chain, vault, disk, CLI, automations.':
    "Tous les autodiagnostics du système — base de données, chaîne d'audit, coffre, disque, CLI, automatisations.",
  'Run checks': 'Lancer les vérifications',
  'The examination could not run.': "L'examen n'a pas pu s'exécuter.",
  'Not run yet.': 'Pas encore lancé.',
  Version: 'Version',
  Uptime: 'Disponibilité',
  'Memory (RSS)': 'Mémoire (RSS)',
  'Disk free': 'Disque libre',
  'Every agent run goes through this binary.': 'Chaque run passe par ce binaire.',
  Available: 'Disponible',
  yes: 'oui',
  'not found': 'introuvable',
  Authentication: 'Authentification',
  'subscription (Pro / Max)': 'abonnement (Pro / Max)',
  'API key (pay as you go)': "clé API (à l'usage)",
  'none configured': 'aucune configurée',
  'paired here': 'appairé ici',
  'CLI account sign-in': 'connexion au compte via la CLI',
  'from the environment': "depuis l'environnement",
  Kernel: 'Noyau',
  'Active runs': 'Runs actifs',
  'Queued runs': "Runs en file",
  'Stored memories': 'Souvenirs stockés',
  'Embedding provider': "Fournisseur d'embeddings",
  'Chain intact across {n} entries.': 'Chaîne intacte sur {n} entrées.',
  'Chain broken at entry {id}. The log may have been altered.':
    "Chaîne rompue à l'entrée {id}. Le journal a peut-être été altéré.",
  'Could not verify the chain.': 'Impossible de vérifier la chaîne.',
  'Every entry commits to the hash of the one before it, so an edit anywhere invalidates everything after.':
    "Chaque entrée s'engage sur le hachage de la précédente : une modification invalide tout ce qui suit.",
  'Verify chain': 'Vérifier la chaîne',
  'No entries': 'Aucune entrée',
  /* Dashboard */
  'Still up': 'Encore debout',
  'Good morning': 'Bonjour',
  'Good afternoon': 'Bon après-midi',
  'Good evening': 'Bonsoir',
  there: 'vous',
  subscription: 'abonnement',
  'API key': 'clé API',
  'No Claude credentials configured': 'Aucun identifiant Claude configuré',
  'New workspace': 'Nouveau workspace',
  'Could not create the workspace.': 'Impossible de créer le workspace.',
  'Claude is not authenticated.': "Claude n'est pas authentifié.",
  'Pair it from': 'Appairez-le depuis',
  'Settings → System': 'Réglages → Système',
  ': sign in with your Pro or Max plan, paste back one code, done — no shell, no restart. A token from':
    " : connectez-vous avec votre offre Pro ou Max, collez un code en retour, terminé — sans shell, sans redémarrage. Un jeton issu de",
  'can be pasted there too.': 'peut aussi y être collé.',
  'The brief': 'Le brief',
  'last 24 hours': 'dernières 24 heures',
  '{n} action(s) waiting for you': '{n} action(s) en attente de votre décision',
  'Could not send that decision.': "Impossible d'envoyer cette décision.",
  Deny: 'Refuser',
  Review: 'Review',
  '{n} queued': '{n} en file',
  'Nothing queued': 'Rien en file',
  'Cost, 7 days': 'Coût, 7 jours',
  '{n} runs': '{n} runs',
  'Success rate': 'Taux de réussite',
  'median {d}': 'médiane {d}',
  Memories: 'Souvenirs',
  'In flight': 'En vol',
  'View all': 'Tout voir',
  'No workspaces yet': 'Aucun workspace pour le moment',
  'A workspace is a project directory plus the agent policy that applies inside it.':
    "Un workspace est un répertoire de projet plus la politique d'agent qui s'y applique.",
  'Create the first one': 'Créer le premier',
  'Recently learned': 'Appris récemment',
  'Nothing new': 'Rien de neuf',
  'After each run, Metaclaude reflects on what happened and records anything worth remembering.':
    "Après chaque run, Metaclaude réfléchit à ce qui s'est passé et note ce qui mérite d'être retenu.",
  'Recent runs': 'Runs récents',
  'No runs yet': 'Aucun run pour le moment',
  'Start a session to see history here.': "Démarrez une session pour voir l'historique ici.",

  /* Board */
  'What is captured, moving, and done — for you and the agents alike.':
    'Ce qui est capturé, en cours et terminé — pour vous comme pour les agents.',
  Workspace: 'Workspace',
  'Work the board': 'Travailler le board',
  'New task': 'Nouvelle tâche',
  'No workspace yet': 'Aucun workspace pour le moment',
  'Create a workspace first — its board comes with it.':
    "Créez d'abord un workspace — son board vient avec.",
  '{n} card(s)': '{n} carte(s)',
  'The board did not accept that.': "Le board n'a pas accepté cela.",
  'Started "{title}".': '« {title} » démarrée.',
  'A card is already being worked — one at a time.':
    'Une carte est déjà en cours — une à la fois.',
  'Nothing unblocked in To do.': 'Rien de débloqué dans À faire.',
  'Lands in {column}.': 'Atterrit dans {column}.',
  Title: 'Titre',
  'What needs doing?': 'Que faut-il faire ?',
  'Description (optional)': 'Description (facultative)',
  'What done looks like, constraints, links…': 'À quoi ressemble « terminé », contraintes, liens…',
  Priority: 'Priorité',
  low: 'basse',
  normal: 'normale',
  high: 'haute',
  urgent: 'urgente',
  All: 'Toutes',
  Yours: 'Les vôtres',
  Create: 'Créer',
  Backlog: 'Backlog',
  'To do': 'À faire',
  'In progress': 'En cours',
  Done: 'Terminé',
  'Captured, not committed': 'Capturé, pas engagé',
  'Committed, waiting to start': 'Engagé, en attente de démarrage',
  'Being worked right now': 'En cours de traitement',
  'Done, awaiting your eyes': 'Fait, en attente de votre regard',
  'Finished and verified': 'Terminé et vérifié',
  '{column} column': 'Colonne {column}',
  'Add a task to {column}': 'Ajouter une tâche à {column}',
  'Move to': 'Déplacer vers',
  'Actions for {title}': 'Actions pour {title}',
  'Priority: {p}': 'Priorité : {p}',
  'The agent is working this card': "L'agent travaille cette carte",
  'Assigned to the agent': "Assignée à l'agent",
  'Assigned to you': 'Assignée à vous',
  'Agent working': 'Agent au travail',
  Agent: 'Agent',
  You: 'Vous',
  blocked: 'bloquée',
  'Archived task': 'Tâche archivée',
  Task: 'Tâche',
  Archive: 'Archiver',
  Restore: 'Restaurer',
  'Delete forever': 'Supprimer définitivement',
  Close: 'Fermer',
  Save: 'Enregistrer',
  Description: 'Description',
  Unassigned: 'Non assignée',
  'Hands the card back — the agent starts working it':
    "Rend la carte à l'agent — il commence à la travailler",
  "The workspace's agent — it can pick this card up":
    "L'agent du workspace — il peut prendre cette carte",
  'Due date': "Échéance",
  'Sent to the agent — the card comes back in review.':
    "Envoyée à l'agent — la carte reviendra en review.",
  'Watch the session': 'Suivre la session',
  'Send back to the agent': "Renvoyer à l'agent",
  'Send to the agent': "Envoyer à l'agent",
  'Runs this card in its own session; done stays your call.':
    'Lance cette carte dans sa propre session ; « terminé » reste votre décision.',
  'Last session': 'Dernière session',
  'Sub-tasks': 'Sous-tâches',
  'Break a piece out…': 'Détachez un morceau…',
  'New sub-task': 'Nouvelle sous-tâche',
  Add: 'Ajouter',
  Comments: 'Commentaires',
  'Add a comment…': 'Ajouter un commentaire…',
  'New comment': 'Nouveau commentaire',
  Send: 'Envoyer',
  'Hide history': "Masquer l'historique",
  'History ({n})': 'Historique ({n})',

  /* Chrome */
  Account: 'Compte',
  'Sign out': 'Se déconnecter',
  'Signed out': 'Déconnecté',
  Live: 'En direct',
  'Connected. Streaming updates in real time.': 'Connecté. Mises à jour en temps réel.',
  Connecting: 'Connexion',
  'Reconnecting to the server…': 'Reconnexion au serveur…',
  Offline: 'Hors ligne',
  'Disconnected. Retrying automatically.': 'Déconnecté. Nouvel essai automatique.',
  'Your session expired. Sign in again.': 'Votre session a expiré. Reconnectez-vous.',
  Notifications: 'Notifications',
  'Notifications ({n} unread)': 'Notifications ({n} non lues)',
  'Mark all read': 'Tout marquer lu',
  'Clear all': 'Tout effacer',
  'Nothing yet': 'Rien pour le moment',
  'Run results and things Metaclaude learns will show up here.':
    "Les résultats des runs et ce que Metaclaude apprend s'afficheront ici.",
  'Go to': 'Aller à',
  'Create a project': 'Créer un projet',
  'Recent sessions': 'Sessions récentes',
  'Untitled run': 'Run sans titre',
  'Search workspaces, sessions and commands…': 'Chercher workspaces, sessions et commandes…',
  'Nothing matches that.': 'Rien ne correspond.',

  /* Getting started */
  'Getting set up': 'Mise en route',
  '{n} step(s) left before everything this can do is switched on.':
    "{n} étape(s) avant que tout ce que cela sait faire soit activé.",
  'Dismiss the checklist': 'Masquer la liste',
  'Pair Claude': 'Appairer Claude',
  'Sign in with your Pro or Max account — nothing runs without it.':
    'Connectez-vous avec votre compte Pro ou Max — rien ne tourne sans lui.',
  'Create a workspace': 'Créer un workspace',
  'A directory plus the agent policy that applies inside it.':
    "Un répertoire plus la politique d'agent qui s'y applique.",
  'Run the agent once': "Lancer l'agent une fois",
  'Open a session and ask for something small; watch it work.':
    'Ouvrez une session, demandez quelque chose de petit ; regardez-le travailler.',
  'Turn on two-factor auth': "Activer l'authentification à deux facteurs",
  'This server is on the network; your account should need more than a password.':
    "Ce serveur est sur le réseau ; votre compte mérite plus qu'un mot de passe.",
  'Enable notifications': 'Activer les notifications',
  'A push when a run waits on your approval — the phone is the point.':
    "Une notification quand un run attend votre approbation — le téléphone est le but.",
  'Install the host updater': "Installer l'updater hôte",
  'Re-run deploy/install-app.sh once; updates become one button here.':
    'Relancez deploy/install-app.sh une fois ; les mises à jour deviennent un bouton ici.',

  /* Notifications card */
  'A push when a run waits on your approval, and when a run you started ends. Automations stay silent by design.':
    "Une notification quand un run attend votre approbation, et quand un run que vous avez lancé se termine. Les automatisations restent silencieuses, par conception.",
  'This browser cannot receive push notifications. On iPhone and iPad they need the app installed to the Home Screen (Share → Add to Home Screen), then enabled from here.':
    "Ce navigateur ne peut pas recevoir de notifications push. Sur iPhone et iPad, il faut installer l'app sur l'écran d'accueil (Partager → Sur l'écran d'accueil), puis les activer ici.",
  'this device is subscribed': 'cet appareil est inscrit',
  'Send a test': 'Envoyer un test',
  'Disable here': 'Désactiver ici',
  'Enable on this device': 'Activer sur cet appareil',
  '{n} device(s) subscribed across the deployment.': '{n} appareil(s) inscrit(s) sur le déploiement.',
  'Reading the push status…': 'Lecture du statut push…',
  'The app icon also shows a badge while approvals wait.':
    "L'icône de l'app affiche aussi un badge quand des approbations attendent.",
  'This device now receives notifications.': 'Cet appareil reçoit désormais les notifications.',
  'Could not enable notifications.': "Impossible d'activer les notifications.",
  'This device will no longer be notified.': 'Cet appareil ne sera plus notifié.',
  'Sent to {n} device(s).': 'Envoyé à {n} appareil(s).',
  'No device is subscribed yet.': "Aucun appareil n'est encore inscrit.",
  '{n} device(s) subscribed but the test could not be delivered{err}.':
    "{n} appareil(s) inscrit(s) mais le test n'a pas pu être livré{err}.",
  'The test notification could not be sent.': "La notification de test n'a pas pu être envoyée.",

  /* Passkeys card */
  Passkeys: 'Passkeys',
  "Sign in with your device's own unlock — Face ID, a fingerprint, a security key — instead of the password.":
    "Connectez-vous avec le déverrouillage de votre appareil — Face ID, empreinte, clé de sécurité — au lieu du mot de passe.",
  '{n} enrolled': '{n} enrôlée(s)',
  'This browser does not support passkeys (WebAuthn). Password and authenticator-app sign-in are unaffected.':
    "Ce navigateur ne prend pas en charge les passkeys (WebAuthn). Mot de passe et application d'authentification restent inchangés.",
  'Passkeys need a domain name: the WebAuthn standard scopes a credential to a domain, and this deployment is being reached by IP address. Give the server a hostname (METACLAUDE_SITE — see the deployment guide) and enrol from there. Password and authenticator-app sign-in are unaffected.':
    "Les passkeys exigent un nom de domaine : le standard WebAuthn lie une clé à un domaine, et ce déploiement est joint par adresse IP. Donnez un nom d'hôte au serveur (METACLAUDE_SITE — voir le guide de déploiement) et enrôlez depuis là. Mot de passe et application d'authentification restent inchangés.",
  'last used': 'dernière utilisation',
  'never used': 'jamais utilisée',
  'Remove {label}': 'Supprimer {label}',
  'No passkey yet. The password keeps working either way — a passkey is an addition, never a replacement.':
    "Aucune passkey pour le moment. Le mot de passe continue de fonctionner — une passkey s'ajoute, ne remplace jamais.",
  'Add a passkey': 'Ajouter une passkey',
  'Your password confirms it is you; your device then creates the passkey.':
    "Votre mot de passe confirme que c'est vous ; votre appareil crée ensuite la passkey.",
  'So you can tell your devices apart later.': 'Pour distinguer vos appareils plus tard.',
  Name: 'Nom',
  'This phone': 'Ce téléphone',
  'Remove "{label}"': 'Supprimer « {label} »',
  'That device will no longer sign you in. Removing a sign-in method needs your password.':
    "Cet appareil ne vous connectera plus. Retirer un moyen de connexion demande votre mot de passe.",
  Remove: 'Supprimer',
  '"{label}" can now sign you in.': '« {label} » peut désormais vous connecter.',
  'Could not add the passkey.': "Impossible d'ajouter la passkey.",
  'Passkey removed.': 'Passkey supprimée.',
  'Could not remove the passkey.': 'Impossible de supprimer la passkey.',

  /* Transcript */
  'Nothing here yet': 'Rien ici pour le moment',
  'Describe what you want done. Metaclaude picks the model, recalls what it learned from earlier sessions, and asks before it does anything irreversible.':
    "Décrivez ce que vous voulez. Metaclaude choisit le modèle, se rappelle ce qu'il a appris des sessions précédentes, et demande avant tout geste irréversible.",
  Exchange: 'Échange',
  'Jump to latest': 'Aller au plus récent',
  'Working…': 'En cours…',
  'Low risk': 'Risque faible',
  'Reads data without changing anything.': 'Lit des données sans rien changer.',
  'Medium risk': 'Risque moyen',
  'Writes files, runs a command, or reaches an external service.':
    'Écrit des fichiers, exécute une commande ou joint un service externe.',
  'High risk': 'Risque élevé',
  'This command matches a destructive pattern. Read it carefully.':
    'Cette commande correspond à un motif destructeur. Lisez-la attentivement.',
  'Unanswered prompts are declined automatically.':
    'Les demandes sans réponse sont refusées automatiquement.',
  'Why you are being asked:': 'Pourquoi on vous demande :',
  Allow: 'Autoriser',
  'Remember for this session': 'Retenir pour cette session',
  'High-risk actions are always asked individually.':
    'Les actions à haut risque sont toujours demandées une par une.',

  /* Agents & skills — la bibliothèque et les catégories */
  'Agents & skills': 'Agents et skills',
  Subagents: 'Sous-agents',
  'MCP servers': 'Serveurs MCP',
  Library: 'Bibliothèque',
  'From Claude': 'Depuis Claude',
  Category: 'Catégorie',
  'Groups the registry lists; pick General when nothing fits.':
    'Regroupe les listes du registre ; choisissez Général quand rien ne convient.',
  Engineering: 'Ingénierie',
  Writing: 'Rédaction',
  Data: 'Données',
  Research: 'Recherche',
  Product: 'Produit',
  General: 'Général',
  'A starter shelf of skills and subagents, curated in this repository and versioned with it. Installing copies one into the global registry, disabled — switch it on when you want runs to see it, edit it like anything you wrote yourself.':
    "Une étagère de départ de skills et de sous-agents, sélectionnée dans ce dépôt et versionnée avec lui. Installer en copie une dans le registre global, désactivée — activez-la quand vous voulez que les runs la voient, modifiez-la comme tout ce que vous auriez écrit vous-même.",
  'Filter by category': 'Filtrer par catégorie',
  'The library could not be read': "La bibliothèque n'a pas pu être lue",
  'Reload the page, or check the server logs if it keeps failing.':
    'Rechargez la page, ou consultez les journaux du serveur si cela persiste.',
  subagent: 'sous-agent',
  Installed: 'Installé',
  Install: 'Installer',
  'Install “{name}”': 'Installer « {name} »',
  'Installed “{name}”': '« {name} » : installation faite',
  'Find it under Subagents, in the global scope — disabled until you switch it on.':
    "À retrouver dans Sous-agents, en portée globale — désactivé jusqu'à ce que vous l'activiez.",
  'Find it under Skills, in the global scope — disabled until you switch it on.':
    "À retrouver dans Skills, en portée globale — désactivé jusqu'à ce que vous l'activiez.",
  'Could not install that entry.': "Impossible d'installer cette entrée.",
};
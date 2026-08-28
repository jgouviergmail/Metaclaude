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
  Doctor: 'Docteur',
  'Every self-check the system knows how to run — database, audit chain, vault, disk, CLI, automations.':
    "Tous les autodiagnostics du système — base de données, chaîne d'audit, coffre, disque, CLI, automatisations.",
  'Run checks': 'Lancer les vérifications',
  'The examination could not run.': "L'examen n'a pas pu s'exécuter.",
  'Not run yet.': 'Pas encore lancé.',
  Version: 'Version',
  Uptime: 'Disponibilité',
  /* Ressources de la machine. `RAM` plutôt que `Memory` : le catalogue est
     indexé sur la chaîne anglaise, et `Memory` est déjà l'entrée de
     navigation de la page Mémoire. */
  CPU: 'Processeur',
  RAM: 'Mémoire vive',
  Disk: 'Disque',
  'Measuring…': 'Mesure en cours…',
  'host load {n}': 'charge machine {n}',
  'this app {n}': 'dont cette app {n}',
  '{free} free of {total}': '{free} libres sur {total}',
  'Not measurable here': 'Non mesurable ici',
  'What this machine is doing right now.': 'Ce que fait la machine en ce moment.',

  /* Actions en masse sur le registre */
  'Enable all': 'Tout activer',
  'Disable all': 'Tout désactiver',
  'Delete all': 'Tout supprimer',
  'Could not apply that.': 'Impossible d’appliquer cette action.',
  'Delete {n}': 'Supprimer {n}',
  'This removes everything listed here.': 'Cela retire tout ce qui est listé ici.',
  'This removes everything listed here, including the global entries this workspace also sees.':
    'Cela retire tout ce qui est listé ici, y compris les entrées globales que ce workspace voit aussi.',

  /* MCP : test de connexion et outils exposés */
  'Drop a card here': 'Déposez une carte ici',

  /* Workspace */
  'All workspaces': 'Tous les espaces',
  'Workspace settings': 'Réglages du workspace',
  'New session': 'Nouvelle session',
  'Permission mode': 'Mode de permission',
  Branch: 'Branche',
  'Not a git repository': 'Pas un dépôt git',
  'Uncommitted changes': 'Modifications non committées',
  'From the CLI': 'Depuis le CLI',
  'Starting your first session': 'Démarrage de votre première session',
  'Sessions from the Claude CLI': 'Sessions du CLI Claude',
  'Default model': 'Modèle par défaut',
  'Default effort': 'Effort par défaut',
  'Default permission mode': 'Mode de permission par défaut',
  'How much to ask before acting': 'À quel point demander avant d’agir',
  Autonomy: 'Autonomie',
  'Marketplace plugins': 'Plugins de la marketplace',
  'Max turns per run': 'Tours maximum par run',
  'Answer language': 'Langue des réponses',
  'What the agent answers in': 'La langue dans laquelle l’agent répond',
  'Additional instructions': 'Instructions supplémentaires',
  'Test connections': 'Tester les connexions',
  'Connects every enabled server exactly as a run would.':
    'Connecte chaque serveur activé exactement comme le ferait un run.',
  'Pick a workspace first — a server is connected for a run, and a run happens in one.':
    'Choisissez d’abord un workspace — un serveur est connecté pour un run, et un run a lieu dans un workspace.',
  'Every server answered': 'Tous les serveurs ont répondu',
  'Could not ask the CLI.': 'Impossible d’interroger le CLI.',
  destructive: 'destructif',
  'read-only': 'lecture seule',

  'Anything installed from the Library can be installed again.':
    'Tout ce qui vient de la Bibliothèque peut être réinstallé.',
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
  'Could not send that decision.': "Impossible d'envoyer cette décision.",
  Deny: 'Refuser',
  Review: 'Examiner',
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
  Workspace: 'Espace de travail',
  'Work the board': 'Travailler le board',
  'New task': 'Nouvelle tâche',
  'No workspace yet': 'Aucun workspace pour le moment',
  'Create a workspace first — its board comes with it.':
    "Créez d'abord un workspace — son board vient avec.",
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
  'Show reasoning': 'Afficher le raisonnement',
  'Expand tool calls': 'Déplier les appels d’outils',
  'Signed out': 'Déconnecté',
  Live: 'En direct',
  'Connected. Streaming updates in real time.': 'Connecté. Mises à jour en temps réel.',
  Connecting: 'Connexion',
  'Reconnecting to the server…': 'Reconnexion au serveur…',
  Offline: 'Hors ligne',
  'Disconnected. Retrying automatically.': 'Déconnecté. Nouvel essai automatique.',
  'Your session expired. Sign in again.': 'Votre session a expiré. Reconnectez-vous.',
  Succeeded: 'Réussi',
  Failed: 'Échec',
  'Needs attention': 'À vérifier',
  Information: 'Information',
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
  'Reading the push status…': 'Lecture du statut push…',
  'The app icon also shows a badge while approvals wait.':
    "L'icône de l'app affiche aussi un badge quand des approbations attendent.",
  'This device now receives notifications.': 'Cet appareil reçoit désormais les notifications.',
  'Could not enable notifications.': "Impossible d'activer les notifications.",
  'This device will no longer be notified.': 'Cet appareil ne sera plus notifié.',
  'No device is subscribed yet.': "Aucun appareil n'est encore inscrit.",
  'The test notification could not be sent.': "La notification de test n'a pas pu être envoyée.",

  /* Passkeys card */
  Passkeys: 'Passkeys',
  "Sign in with your device's own unlock — Face ID, a fingerprint, a security key — instead of the password.":
    "Connectez-vous avec le déverrouillage de votre appareil — Face ID, empreinte, clé de sécurité — au lieu du mot de passe.",
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
  Home: 'Maison',
  Health: 'Santé',
  Money: 'Argent',
  Learning: 'Apprentissage',
  Travel: 'Voyage',
  Career: 'Carrière',
  General: 'Général',
  'A starter shelf of skills and subagents, curated in this repository and versioned with it. Installing copies one into the global registry, disabled — switch it on when you want runs to see it, edit it like anything you wrote yourself.':
    "Une étagère de départ de skills et de sous-agents, sélectionnée dans ce dépôt et versionnée avec lui. Installer en copie une dans le registre global, désactivée — activez-la quand vous voulez que les runs la voient, modifiez-la comme tout ce que vous auriez écrit vous-même.",
  'Filter by category': 'Filtrer par catégorie',

  /* Le répertoire de connecteurs */
  'Connector directory': 'Répertoire de connecteurs',
  'Servers this repository has read the documentation for — the exact endpoint and the exact name of the credential it wants. Every one authenticates with something you can paste, because a run has no browser to complete an OAuth consent in; that is also why your claude.ai connectors cannot be imported. Adding one writes the server globally — the scope selector above does not apply — seals your credential in the vault, and leaves it disabled.':
    "Des serveurs dont ce dépôt a lu la documentation — l'adresse exacte et le nom exact du secret qu'ils réclament. Chacun s'authentifie avec quelque chose que vous pouvez coller, car un run n'a pas de navigateur pour donner un consentement OAuth ; c'est aussi pourquoi vos connecteurs claude.ai ne peuvent pas être importés. En ajouter un écrit le serveur en portée globale — le sélecteur de portée ci-dessus ne s'y applique pas —, scelle votre secret dans le coffre et le laisse désactivé.",
  Docs: 'Doc',
  Added: 'Ajouté',
  needs: 'réclame',
  'optionally takes': 'accepte éventuellement',
  optional: 'facultatif',
  'the token alone — no scheme word': 'le jeton seul — sans le mot du schéma',
  'paste the key': 'collez la clé',
  'Added “{name}”': '« {name} » ajouté',
  'Global and disabled. Switch it on above, then check From Claude to see whether it actually connected.':
    "Global et désactivé. Activez-le ci-dessus, puis regardez Depuis Claude pour savoir s'il s'est vraiment connecté.",
  'Add “{name}”': 'Ajouter « {name} »',
  'Could not add that connector.': "Ce connecteur n'a pas pu être ajouté.",

  /* La connexion Google */
  Connections: 'Connexions',
  'Gmail, Calendar and Drive, through an OAuth application you own. Your connectors on claude.ai cannot be imported — a run has no browser to give consent in — so the consent happens here once, and the refresh token it returns is what lets runs work unattended.':
    "Gmail, Agenda et Drive, via une application OAuth qui vous appartient. Vos connecteurs claude.ai ne peuvent pas être importés — un run n'a pas de navigateur pour donner un consentement — donc le consentement se fait ici, une fois, et le refresh token obtenu est ce qui permet aux runs de travailler sans surveillance.",
  'Read your mail': 'Lire vos e-mails',
  'Send mail as you': 'Envoyer des e-mails en votre nom',
  'Read your calendar': 'Lire votre agenda',
  'Create and change events': 'Créer et modifier des événements',
  'Read your Drive': 'Lire votre Drive',
  'Create files in Drive': 'Créer des fichiers dans Drive',
  'Search and read messages. Nothing is sent or deleted.':
    "Rechercher et lire des messages. Rien n'est envoyé ni supprimé.",
  'Compose and send. It cannot read what it did not just write.':
    "Rédiger et envoyer. Il ne peut pas lire ce qu'il ne vient pas d'écrire.",
  'List events, with recurring ones expanded.':
    'Lister les événements, récurrences déroulées.',
  'Add and update events — grant reading too, or the agent plans blind. Never your calendar settings or sharing.':
    "Ajouter et mettre à jour des événements — accordez aussi la lecture, sinon l'agent planifie à l'aveugle. Jamais vos réglages d'agenda ni vos partages.",
  'Search and read every file you can see.':
    'Rechercher et lire tous les fichiers que vous voyez.',
  'Only files Metaclaude itself creates — not the rest of your Drive.':
    'Uniquement les fichiers créés par Metaclaude — pas le reste de votre Drive.',
  'In the Google Cloud console, create a project and enable the Gmail, Calendar and Drive APIs you want.':
    'Dans la console Google Cloud, créez un projet et activez les API Gmail, Agenda et Drive voulues.',
  'On the OAuth consent screen, choose Internal if this is a Workspace account — that is what avoids Google’s verification and the seven-day token expiry.':
    "Sur l'écran de consentement OAuth, choisissez Interne si c'est un compte Workspace — c'est ce qui évite la vérification Google et l'expiration du jeton à sept jours.",
  'Create an OAuth client ID of type “Web application”, and register this exact redirect URI:':
    'Créez un ID client OAuth de type « Application Web » et déclarez exactement cette URI de redirection :',
  'This deployment’s address could not be determined, so the redirect URI cannot be shown.':
    "L'adresse de ce déploiement n'a pas pu être déterminée, donc l'URI de redirection ne peut pas être affichée.",
  'Client ID': 'ID client',
  'Client secret': 'Secret client',
  'What the agent may do with your account': "Ce que l'agent peut faire avec votre compte",
  'Each box is one Google scope. A capability you do not grant is not merely refused at run time — its tool is never registered, so the agent cannot try it.':
    "Chaque case est un scope Google. Une capacité non accordée n'est pas simplement refusée à l'exécution — son outil n'est jamais enregistré, donc l'agent ne peut pas l'essayer.",
  'Reading mail or Drive uses a scope Google calls restricted. On a consent screen still in “Testing”, the refresh token expires after seven days — the connection would stop working next week for no visible reason. Publish the app as Internal (Workspace) or leave those two boxes unticked.':
    "Lire les e-mails ou Drive utilise un scope que Google classe restricted. Sur un écran de consentement encore « En test », le refresh token expire au bout de sept jours — la connexion cesserait de fonctionner la semaine prochaine sans raison visible. Publiez l'application en Interne (Workspace) ou laissez ces deux cases décochées.",
  'Continue to Google': 'Continuer vers Google',
  'Could not start the connection.': "La connexion n'a pas pu démarrer.",
  Connected: 'Connecté',
  'account unknown': 'compte inconnu',
  'The tools live on the MCP server named “google”, under Agents & skills. It is created disabled; a server that is on is mounted into every run of every workspace.':
    "Les outils vivent sur le serveur MCP nommé « google », sous Agents et skills. Il est créé désactivé ; un serveur actif est monté dans chaque run de chaque espace de travail.",
  Disconnect: 'Déconnecter',
  'Revoke at Google': 'Révoquer chez Google',
  'Disconnect Google?': 'Déconnecter Google ?',
  'The stored refresh token and client secret are erased and the “google” MCP server is removed. This does not revoke anything at Google — do that at myaccount.google.com/permissions.':
    "Le refresh token et le secret client stockés sont effacés et le serveur MCP « google » est retiré. Cela ne révoque rien chez Google — faites-le sur myaccount.google.com/permissions.",
  'Could not disconnect.': 'La déconnexion a échoué.',
  'Google connected.': 'Google connecté.',
  'The server was added under Agents & skills → MCP servers, disabled. Switch it on there when you are ready.':
    'Le serveur a été ajouté sous Agents et skills → Serveurs MCP, désactivé. Activez-le là-bas quand vous êtes prêt.',
  'Google did not connect.': "Google ne s'est pas connecté.",
  'Google disconnected.': 'Google déconnecté.',
  /* La bibliothèque de connaissance */
  'Knowledge library': 'Bibliothèque de connaissance',
  'Reference documents the agent can quote — a lease, a spec, a runbook. Global documents reach every workspace; scoped ones stay in theirs. Runs retrieve the relevant passages automatically, and the transcript shows which ones were used.':
    "Des documents de référence que l'agent peut citer — un bail, une spec, un runbook. Les documents globaux atteignent tous les espaces de travail ; les autres restent dans le leur. Les runs récupèrent automatiquement les passages pertinents, et le transcript montre ceux qui ont servi.",
  'Add document': 'Ajouter un document',
  'Saved “{name}”': 'Enregistré « {name} »',
  'Re-index': 'Réindexer',
  'Recompute every passage’s embedding — needed after changing embedding provider.':
    "Recalculer le vecteur de chaque passage — nécessaire après un changement de fournisseur d'embeddings.",
  'Everything was already indexed with the current embedder.':
    "Tout était déjà indexé avec l'embedder actuel.",
  '{n} passages re-embedded.': '{n} passages ré-indexés.',
  '1 passage re-embedded.': '1 passage ré-indexé.',
  'Could not re-index.': 'Impossible de réindexer.',
  'Nothing on the shelf yet': "Rien sur l'étagère pour l'instant",
  'Paste the documents your runs keep needing — the contract, the conventions, the runbook — and the agent will cite them instead of guessing.':
    "Collez les documents dont vos runs ont sans cesse besoin — le contrat, les conventions, le runbook — et l'agent les citera au lieu de deviner.",
  '{n} passages': '{n} passages',
  '{n} passages indexed and ready to be retrieved.': '{n} passages indexés et prêts à être retrouvés.',
  Paused: 'En pause',
  'Retrieve from “{name}”': 'Récupérer depuis « {name} »',
  'On: runs can retrieve these passages. Switch off to pause without deleting.':
    'Actif : les runs peuvent récupérer ces passages. Désactivez pour mettre en pause sans supprimer.',
  'Paused: kept and editable, but never retrieved.':
    'En pause : conservé et modifiable, mais jamais récupéré.',
  'Delete “{name}”': 'Supprimer « {name} »',
  'Rehearse a retrieval': 'Répéter une récupération',
  'Ask what a run would ask, and see exactly the passages it would be shown — same search, same gates, scores included.':
    "Posez la question qu'un run poserait, et voyez exactement les passages qui lui seraient montrés — même recherche, mêmes portes, scores compris.",
  'e.g. what is the notice period?': 'p. ex. quel est le délai de préavis ?',
  Preview: 'Aperçu',
  'Nothing relevant enough — a run would receive no passages for this.':
    'Rien d’assez pertinent — un run ne recevrait aucun passage pour cela.',
  'Edit document': 'Modifier le document',
  'Add a document': 'Ajouter un document',
  'e.g. Lease — 12 rue des Lilas': 'p. ex. Bail — 12 rue des Lilas',
  Scope: 'Portée',
  'Global — every workspace': 'Global — tous les espaces de travail',
  Content: 'Contenu',
  'Paste the text. Markdown headings become the sections passages are cited under.':
    'Collez le texte. Les titres Markdown deviennent les sections sous lesquelles les passages sont cités.',
  'Save document': 'Enregistrer le document',
  'Add to the library': 'Ajouter à la bibliothèque',
  'Delete this document?': 'Supprimer ce document ?',
  'and every passage indexed from it are removed. Runs stop seeing it immediately.':
    'et chaque passage qui en est indexé sont supprimés. Les runs cessent de le voir immédiatement.',
  'Delete document': 'Supprimer le document',
  'Document deleted': 'Document supprimé',
  'Its passages left the index with it.': "Ses passages ont quitté l'index avec lui.",
  'Could not save that document.': "Ce document n'a pas pu être enregistré.",
  'Could not update that document.': "Ce document n'a pas pu être mis à jour.",
  'Could not delete that document.': "Ce document n'a pas pu être supprimé.",
  'Could not open that document.': "Ce document n'a pas pu être ouvert.",
  'Passages consulted': 'Passages consultés',
  doc: 'doc',
  'Consult the knowledge library': 'Consulter la bibliothèque de connaissance',
  "Retrieve relevant passages from your reference documents — this workspace's shelf plus the global one.":
    "Récupérer les passages pertinents de vos documents de référence — l'étagère de cet espace plus la globale.",

  'The stored token is gone from this deployment. Google still lists Metaclaude until you revoke it at myaccount.google.com/permissions.':
    'Le jeton stocké a disparu de ce déploiement. Google liste encore Metaclaude tant que vous ne le révoquez pas sur myaccount.google.com/permissions.',
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

  /* L'advisor */
  'The advisor': "L'advisor",
  'Ask the advisor': "Demander à l'advisor",
  'Which workspace?': 'Quel workspace ?',
  'The advisor is studying “{name}”': "L'advisor étudie « {name} »",
  'Follow the run in its “Advisor” session; proposals land here.':
    "Suivez le run dans sa session « Advisor » ; les propositions arrivent ici.",
  'Could not start the advisor.': "Impossible de démarrer l'advisor.",
  'Accepted “{name}”': '« {name} » accepté',
  'Recorded — the payload names the source to install it from.':
    "Enregistré — la proposition nomme la source où l'installer.",
  'Created disabled in the registry; enable it when you want runs to see it.':
    "Créé désactivé dans le registre ; activez-le quand vous voulez que les runs le voient.",
  'Could not accept that proposal.': "Impossible d'accepter cette proposition.",
  'Could not dismiss that proposal.': "Impossible d'écarter cette proposition.",
  'Nothing waiting. The advisor studies a workspace on request — or daily where you opt in — creates backlog tickets and disabled automations itself, and leaves anything that would act here for your decision.':
    "Rien en attente. L'advisor étudie un workspace à la demande — ou chaque jour là où vous l'avez activé — crée lui-même tickets de backlog et automatisations désactivées, et dépose ici tout ce qui agirait, pour votre décision.",
  'MCP server': 'Serveur MCP',
  Accept: 'Accepter',
  Dismiss: 'Écarter',
  'Accept “{name}”': 'Accepter « {name} »',
  'Dismiss “{name}”': 'Écarter « {name} »',

  /* La boucle rendue visible */
  'chosen from experience': "choisi par l'expérience",
  'workspace default': 'défaut du workspace',
  'your choice': 'votre choix',
  'Why this run was shaped this way': 'Pourquoi ce run a pris cette forme',
  'Posterior for this arm — {pct} expected over {n} trials':
    'A posteriori de ce bras — {pct} attendus sur {n} essais',
  'The learner expects {pct} from this arm, over {n} trials here.':
    "L'apprentissage attend {pct} de ce bras, sur {n} essais ici.",
  'You chose this configuration yourself; the learner watches and records the outcome.':
    "Vous avez choisi cette configuration vous-même ; l'apprentissage observe et enregistre le résultat.",
  'No learned arm matches this run yet — its outcome is what teaches the first one.':
    "Aucun bras appris ne correspond encore à ce run — son résultat est ce qui enseignera le premier.",
  'Retrieval strength {pct}': 'Force de rappel {pct}',
  'Recalling memory…': 'Rappel de la mémoire…',
  'Nothing recalled — this run started from the prompt alone.':
    'Rien de rappelé — ce run est parti du prompt seul.',
  'The story of this run could not be read.': "L'histoire de ce run n'a pas pu être lue.",
  semantic: 'sémantique',
  episodic: 'épisodique',
  procedural: 'procédurale',

  /* La constellation de la mémoire */
  'The memory as a constellation — recent at the centre, fading toward the rim':
    "La mémoire en constellation — le récent au centre, l'oublié vers le bord",
  'size = confidence · centre = recently recalled · ring = pinned':
    'taille = confiance · centre = rappelé récemment · anneau = épinglé',
  '{n} fainter ones not drawn': '{n} plus pâles non dessinées',

  /* Le pouls du système */
  'All quiet — the last run finished {when}.': 'Tout est calme — le dernier run a fini {when}.',
  'All quiet. Send a message, or fill the board and let it work.':
    'Tout est calme. Envoyez un message, ou remplissez le board et laissez-le travailler.',
  '{n} runs over the last 24 hours': '{n} runs sur les dernières 24 heures',
  '{n} failed': '{n} en échec',
  'Recalled into this run': 'Rappelé dans ce run',
  'a day': 'un jour',
  'a week': 'une semaine',
  'a month': 'un mois',

  /* Analytique */
  'What consumed it today': 'Ce qui l’a consommé aujourd’hui',
  Period: 'Période',
  'Subscription quota': 'Quota de l’abonnement',
  'Analytics could not be loaded': 'L’analytique n’a pas pu être chargée',
  'Try again': 'Réessayer',
  'No runs in this period': 'Aucun run sur cette période',
  'Runs over time': 'Runs dans le temps',
  'Cost over time': 'Coût dans le temps',
  'Success rate over time': 'Taux de réussite dans le temps',
  'Where the usage went': 'Où est passé l’usage',
  'By model': 'Par modèle',
  'By category': 'Par catégorie',
  'Avg reward': 'Récompense moy.',
  'Learned policy': 'Politique apprise',
  'Reset learning': 'Réinitialiser l’apprentissage',
  'Nothing learned yet': 'Rien d’appris pour l’instant',
  'Reset what the system learned?': 'Réinitialiser ce que le système a appris ?',
  Trials: 'Essais',
  Duration: 'Durée',
  'Resets in': 'Réinitialisé dans',

  /* Coquille de l’application */
  Context: 'Contexte',
  'Close panel': 'Fermer le panneau',
  'Close sections': 'Fermer les sections',
  'More sections': 'Plus de sections',
  'Toggle panel': 'Afficher ou masquer le panneau',
  Loading: 'Chargement',

  /* Catalogue du CLI */
  'Reading what Claude offers': 'Lecture de ce que Claude propose',
  'What Claude offers here': 'Ce que Claude propose ici',
  'Read from the CLI itself': 'Lu depuis le CLI lui-même',
  Refresh: 'Actualiser',
  'The Claude CLI could not be reached': 'Le CLI Claude n’a pas pu être joint',
  'This CLI could not answer about {questions}. Those sections are empty because the question failed, not because there is nothing there.':
    'Ce CLI n’a pas su répondre sur : {questions}. Ces sections sont vides parce que la question a échoué, pas parce qu’il n’y a rien.',
  Models: 'Modèles',
  'Slash commands': 'Commandes slash',

  /* Identifiants Claude */
  'Claude credentials': 'Identifiants Claude',
  'Pair with your Claude account': 'Appairer votre compte Claude',
  'Metaclaude runs the {command} flow for you: sign in at claude.ai, approve, paste back the code it shows. Works entirely from this device. Console (per-token) accounts paste their API key below instead.':
    'Metaclaude déroule {command} pour vous : connectez-vous sur claude.ai, approuvez, recollez le code affiché. Tout se fait depuis cet appareil. Les comptes Console (facturés au jeton) collent plutôt leur clé d’API ci-dessous.',
  'Start pairing': 'Démarrer l’appairage',
  'Paste the code here': 'Collez le code ici',
  'Finish pairing': 'Terminer l’appairage',
  'Remove the stored credential?': 'Supprimer l’identifiant enregistré ?',
  'QR code — scan it with your authenticator app':
    'QR code — scannez-le avec votre application d’authentification',

  /* Mises à jour */
  Updates: 'Mises à jour',
  Apply: 'Appliquer',
  'Release notes': 'Notes de version',
  'Updating to {version} — the app restarts during this; the page reconnects and reloads itself.':
    'Mise à jour vers {version} — l’app redémarre pendant l’opération ; la page se reconnecte et se recharge d’elle-même.',
  'The last update{version} did not go healthy{reason}':
    'La dernière mise à jour{version} n’est pas passée en bonne santé{reason}',

  /* Transcription */
  'Permission needed': 'Autorisation requise',
  Esc: 'Échap',
  Prompt: 'Consigne',
  'Pending attachments': 'Pièces jointes en attente',
  Uploading: 'Envoi en cours',
  'Attach files': 'Joindre des fichiers',
  Tools: 'Outils',
  'Require skills': 'Exiger des skills',
  Stop: 'Arrêter',
  'Delegated to': 'Délégué à',
  'Rewind this run': 'Rembobiner ce run',
  Input: 'Entrée',
  'Copy tool input': 'Copier l’entrée de l’outil',
  Result: 'Résultat',
  Attachments: 'Pièces jointes',
  Plan: 'Plan',
  'Rewind the files this run changed': 'Rembobiner les fichiers modifiés par ce run',
  'Rate this run as good': 'Noter ce run comme bon',
  'Rate this run as poor': 'Noter ce run comme mauvais',

  /* Identiques en français, et notés ici plutôt que laissés absents : une
     entrée manquante veut dire « pas encore traduit », une entrée identique
     veut dire « traduit, et c'est le même mot ». `Ultracode` est un nom de
     fonctionnalité du CLI ; la liste d'outils est un exemple de saisie dont
     les noms sont ceux de l'API. */
  Ultracode: 'Ultracode',
  'Read, Grep, Glob': 'Read, Grep, Glob',
  'Unsaved changes': 'Modifications non enregistrées',

  /* Sessions du CLI */
  'No CLI sessions here': 'Aucune session CLI ici',
  Adopt: 'Adopter',

  /* Fichiers */
  Files: 'Fichiers',
  'Refresh files': 'Actualiser les fichiers',
  'Close files': 'Fermer les fichiers',
  'Find a file by name': 'Trouver un fichier par son nom',
  'Only the first {n} entries are listed — this folder holds more. Use the box above to find a file by name.':
    'Seules les {n} premières entrées sont listées — ce dossier en contient davantage. Utilisez le champ ci-dessus pour trouver un fichier par son nom.',
  'This file is {size} — only the beginning is shown. Editing is disabled, because saving what is on screen would truncate the file on disk.':
    'Ce fichier fait {size} — seul le début est affiché. L’édition est désactivée : enregistrer ce qui est à l’écran tronquerait le fichier sur le disque.',
  'This folder could not be read': 'Ce dossier n’a pas pu être lu',
  'Back to the root': 'Retour à la racine',
  'Folder path': 'Chemin du dossier',
  'Workspace root': 'Racine du workspace',
  'Back to files': 'Retour aux fichiers',
  'View mode': 'Mode d’affichage',

  /* Contrôle de source */
  'Source control': 'Contrôle de source',
  'Refresh source control': 'Actualiser le contrôle de source',
  'Close source control': 'Fermer le contrôle de source',
  'Git status is unavailable': 'L’état git est indisponible',
  'Commit message': 'Message de commit',
  'Stage all': 'Tout indexer',
  'Recent commits': 'Commits récents',
  'No repository yet': 'Pas encore de dépôt',
  'Repository URL': 'URL du dépôt',
  'Clone into this workspace': 'Cloner dans ce workspace',
  'Just track it locally': 'Suivre seulement en local',

  /* Notes */
  'Local graph': 'Graphe local',
  Graph: 'Graphe',
  Backlinks: 'Rétroliens',
  'Showing {shownIn} of {totalIn} in, {shownOut} of {totalOut} out.':
    '{shownIn} sur {totalIn} entrants, {shownOut} sur {totalOut} sortants.',

  /* Liste des sessions */
  'Filter sessions': 'Filtrer les sessions',
  'No sessions yet': 'Aucune session pour l’instant',
  'Delete this session?': 'Supprimer cette session ?',
  Pinned: 'Épinglée',
  Running: 'En cours',
  'Waiting for approval': 'En attente d’approbation',

  /* Agents et skills */
  'Extension type': 'Type d’extension',
  'New skill': 'Nouvelle skill',
  'No skills in this scope': 'Aucune skill dans cette portée',
  'Delete this skill?': 'Supprimer cette skill ?',
  'Save skill': 'Enregistrer la skill',
  'Use when reviewing a database migration before it ships.':
    'À utiliser pour relire une migration de base de données avant sa livraison.',
  Body: 'Contenu',
  'New subagent': 'Nouveau sous-agent',
  'No subagents in this scope': 'Aucun sous-agent dans cette portée',
  'Delete this subagent?': 'Supprimer ce sous-agent ?',
  'Save subagent': 'Enregistrer le sous-agent',
  'Summarises merged pull requests into release notes.':
    'Résume les pull requests fusionnées en notes de version.',
  Model: 'Modèle',
  Inherit: 'Hériter',
  'New server': 'Nouveau serveur',
  'No MCP servers in this scope': 'Aucun serveur MCP dans cette portée',
  'Delete this MCP server?': 'Supprimer ce serveur MCP ?',
  'Save server': 'Enregistrer le serveur',
  Transport: 'Transport',
  Command: 'Commande',
  Arguments: 'Arguments',

  /* Automatisations */
  'New automation': 'Nouvelle automatisation',
  'No automations yet': 'Aucune automatisation',
  'Create one': 'En créer une',
  'Go to workspaces': 'Aller aux espaces',
  'Open session': 'Ouvrir la session',
  'Nightly dependency audit': 'Audit nocturne des dépendances',
  'Check for outdated dependencies with known advisories and open a summary of what needs attention.':
    'Chercher les dépendances obsolètes avec des avis de sécurité connus et ouvrir un résumé de ce qui demande attention.',
  Trigger: 'Déclencheur',
  'Cron expression': 'Expression cron',
  'Interval in minutes': 'Intervalle en minutes',
  'Continuous loop': 'Boucle continue',
  'Unattended runs cannot answer prompts':
    'Un run sans surveillance ne peut répondre à aucune question',
  'Stop after N failures': 'Arrêter après N échecs',

  /* Board */
  'Filter by assignee': 'Filtrer par assigné',

  /* Aide */
  'Ask Metaclaude about itself': 'Interroger Metaclaude sur lui-même',
  'How do automations avoid overlapping runs?':
    'Comment les automatisations évitent-elles les runs qui se chevauchent ?',
  'Question for the help assistant': 'Question pour l’assistant d’aide',
  'Help sections': 'Sections de l’aide',
  'User guide': 'Guide utilisateur',
  'Search the guide': 'Rechercher dans le guide',
  'Search results': 'Résultats de recherche',
  'Guide chapters': 'Chapitres du guide',

  /* Mémoire */
  'All memory': 'Toute la mémoire',
  'Global only': 'Global uniquement',
  'Memory maintenance': 'Maintenance de la mémoire',
  Maintenance: 'Maintenance',
  'Add memory': 'Ajouter une mémoire',
  'Filter memories by keyword': 'Filtrer les mémoires par mot-clé',
  'Filter by memory kind': 'Filtrer par type de mémoire',
  'Semantic recall': 'Rappel sémantique',
  'Describe a task, as you would to the agent':
    'Décrivez une tâche, comme vous le feriez à l’agent',
  'Search memory by meaning': 'Chercher dans la mémoire par le sens',
  'Top matches': 'Meilleures correspondances',
  'Memory could not be loaded': 'La mémoire n’a pas pu être chargée',
  'Insights awaiting review': 'Enseignements en attente de revue',
  'Distil a skill': 'Distiller une skill',
  Reject: 'Rejeter',
  'Install skill': 'Installer la skill',
  'Add a memory': 'Ajouter une mémoire',
  'Edit memory': 'Modifier la mémoire',
  'Delete this memory?': 'Supprimer cette mémoire ?',
  Kind: 'Type',
  'Prefer pnpm over npm in this repo': 'Préférer pnpm à npm dans ce dépôt',
  Tags: 'Étiquettes',

  /* Plugins */
  Marketplaces: 'Places de marché',
  'Add marketplace': 'Ajouter une marketplace',
  'Installed by path': 'Installés par chemin',
  'No plugins installed': 'Aucun plugin installé',
  'Install a plugin': 'Installer un plugin',
  'Path on the server': 'Chemin sur le serveur',
  'Add a marketplace': 'Ajouter une marketplace',
  'Plugins are enabled as': 'Les plugins sont activés sous la forme',
  Source: 'Source',
  'No marketplaces yet': 'Aucune marketplace',

  /* Session et espaces */
  'Loading the editor': 'Chargement de l’éditeur',
  'Back to the workspace': 'Retour au workspace',
  'Delete session': 'Supprimer la session',
  'Payments service': 'Service de paiement',
  'What this project is, in one line.': 'Ce qu’est ce projet, en une ligne.',
  'Clone a repository': 'Cloner un dépôt',
  Colour: 'Couleur',
  'Also delete the files on disk': 'Supprimer aussi les fichiers sur le disque',
  'Everything under {path} is erased. This cannot be undone. Leave this unchecked to keep the files and only forget the workspace.':
    'Tout ce qui se trouve sous {path} est effacé. C’est irréversible. Laissez décoché pour conserver les fichiers et seulement oublier le workspace.',

  /* ── Brief et quota ─────────────────────────────────────────────────── */
  '% used': '% utilisé',
  'Board:': 'Board :',
  'Switched off by the failure guard:': 'Désactivées par le garde-fou d’échec :',
  'Re-enable them under Automations once the cause is fixed.':
    'Réactivez-les dans Automatisations une fois la cause corrigée.',
  'Plan quota windows do not apply here — this credential is an API key or a third-party provider, billed per token instead.':
    'Les fenêtres de quota du forfait ne s’appliquent pas ici — cet identifiant est une clé d’API ou un fournisseur tiers, facturé au jeton.',
  'The CLI could not report quota here — its usage endpoint is unavailable in this version.':
    'Le CLI n’a pas pu rapporter le quota ici — son point d’accès d’usage est indisponible dans cette version.',
  'Extra usage credits:': 'Crédits d’usage supplémentaires :',
  "Approximate — read from this machine's transcripts, so other devices and claude.ai are not counted. Categories overlap.":
    'Approximatif — lu depuis les transcriptions de cette machine, donc les autres appareils et claude.ai ne sont pas comptés. Les catégories se recoupent.',
  'No usage in this period.': 'Aucun usage sur cette période.',
  'The quota could not be read.': 'Le quota n’a pas pu être lu.',
  'Command palette': 'Palette de commandes',

  /* ── Catalogue du CLI ───────────────────────────────────────────────── */
  'Metaclaude could not start a CLI session to ask. That usually means the binary is not on PATH inside the container, or no credentials are paired yet — check Settings.':
    'Metaclaude n’a pas pu démarrer une session CLI pour poser la question. Le plus souvent, le binaire n’est pas dans le PATH du conteneur, ou aucun identifiant n’est encore appairé — voyez les Réglages.',
  'Connectors from your claude.ai account never appear here: a server paired with a setup token authenticates for inference only, so the CLI cannot fetch them. To connect an external service, add its MCP server on the Agents screen — it is mounted into every run and reported above. Metaclaude’s own board and delegation tools ride along in-process and are always available.':
    'Les connecteurs de votre compte claude.ai n’apparaissent jamais ici : un serveur appairé avec un jeton de configuration n’authentifie que l’inférence, le CLI ne peut donc pas les récupérer. Pour connecter un service externe, ajoutez son serveur MCP sur l’écran Agents — il est monté dans chaque run et rapporté ci-dessus. Les outils board et délégation de Metaclaude tournent en interne et sont toujours disponibles.',
  'What this subscription grants, and which take an effort level':
    'Ce que cet abonnement accorde, et lesquels acceptent un niveau d’effort',
  'Built in, plus anything this workspace defines':
    'Intégrées, plus ce que ce workspace définit',
  'Named agents the CLI can delegate to': 'Agents nommés auxquels le CLI peut déléguer',
  'Nothing reported.': 'Rien de rapporté.',
  "The servers this workspace's runs mount — and whether each actually connected":
    'Les serveurs que montent les runs de ce workspace — et si chacun s’est réellement connecté',
  'A marketplace is a repository of plugins the Claude CLI installs from directly — add one by its GitHub repo or its marketplace.json URL.':
    'Une marketplace est un dépôt de plugins que le CLI Claude installe directement — ajoutez-la par son dépôt GitHub ou l’URL de son marketplace.json.',
  'This marketplace lists no plugins.': 'Cette marketplace ne liste aucun plugin.',
  'No marketplace offers plugins yet — add one under Plugins.':
    'Aucune marketplace ne propose encore de plugins — ajoutez-en une dans Plugins.',
  'source missing': 'source absente',
  'Its marketplace is disabled or removed, so runs no longer load it.':
    'Sa marketplace est désactivée ou supprimée : les runs ne la chargent plus.',

  /* ── Identifiants Claude ────────────────────────────────────────────── */
  'What every agent run authenticates with. Stored encrypted, never written to a file.':
    'Ce avec quoi chaque run s’authentifie. Stocké chiffré, jamais écrit dans un fichier.',
  '— runs use that sign-in. Pairing a token below would override it.':
    '— les runs utilisent cette connexion. Appairer un jeton ci-dessous la remplacerait.',
  'claude setup-token': 'claude setup-token',
  'Open the sign-in link and approve. Claude then displays a code.':
    'Ouvrez le lien de connexion et approuvez. Claude affiche alors un code.',
  'Open claude.ai': 'Ouvrir claude.ai',
  'or copy it to another device:': 'ou copiez-le vers un autre appareil :',
  'Copy the sign-in link': 'Copier le lien de connexion',
  'the code Claude displayed': 'le code affiché par Claude',
  'The link stays valid for 10 minutes.': 'Le lien reste valide 10 minutes.',
  'Or paste a token or API key yourself': 'Ou collez vous-même un jeton ou une clé d’API',
  'sk-ant-oat01-…': 'sk-ant-oat01-…',
  'No signed-in machine anywhere?': 'Aucune machine connectée nulle part ?',
  'This server ships the CLI. Over SSH, or from the provider’s web console, the same flow works by hand:':
    'Ce serveur embarque le CLI. En SSH, ou depuis la console web de l’hébergeur, le même enchaînement fonctionne à la main :',
  'It prints a URL — open it on this device, sign in, paste the code back into that terminal, and put the token it returns in the box above.':
    'Il affiche une URL — ouvrez-la sur cet appareil, connectez-vous, recollez le code dans ce terminal, et mettez le jeton obtenu dans le champ ci-dessus.',
  'Agent runs will fall back to whatever the server environment provides, and will fail if it provides nothing.':
    'Les runs se rabattront sur ce que fournit l’environnement du serveur, et échoueront s’il ne fournit rien.',
  '…apps.googleusercontent.com': '…apps.googleusercontent.com',

  /* ── Mises à jour ───────────────────────────────────────────────────── */
  'Compares this version against the latest published release. Applying runs the same health-gated, auto-rolling-back deploy as CI.':
    'Compare cette version à la dernière publiée. Appliquer déclenche le même déploiement que la CI : contrôlé par la santé, avec retour arrière automatique.',
  'Not checked yet.': 'Pas encore vérifié.',
  'The update check is switched off for this deployment.':
    'La vérification des mises à jour est désactivée sur ce déploiement.',
  'No release visible:': 'Aucune version visible :',
  'The server pulls the new image, restarts, and must pass the health gate — otherwise it rolls back to the current version by itself. Runs in flight are interrupted, and this page will lose the server for a minute before reloading on the new version.':
    'Le serveur télécharge la nouvelle image, redémarre, et doit passer le contrôle de santé — sinon il revient tout seul à la version actuelle. Les runs en cours sont interrompus, et cette page perdra le serveur une minute avant de se recharger sur la nouvelle version.',
  'Update now': 'Mettre à jour maintenant',

  /* ── Composeur et transcription ─────────────────────────────────────── */
  'Reset — back to Auto': 'Réinitialiser — retour à Auto',
  'Ultracode: this message fans out across sub-agents at maximum effort. Expect multi-agent token spend.':
    'Ultracode : ce message est réparti entre plusieurs sous-agents à effort maximal. Attendez-vous à une consommation de jetons multi-agents.',
  'Bypass mode: the agent will run commands and edit files without asking.':
    'Mode bypass : l’agent exécutera des commandes et modifiera des fichiers sans demander.',
  'Plan mode: the agent will research and propose, but execute nothing.':
    'Mode plan : l’agent cherchera et proposera, sans rien exécuter.',
  'Restore every file this run changed to the state it was in before the run started. Nothing else in the workspace is touched.':
    'Restaure chaque fichier modifié par ce run dans l’état où il était avant son démarrage. Rien d’autre dans le workspace n’est touché.',
  'Checking what this would restore…': 'Vérification de ce qui serait restauré…',
  'This run made no file changes, so there is nothing to undo.':
    'Ce run n’a modifié aucun fichier : il n’y a rien à annuler.',
  'This cannot be undone from here. Anything written since the run finished is overwritten too — the restore is to the point the run began, not a merge.':
    'C’est irréversible depuis ici. Tout ce qui a été écrit depuis la fin du run est également écrasé — la restauration ramène au démarrage du run, ce n’est pas une fusion.',
  'Requested:': 'Demandé :',
  'Was this useful?': 'Est-ce que cela a été utile ?',
  'Conversations started with the claude command in this directory will appear here.':
    'Les conversations lancées avec la commande claude dans ce répertoire apparaîtront ici.',
  "The CLI's session store could not be read.":
    'Le magasin de sessions du CLI n’a pas pu être lu.',

  /* ── Git et fichiers ────────────────────────────────────────────────── */
  'No diff to show — an untracked file has no previous version to compare against.':
    'Aucun diff à montrer — un fichier non suivi n’a pas de version antérieure à comparer.',
  'No commits yet.': 'Aucun commit pour l’instant.',
  'Clone one into this workspace, or start tracking the files that are already here.':
    'Clonez-en un dans ce workspace, ou commencez à suivre les fichiers déjà présents.',
  'https or ssh. A private repository needs its credentials already on the server.':
    'https ou ssh. Un dépôt privé exige que ses identifiants soient déjà sur le serveur.',
  'Nothing links here yet.': 'Rien ne pointe ici pour l’instant.',
  'Links to notes that do not exist yet:': 'Liens vers des notes qui n’existent pas encore :',

  /* ── Sessions ───────────────────────────────────────────────────────── */
  'Start one to give Metaclaude something to work on in this workspace.':
    'Démarrez-en une pour donner à Metaclaude de quoi travailler dans ce workspace.',
  '“{title}” and its run history are removed permanently. Files in the workspace are untouched.':
    '« {title} » et son historique de runs sont supprimés définitivement. Les fichiers du workspace ne sont pas touchés.',
  'That session could not be loaded.': 'Cette session n’a pas pu être chargée.',
  'The transcript and its run history are removed permanently. Files in the workspace are untouched.':
    'La transcription et son historique de runs sont supprimés définitivement. Les fichiers du workspace ne sont pas touchés.',
  'One moment.': 'Un instant.',
  'Conversations the CLI holds for this directory — including ones started in a terminal. Adopting one binds it here, so resuming and steering work as usual.':
    'Les conversations que le CLI conserve pour ce répertoire — y compris celles lancées dans un terminal. En adopter une la rattache ici : reprise et pilotage fonctionnent comme d’habitude.',

  /* ── Agents et skills ───────────────────────────────────────────────── */
  'Available in every workspace': 'Disponible dans tous les workspaces',
  'Its own definitions, plus the global ones': 'Ses propres définitions, plus les globales',
  "Enabled skills are written into the workspace's .claude/skills/ directory before every run, which is how the Claude CLI discovers them — nothing is injected into the prompt.":
    'Les skills activées sont écrites dans le répertoire .claude/skills/ du workspace avant chaque run : c’est ainsi que le CLI Claude les découvre — rien n’est injecté dans le prompt.',
  'Write one, or accept a skill proposal from the Memory page — the reflexion pass drafts them from runs that went well.':
    'Écrivez-en une, ou acceptez une proposition depuis la page Mémoire — la passe de réflexion les rédige à partir des runs réussis.',
  'Delete skill': 'Supprimer la skill',
  'The description is what the model reads when deciding whether to open the skill, so make it say when to use it.':
    'La description est ce que le modèle lit pour décider d’ouvrir la skill : dites-y quand l’utiliser.',
  'Lowercase and dashes; this is the directory name.':
    'Minuscules et tirets ; c’est le nom du répertoire.',
  'One sentence, written as a trigger condition.':
    'Une phrase, rédigée comme une condition de déclenchement.',
  'Markdown. Written verbatim to SKILL.md.': 'Markdown. Écrit tel quel dans SKILL.md.',
  Enabled: 'Activée',
  'Disabled skills stay in the registry but are not written to disk.':
    'Les skills désactivées restent au registre mais ne sont pas écrites sur le disque.',
  'A subagent runs in its own context window with its own prompt and tool budget, and reports a summary back. Use them to keep long side-quests out of the main transcript.':
    'Un sous-agent tourne dans sa propre fenêtre de contexte, avec son prompt et son budget d’outils, et renvoie un résumé. Utilisez-les pour garder les longues digressions hors de la transcription principale.',
  "The description tells the main agent when to delegate; the prompt is the subagent's entire system prompt.":
    'La description dit à l’agent principal quand déléguer ; le prompt est l’intégralité du prompt système du sous-agent.',
  'Define one to give a recurring job — code review, release notes, dependency triage — its own instructions.':
    'Définissez-en un pour donner ses propres instructions à une tâche récurrente — revue de code, notes de version, tri des dépendances.',
  'Delete subagent': 'Supprimer le sous-agent',
  'Lowercase and dashes.': 'Minuscules et tirets.',
  'When should the main agent hand work to this one?':
    'Quand l’agent principal doit-il confier du travail à celui-ci ?',
  "The subagent's system prompt, in full.": 'Le prompt système du sous-agent, en entier.',
  'Leave blank to inherit whatever the parent run is using.':
    'Laissez vide pour hériter de ce qu’utilise le run parent.',
  'Comma separated, e.g. Read, Grep, Glob. Leave blank to allow every tool the run has.':
    'Séparés par des virgules, par ex. Read, Grep, Glob. Laissez vide pour autoriser tous les outils du run.',
  'Disabled subagents cannot be selected by a run.':
    'Un sous-agent désactivé ne peut pas être choisi par un run.',
  "Each enabled server is started or connected at the beginning of a run, and its tools join the agent's tool list. A server that fails to connect is skipped rather than failing the run.":
    'Chaque serveur activé est démarré ou connecté au début d’un run, et ses outils rejoignent la liste d’outils de l’agent. Un serveur qui échoue à se connecter est ignoré plutôt que de faire échouer le run.',
  'Connect one to give the agent tools this system does not ship with — a database, an issue tracker, an internal API.':
    'Connectez-en un pour donner à l’agent des outils que ce système ne fournit pas — une base de données, un suivi de tickets, une API interne.',
  'Delete server': 'Supprimer le serveur',
  'Connection details are stored in the clear so they stay auditable; anything secret goes to the encrypted vault.':
    'Les détails de connexion sont stockés en clair pour rester auditables ; tout ce qui est secret part au coffre chiffré.',
  'Prefixes every tool this server exposes.': 'Préfixe chaque outil exposé par ce serveur.',
  'stdio launches a local process; sse and http reach a remote one.':
    'stdio lance un processus local ; sse et http en joignent un distant.',
  'stdio — local process': 'stdio — processus local',
  'sse — server-sent events': 'sse — événements poussés par le serveur',
  'http — streamable HTTP': 'http — HTTP en flux',
  'The executable, without its arguments.': 'L’exécutable, sans ses arguments.',
  'One per line, or separated by spaces.': 'Un par ligne, ou séparés par des espaces.',
  'Must be http or https.': 'Doit être en http ou https.',
  'Secrets are encrypted and never read back':
    'Les secrets sont chiffrés et jamais relus',
  'Values go into the encrypted vault; only the key names are stored on the record and only key names are ever returned. That is why every value box below is blank on an existing server — the value cannot be shown, not even to you.':
    'Les valeurs vont au coffre chiffré ; seuls les noms de clés sont stockés sur l’enregistrement et seuls des noms de clés sont renvoyés. C’est pourquoi chaque champ de valeur ci-dessous est vide sur un serveur existant — la valeur ne peut être affichée, pas même à vous.',
  'A value left blank keeps whatever is stored, so you only re-enter the ones you want to change. Delete a row to remove that key and its value for good.':
    'Une valeur laissée vide conserve ce qui est stocké : vous ne ressaisissez que celles que vous voulez changer. Supprimez une ligne pour retirer définitivement cette clé et sa valeur.',
  'Sent with every request. Sealed like the secrets above — an HTTP server usually authenticates with one.':
    'Envoyés à chaque requête. Scellés comme les secrets ci-dessus — un serveur HTTP s’authentifie généralement ainsi.',
  'Disabled servers are skipped when a run starts.':
    'Les serveurs désactivés sont ignorés au démarrage d’un run.',
  'None.': 'Aucun.',

  /* ── Analytique ─────────────────────────────────────────────────────── */
  Median: 'Médiane',
  'Run duration': 'Durée des runs',
  'Slowest 1 in 20': 'Le plus lent sur 20',
  '0–1, what the learner optimises': '0–1, ce que l’apprentissage optimise',
  'Share of runs that finished without error.':
    'Part des runs terminés sans erreur.',
  'Every workspace over this period, ranked by tokens. On a subscription this is the view that matters: the per-workspace filter tells you what one cost, and only this tells you which one is spending the ceiling.':
    'Tous les workspaces sur cette période, classés par jetons. Sur un abonnement, c’est la vue qui compte : le filtre par workspace dit ce qu’un workspace a coûté, et seule cette vue dit lequel consomme le plafond.',
  'Where the spend and the successes actually went.':
    'Où sont réellement passés la dépense et les succès.',
  'The classifier labels every prompt before it runs, and the learner keeps a separate policy per label — so a category with few runs is simply one it has not had much chance to tune.':
    'Le classifieur étiquette chaque prompt avant son exécution, et l’apprentissage tient une politique par étiquette — une catégorie avec peu de runs est simplement une catégorie qu’il a eu peu d’occasions d’affiner.',
  'The bandit starts forming a policy once runs finish and produce a reward.':
    'Le bandit commence à former une politique dès que des runs se terminent et produisent une récompense.',
  'Discard learning': 'Effacer l’apprentissage',
  "One Beta posterior per (category, model, effort) arm. The posterior mean is the learner's current belief that the arm succeeds; it samples from these rather than always taking the leader, which is why a weaker arm still gets occasional trials.":
    'Une loi bêta a posteriori par bras (catégorie, modèle, effort). La moyenne a posteriori est la croyance actuelle que le bras réussit ; l’apprentissage échantillonne plutôt que de toujours prendre le meneur, ce qui explique qu’un bras plus faible reçoive encore des essais.',

  /* ── Automatisations ────────────────────────────────────────────────── */
  'Scheduled and continuous agent loops.': 'Boucles d’agent planifiées et continues.',
  'The schedule is removed. Sessions and transcripts it already produced are kept.':
    'La planification est supprimée. Les sessions et transcriptions déjà produites sont conservées.',
  'A prompt plus a trigger. It runs exactly as a session you start yourself would.':
    'Un prompt et un déclencheur. Cela s’exécute exactement comme une session que vous lanceriez vous-même.',
  'What the agent should do each time this fires.':
    'Ce que l’agent doit faire à chaque déclenchement.',
  'Minutes between runs. Minimum 1.': 'Minutes entre deux runs. Minimum 1.',
  'Runs only when you press "Run now".':
    'Ne s’exécute que lorsque vous appuyez sur « Lancer maintenant ».',
  'Continue the same session on every firing instead of starting fresh. The agent keeps everything it has already learned in this loop, which is what makes long-running, self-directed work possible — and what makes its context grow over time.':
    'Poursuivre la même session à chaque déclenchement au lieu de repartir de zéro. L’agent conserve tout ce qu’il a appris dans cette boucle, ce qui rend possible un travail autonome de longue haleine — et fait croître son contexte avec le temps.',
  '0 disables the guard.': '0 désactive le garde-fou.',
  'In "Ask" mode an unattended run will stall on the first prompt and be declined after ten minutes. For a schedule, prefer "Plan", "Accept edits" or "Auto".':
    'En mode « Demander », un run sans surveillance se bloquera à la première question et sera refusé au bout de dix minutes. Pour une planification, préférez « Plan », « Accepter les modifications » ou « Auto ».',
  "Standard 5-field cron, in the server's timezone.":
    'Cron standard à 5 champs, dans le fuseau horaire du serveur.',

  /* ── Aide ───────────────────────────────────────────────────────────── */
  'Opens a plan-mode session in a workspace seeded with this guide — the assistant answers from these pages, with citations, and can execute nothing.':
    'Ouvre une session en mode plan dans un workspace alimenté par ce guide — l’assistant répond depuis ces pages, avec citations, et ne peut rien exécuter.',
  'Nothing in the guide matches all of those words.':
    'Rien dans le guide ne correspond à tous ces mots.',
  'The guide could not be loaded.': 'Le guide n’a pas pu être chargé.',
  "What's new": 'Nouveautés',

  /* ── Connexion ──────────────────────────────────────────────────────── */
  METACLAUDE_BOOTSTRAP_USER: 'METACLAUDE_BOOTSTRAP_USER',
  METACLAUDE_BOOTSTRAP_PASSWORD: 'METACLAUDE_BOOTSTRAP_PASSWORD',

  /* ── Mémoire ────────────────────────────────────────────────────────── */
  'Memories that apply everywhere': 'Mémoires valables partout',
  Total: 'Total',
  Episodic: 'Épisodique',
  'What happened in a run': 'Ce qui s’est passé dans un run',
  'Durable facts': 'Faits durables',
  Procedural: 'Procédurale',
  'How to do something': 'Comment faire quelque chose',
  'Plain keyword matching over titles, bodies and tags. It narrows the list below and nothing more.':
    'Simple correspondance de mots-clés sur les titres, contenus et étiquettes. Cela restreint la liste ci-dessous, rien de plus.',
  'e.g. migration, tsconfig, deploy': 'ex. migration, tsconfig, déploiement',
  'Runs the same embedding search the agent runs before a prompt. Results are ranked by meaning, not wording — this is what would actually be injected into context.':
    'Lance la même recherche vectorielle que l’agent avant un prompt. Les résultats sont classés par sens, pas par formulation — c’est ce qui serait réellement injecté dans le contexte.',
  'Nothing scored high enough. The agent would run this prompt with no recalled memory.':
    'Rien n’a obtenu un score suffisant. L’agent exécuterait ce prompt sans aucune mémoire rappelée.',
  'New lessons appear here as runs complete.':
    'De nouveaux enseignements apparaissent ici au fil des runs.',
  'Written straight into long-term memory and eligible for retrieval on the next run.':
    'Écrit directement en mémoire à long terme et éligible au rappel dès le prochain run.',
  'Corrections take effect immediately; the embedding is recomputed on save.':
    'Les corrections prennent effet immédiatement ; le vecteur est recalculé à l’enregistrement.',
  'Save changes': 'Enregistrer les modifications',
  'Delete memory': 'Supprimer la mémoire',
  'Chooses how the retriever weights this against a prompt.':
    'Détermine le poids que le moteur de rappel donne à cette mémoire face à un prompt.',
  'Episodic — what happened in a run': 'Épisodique — ce qui s’est passé dans un run',
  'Semantic — a durable fact': 'Sémantique — un fait durable',
  'Procedural — how to do something': 'Procédurale — comment faire quelque chose',
  'The retrieval key. One sentence works best.':
    'La clé de rappel. Une seule phrase fonctionne le mieux.',
  'Injected verbatim into the system prompt when recalled.':
    'Injecté tel quel dans le prompt système lors du rappel.',
  'Comma separated.': 'Séparés par des virgules.',
  'tooling, conventions': 'outillage, conventions',
  'How much the retriever should trust this. Reinforced when runs that used it succeed.':
    'À quel point le moteur de rappel doit s’y fier. Renforcé quand les runs qui l’ont utilisée réussissent.',
  'Exempt from decay and garbage collection.':
    'Exemptée de la décroissance et du ramasse-miettes.',
  "Distilled by the reflexion pass after a run. Proposals are never installed automatically — nothing here changes the agent's behaviour until you accept it.":
    'Distillé par la passe de réflexion après un run. Les propositions ne sont jamais installées automatiquement — rien ici ne change le comportement de l’agent tant que vous ne l’acceptez pas.',

  /* ── Plugins ────────────────────────────────────────────────────────── */
  'Marketplaces the CLI installs from, and Agent Plugins installed by path':
    'Marketplaces depuis lesquelles le CLI installe, et Agent Plugins installés par chemin',
  'The CLI fetches these sources itself and installs from them at the start of a run. Which plugins actually run is chosen per workspace, under Workspace settings.':
    'Le CLI récupère lui-même ces sources et installe depuis elles au démarrage d’un run. Les plugins réellement actifs se choisissent par workspace, dans ses réglages.',
  'An Agent Plugin is one directory holding skills and MCP server definitions, in the format published by Amazon, Cursor, Microsoft, OpenAI and Vercel. Clone one onto this server and install it by path.':
    'Un Agent Plugin est un répertoire contenant des skills et des définitions de serveurs MCP, au format publié par Amazon, Cursor, Microsoft, OpenAI et Vercel. Clonez-en un sur ce serveur et installez-le par son chemin.',
  'A directory on this server holding a plugin.json, in the Agent Plugins 1.0.0 format.':
    'Un répertoire de ce serveur contenant un plugin.json, au format Agent Plugins 1.0.0.',
  'The directory is copied, not linked, so the source can be deleted afterwards. Skills and MCP servers it declares become available to every workspace.':
    'Le répertoire est copié, pas lié : la source peut être supprimée ensuite. Les skills et serveurs MCP qu’il déclare deviennent disponibles pour tous les workspaces.',
  'Its skills and MCP servers stop being offered to runs, and its files are deleted. Anything it had stored is kept, so reinstalling it restores that state.':
    'Ses skills et serveurs MCP cessent d’être proposés aux runs, et ses fichiers sont supprimés. Ce qu’il avait stocké est conservé : le réinstaller restaure cet état.',
  'Runs stop seeing this source, and every plugin enabled from it stops loading. Nothing already installed by the CLI is deleted.':
    'Les runs cessent de voir cette source, et chaque plugin activé depuis elle cesse de se charger. Rien de ce que le CLI a déjà installé n’est supprimé.',
  'Plugins from it bring skills, hooks and MCP servers into the agent — add sources you trust as you would a dependency.':
    'Ses plugins apportent skills, hooks et serveurs MCP à l’agent — ajoutez des sources de confiance, comme vous le feriez d’une dépendance.',
  'owner/repo, or https://…/marketplace.json': 'propriétaire/dépôt, ou https://…/marketplace.json',

  /* ── Réglages du workspace ──────────────────────────────────────────── */
  'That workspace could not be loaded.': 'Ce workspace n’a pas pu être chargé.',
  'Defaults for every session started in this workspace.':
    'Valeurs par défaut de chaque session lancée dans ce workspace.',
  'Recall long-term memory': 'Rappeler la mémoire à long terme',
  "Inject what Metaclaude learned in earlier sessions into each run's context.":
    'Injecter dans le contexte de chaque run ce que Metaclaude a appris lors des sessions précédentes.',
  'Choose the model automatically': 'Choisir le modèle automatiquement',
  'Pick model and effort from what has performed best on similar tasks here.':
    'Choisir modèle et effort d’après ce qui a le mieux fonctionné sur des tâches similaires ici.',
  'Reflect after each run': 'Réfléchir après chaque run',
  'Run a small, tool-less pass that extracts durable lessons from what happened.':
    'Lancer une petite passe sans outils qui extrait des enseignements durables de ce qui s’est passé.',
  'File checkpointing': 'Points de restauration des fichiers',
  'Track file changes so a run can be rewound.':
    'Suivre les modifications de fichiers pour pouvoir rembobiner un run.',
  'Work the board by itself': 'Travailler le board tout seul',
  "When a card run ends, start the top To do card automatically — one card at a time, success lands in Review, and the quota guard pauses automatic starts near the plan's ceiling.":
    'À la fin du run d’une carte, démarrer automatiquement la première carte À faire — une carte à la fois, un succès atterrit en Review, et le garde-fou de quota suspend les démarrages automatiques près du plafond du forfait.',
  'Let the advisor study this workspace daily':
    'Laisser l’advisor étudier ce workspace chaque jour',
  'At most once a day, an advisor run reads recent runs, the board and the registry, creates backlog tickets and disabled automations, and leaves anything that would act — skills, agents, vetted MCP servers — in the Dashboard inbox for you to accept. The manual button works either way.':
    'Au plus une fois par jour, un run d’advisor lit les runs récents, le board et le registre, crée des tickets de backlog et des automatisations désactivées, et dépose tout ce qui agirait — skills, agents, serveurs MCP validés — dans la boîte du tableau de bord, pour votre acceptation. Le bouton manuel fonctionne dans tous les cas.',
  'Mirror sessions to claude.ai': 'Refléter les sessions vers claude.ai',
  "Publish view-only copies of this workspace's sessions to your Claude account. Works only while the CLI account sign-in is the live credential — a paired token is inference-only. See the guide's sessions chapter.":
    'Publier des copies en lecture seule des sessions de ce workspace vers votre compte Claude. Ne fonctionne que si la connexion au compte via le CLI est l’identifiant actif — un jeton appairé ne couvre que l’inférence. Voyez le chapitre sessions du guide.',
  'Plugins the CLI installs from the marketplaces added under Plugins. Enabled ones load into every run of this workspace.':
    'Les plugins que le CLI installe depuis les marketplaces ajoutées dans Plugins. Ceux activés se chargent dans chaque run de ce workspace.',
  'Blank means no limit.': 'Vide signifie sans limite.',
  'Stops a run once it reaches this cost.': 'Arrête un run dès qu’il atteint ce coût.',
  'Subagents carry English prompts, so delegated work comes back in English however you wrote the request. Pinning a language settles the whole run, delegations included. Code and command output are never translated.':
    'Les sous-agents portent des prompts en anglais : le travail délégué revient en anglais quelle que soit la langue de votre demande. Fixer une langue règle tout le run, délégations comprises. Le code et les sorties de commandes ne sont jamais traduits.',
  "Appended to Claude Code's own system prompt for every run here. Project conventions, things to avoid, house style.":
    'Ajouté au prompt système de Claude Code pour chaque run ici. Conventions du projet, choses à éviter, style maison.',

  /* ── Espaces ────────────────────────────────────────────────────────── */
  'Each workspace is a project directory with its own agent policy and memory.':
    'Chaque workspace est un répertoire de projet avec sa propre politique d’agent et sa mémoire.',
  'Create one to give the agent a project directory to work in. You can start empty or clone a git repository.':
    'Créez-en un pour donner à l’agent un répertoire de projet où travailler. Vous pouvez partir de zéro ou cloner un dépôt git.',
  'A directory the agent can work in, with its own settings, memory and automations.':
    'Un répertoire où l’agent peut travailler, avec ses propres réglages, sa mémoire et ses automatisations.',
  'Optional. Leave blank to start from an empty directory with a starter CLAUDE.md.':
    'Facultatif. Laissez vide pour démarrer d’un répertoire vide avec un CLAUDE.md initial.',
  'Its sessions, transcripts, memories and automations are removed permanently.':
    'Ses sessions, transcriptions, mémoires et automatisations sont supprimées définitivement.',

  /* ── Valeurs de constantes traduites au rendu (`t(entry.label)`) ─────── */
  /* Noms de modèles et de produits laissés tels quels : ce sont des noms. */
  'needs auth': 'authentification requise',
  Terminal: 'Terminal',
  'Find files': 'Trouver des fichiers',
  Fetch: 'Requête web',
  'Web search': 'Recherche web',
  Staged: 'Indexés',
  Modified: 'Modifiés',
  Untracked: 'Non suivis',
  Conflicted: 'En conflit',
  'Let Metaclaude choose from what it has learned':
    'Laisser Metaclaude choisir d’après ce qu’il a appris',
  Fable: 'Fable',
  'The Claude 5 flagship — above Opus, priced to match':
    'Le fleuron de Claude 5 — au-dessus d’Opus, tarifé en conséquence',
  Opus: 'Opus',
  'Deepest reasoning, highest cost': 'Raisonnement le plus profond, coût le plus élevé',
  Sonnet: 'Sonnet',
  'Balanced — the everyday choice': 'Équilibré — le choix du quotidien',
  Haiku: 'Haiku',
  'Fastest and cheapest, for simple tasks': 'Le plus rapide et le moins cher, pour les tâches simples',
  'Opus plan': 'Opus plan',
  'Opus to plan, Sonnet to execute': 'Opus pour planifier, Sonnet pour exécuter',
  'Very high': 'Très élevé',
  Maximum: 'Maximum',
  "The product's own guide, and the assistant that answers from it.":
    'Le guide du produit, et l’assistant qui y répond.',
  'The connection is retried on the next run in this workspace.':
    'La connexion sera retentée au prochain run de ce workspace.',
  'Its stored secrets were deleted with it.':
    'Ses secrets stockés ont été supprimés avec lui.',
  '30 days': '30 jours',
  '90 days': '90 jours',
  'Every hour': 'Toutes les heures',
  'Every 4 hours': 'Toutes les 4 heures',
  'Daily at 09:00': 'Chaque jour à 09:00',
  'Weekdays at 09:00': 'En semaine à 09:00',
  'Weekly, Monday 09:00': 'Chaque semaine, lundi 09:00',
  'Monthly, 1st at 09:00': 'Chaque mois, le 1er à 09:00',
  Decay: 'Décroissance',
  'Lower the confidence of memories that have not been retrieved recently, so stale facts stop outranking fresh ones. Pinned memories are exempt.':
    'Baisser la confiance des mémoires qui n’ont pas été rappelées récemment, pour que des faits périmés cessent de devancer les récents. Les mémoires épinglées sont exemptées.',
  Collect: 'Ramasser',
  'Delete unpinned memories whose confidence has decayed below the keep threshold. This is the only maintenance action that removes rows.':
    'Supprimer les mémoires non épinglées dont la confiance est passée sous le seuil de conservation. C’est la seule action de maintenance qui supprime des lignes.',
  'Recompute every embedding. Needed after switching embedding provider, otherwise semantic recall compares vectors from two different spaces.':
    'Recalculer tous les vecteurs. Nécessaire après un changement de fournisseur d’embeddings, faute de quoi le rappel sémantique compare des vecteurs de deux espaces différents.',
  'It is now in the skills registry and available to future runs.':
    'Elle est désormais au registre des skills et disponible pour les prochains runs.',
  'Follow the request': 'Suivre la demande',
  'No instruction at all — the agent answers in the language it was written to.':
    'Aucune instruction — l’agent répond dans la langue dans laquelle on lui écrit.',
  'Every answer in French, subagents included.':
    'Toutes les réponses en français, sous-agents compris.',
  'Every answer in English, subagents included.':
    'Toutes les réponses en anglais, sous-agents compris.',

  /* ── Confirmations et libellés à emplacement ────────────────────────── */
  'Cost ceiling (USD)': 'Plafond de coût (USD)',
  URL: 'URL',
  'No session matches “{filter}”.': 'Aucune session ne correspond à « {filter} ».',
  '{name} is removed from the registry and will not be written into any workspace again.':
    '{name} est retirée du registre et ne sera plus écrite dans aucun workspace.',
  '{name} is removed from the registry. Sessions that name it will fall back to the main agent.':
    '{name} est retiré du registre. Les sessions qui le nomment se rabattront sur l’agent principal.',
  '{name} is removed and its stored secrets are erased from the vault. Its tools disappear from every run in this scope.':
    '{name} est supprimé et ses secrets stockés sont effacés du coffre. Ses outils disparaissent de tous les runs de cette portée.',
  '{title} is removed permanently and will no longer be retrieved into any run.':
    '{title} est supprimée définitivement et ne sera plus rappelée dans aucun run.',
  'Every policy arm and every classifier exemplar for {scope} is discarded. The system forgets which model and effort worked for which kind of task, and starts exploring from nothing. Runs, costs and memories are untouched, and this cannot be undone.':
    'Chaque bras de politique et chaque exemple du classifieur pour {scope} est abandonné. Le système oublie quel modèle et quel effort fonctionnaient pour quel type de tâche, et repart d’une exploration à zéro. Les runs, les coûts et les mémoires ne sont pas touchés, et c’est irréversible.',

  'next automation: {name}': 'prochaine automatisation : {name}',
  '{requests} requests · {sessions} sessions': '{requests} requêtes · {sessions} sessions',
  'Show {n} more lines': 'Afficher {n} lignes de plus',
  'tools steered': 'outils orientés',

  'The CLI is signed in with a Claude account{plan}{scope} — runs use that sign-in. Pairing a token below would override it.':
    'La CLI est connectée avec un compte Claude{plan}{scope} — les runs utilisent cette connexion. Appairer un jeton ci-dessous la remplacerait.',
  ', full scope': ', portée complète',
  ', inference only': ', inférence seule',
  'A CLI account sign-in also exists{scope}, but the {source} token overrides it. Remove the token to let the account sign-in take over.':
    'Une connexion par compte CLI existe aussi{scope}, mais le jeton {source} la remplace. Retirez le jeton pour laisser la connexion par compte reprendre la main.',
  ' (full scope — claude.ai session sync)': ' (portée complète — synchronisation de session claude.ai)',
  'paired': 'appairé',
  'environment': "d’environnement",
  'A token beginning {oat} uses your Pro or Max subscription — {command} on any signed-in machine prints one. One beginning {api} bills per token instead. Metaclaude tells them apart on its own.':
    'Un jeton commençant par {oat} utilise votre abonnement Pro ou Max — {command} sur n’importe quelle machine connectée en affiche un. Un jeton commençant par {api} est facturé au token. Metaclaude les distingue tout seul.',
  '{latest} is published; this server runs {current}.':
    '{latest} est publiée ; ce serveur exécute {current}.',
  'Up to date — {current} is the latest release.':
    'À jour — {current} est la dernière version.',
  'The latest tag ({latest}) is not a version, so no comparison is possible.':
    'Le dernier tag ({latest}) n’est pas une version, aucune comparaison n’est donc possible.',
  'none': 'aucun',
  'Applying from here needs the host updater — re-run {script} on the server to add it.':
    'Appliquer depuis ici nécessite le programme de mise à jour de l’hôte — relancez {script} sur le serveur pour l’ajouter.',
  '{in} in · {out} out · {cached} cached': '{in} entrée · {out} sortie · {cached} en cache',
  'used {count}× · updated {when}': 'utilisée {count}× · modifiée {when}',
  '{n} being worked': '{n} en cours',
  '{n} in review': '{n} en relecture',
  'Set {user} and {password} in your {file}, then restart the container.':
    'Renseignez {user} et {password} dans votre {file}, puis redémarrez le conteneur.',
  '{kind} · confidence {value}': '{kind} · confiance {value}',
  'Confidence — {value}': 'Confiance — {value}',

  ', {share}% of the period': ', {share} % de la période',
  '{name}: {tokens} tokens across {n} run': '{name} : {tokens} tokens sur {n} run',
  '{name}: {tokens} tokens across {n} runs': '{name} : {tokens} tokens sur {n} runs',
  '{n} run': '{n} run',
  '{n} new insight': '{n} nouvel enseignement',
  '{n} new insights': '{n} nouveaux enseignements',
  'Remove marketplace {name}': 'Retirer la place de marché {name}',
  'Paired with your Claude subscription.': 'Appairé avec votre abonnement Claude.',
  'Could not start pairing.': "L’appairage n’a pas pu démarrer.",
  'Pairing failed.': "L’appairage a échoué.",
  'Could not save that credential.': "Cet identifiant n’a pas pu être enregistré.",
  'Credential removed.': 'Identifiant retiré.',
  'Save token': 'Enregistrer le jeton',
  'the new version': 'la nouvelle version',
  'The update could not be requested.': "La mise à jour n’a pas pu être demandée.",
  'Updated to {version} — reloading…': 'Mis à jour en {version} — rechargement…',
  'Update to {version}?': 'Mettre à jour en {version} ?',
  'Ask Metaclaude to do something…': 'Demandez quelque chose à Metaclaude…',
  'Remove {name}': 'Retirer {name}',
  'Attach files — up to {maxPerMessage} per message. Drag & drop and pasted screenshots work too.':
    'Joindre des fichiers — jusqu’à {maxPerMessage} par message. Le glisser-déposer et les captures collées fonctionnent aussi.',
  'Fan the work out across sub-agents that explore, verify and contradict each other. Maximum effort — and token spend to match.':
    'Répartit le travail entre des sous-agents qui explorent, vérifient et se contredisent. Effort maximal — et consommation de tokens à l’avenant.',
  'Ultracode needs a model that can orchestrate — under Auto the learner may pick one that cannot. Choose a model (Fable, Opus…) to enable it.':
    'Ultracode exige un modèle capable d’orchestrer — en mode Auto, l’apprentissage peut en choisir un qui ne le peut pas. Choisissez un modèle (Fable, Opus…) pour l’activer.',
  'Waiting for the upload to finish': "Attente de la fin de l’envoi",
  'Enter to send · Shift+Enter for a new line': 'Entrée pour envoyer · Maj+Entrée pour un saut de ligne',
  'Skills required: {skills}': 'Compétences requises : {skills}',
  'Restore files': 'Restaurer les fichiers',
  'Restore {n} file': 'Restaurer {n} fichier',
  'Restore {n} files': 'Restaurer {n} fichiers',
  '{n} file': '{n} fichier',
  '{n} files': '{n} fichiers',
  'This run cannot be rewound.': 'Ce run ne peut pas être rembobiné.',
  'Nothing was restored.': "Rien n’a été restauré.",
  'Restored, but {n} file was left alone: a symbolic link, a hard link or a moved directory made restoring it unsafe. Check that path by hand.':
    'Restauré, mais {n} fichier a été laissé de côté : un lien symbolique, un lien physique ou un répertoire déplacé rendait sa restauration risquée. Vérifiez ce chemin à la main.',
  'Restored, but {n} files were left alone: a symbolic link, a hard link or a moved directory made restoring them unsafe. Check those paths by hand.':
    'Restauré, mais {n} fichiers ont été laissés de côté : un lien symbolique, un lien physique ou un répertoire déplacé rendait leur restauration risquée. Vérifiez ces chemins à la main.',
  'Restored {n} file to its state before the run.':
    '{n} fichier restauré dans son état d’avant le run.',
  'Restored {n} files to their state before the run.':
    '{n} fichiers restaurés dans leur état d’avant le run.',
  'Copy input': "Copier l’entrée",
  'Restore the files this run changed': 'Restaurer les fichiers modifiés par ce run',
  '{n} turn': '{n} tour',
  '{n} turns': '{n} tours',
  adopted: 'adoptée',
  'The directory may have been moved or deleted.': 'Le répertoire a peut-être été déplacé ou supprimé.',
  'Nothing matched': 'Aucun résultat',
  'This folder is empty': 'Ce dossier est vide',
  'No file name contains “{query}”.': 'Aucun nom de fichier ne contient « {query} ».',
  'Saved {path}': '{path} enregistré',
  'Could not save the file.': "Le fichier n’a pas pu être enregistré.",
  'Save ({shortcut})': 'Enregistrer ({shortcut})',
  'The file could not be read.': "Le fichier n’a pas pu être lu.",
  'Contents of {path}': 'Contenu de {path}',
  'This file is not text': "Ce fichier n’est pas du texte",
  'This file no longer exists': "Ce fichier n’existe plus",
  'This file could not be opened': "Ce fichier n’a pas pu être ouvert",
  'Could not stage those files.': "Ces fichiers n’ont pas pu être indexés.",
  'Could not unstage those files.': "Ces fichiers n’ont pas pu être désindexés.",
  'Committed {hash}': 'Commit {hash}',
  'The commit failed.': 'Le commit a échoué.',
  'The repository status could not be read.': "L’état du dépôt n’a pas pu être lu.",
  staged: 'indexé',
  'That diff could not be loaded.': "Ce diff n’a pas pu être chargé.",
  'Now tracking this workspace with git.': 'Cet espace de travail est désormais suivi par git.',
  'Remote added and fetched. Your existing files were left untouched.':
    'Dépôt distant ajouté et récupéré. Vos fichiers existants n’ont pas été touchés.',
  'Could not connect that repository.': "Ce dépôt n’a pas pu être connecté.",
  'Open {title}': 'Ouvrir {title}',
  'Local graph of {title}': 'Graphe local de {title}',
  'Could not pin the session.': "La session n’a pas pu être épinglée.",
  'Session archived': 'Session archivée',
  'Could not archive the session.': "La session n’a pas pu être archivée.",
  'Session deleted': 'Session supprimée',
  'Could not delete the session.': "La session n’a pas pu être supprimée.",
  'Pin to top': 'Épingler en haut',
  'Scope: {scope}': 'Portée : {scope}',
  'Could not save that skill.': "Cette compétence n’a pas pu être enregistrée.",
  'Skill deleted': 'Compétence supprimée',
  'Could not delete that skill.': "Cette compétence n’a pas pu être supprimée.",
  'Could not change that skill.': "Cette compétence n’a pas pu être modifiée.",
  'auto-generated': 'générée automatiquement',
  'Delete skill {name}': 'Supprimer la compétence {name}',
  'Use lowercase letters, digits and dashes only, starting with a letter or digit — for example “review-migrations”. It becomes a directory name.':
    'Uniquement des minuscules, des chiffres et des tirets, en commençant par une lettre ou un chiffre — par exemple « review-migrations ». Cela devient un nom de répertoire.',
  'Edit skill': 'Modifier la compétence',
  'Could not save that subagent.': "Ce sous-agent n’a pas pu être enregistré.",
  'Subagent deleted': 'Sous-agent supprimé',
  'Could not delete that subagent.': "Ce sous-agent n’a pas pu être supprimé.",
  'Could not change that subagent.': "Ce sous-agent n’a pas pu être modifié.",
  'model:': 'modèle :',
  'tools:': 'outils :',
  'Delete subagent {name}': 'Supprimer le sous-agent {name}',
  'Use lowercase letters, digits and dashes only — for example “release-notes”. This is the name a run refers to.':
    'Uniquement des minuscules, des chiffres et des tirets — par exemple « release-notes ». C’est le nom auquel un run fait référence.',
  'Edit subagent': 'Modifier le sous-agent',
  'Could not save that server.': "Ce serveur n’a pas pu être enregistré.",
  'Server deleted': 'Serveur supprimé',
  'Could not delete that server.': "Ce serveur n’a pas pu être supprimé.",
  'Delete server {name}': 'Supprimer le serveur {name}',
  'Edit MCP server': 'Modifier le serveur MCP',
  'New MCP server': 'Nouveau serveur MCP',
  'Environment secrets': "Secrets d’environnement",
  'Paste the value': 'Collez la valeur',
  'entry {n}': "l’entrée {n}",
  '{n} encrypted secret: {keys}': '{n} secret chiffré : {keys}',
  '{n} encrypted secrets: {keys}': '{n} secrets chiffrés : {keys}',
  'Could not read what Claude offers.': "Impossible de lire ce que Claude propose.",
  'Learning reset': 'Apprentissage réinitialisé',
  'Could not reset the policy.': "La politique n’a pas pu être réinitialisée.",
  'Period: {period}': 'Période : {period}',
  'Bucketed by {granularity}': 'Regroupé par {granularity}',
  'The plan windows, as the CLI reports them.': 'Les fenêtres du forfait, telles que la CLI les rapporte.',
  'The server did not answer.': "Le serveur n’a pas répondu.",
  'Nothing was executed in {scope} over the last {period}. Widen the period, or start a session.':
    "Rien n’a été exécuté dans {scope} au cours de {period}. Élargissez la période, ou démarrez une session.",
  'Executions per {granularity}.': 'Exécutions par {granularity}.',
  'No explanation recorded for this category yet.':
    'Aucune explication enregistrée pour cette catégorie pour le moment.',
  "The {subscriptionType} plan's windows, as the CLI reports them.":
    'Les fenêtres du forfait {subscriptionType}, telles que la CLI les rapporte.',
  trials: 'essais',
  'Automation started': 'Automatisation démarrée',
  'Could not run the automation.': "L’automatisation n’a pas pu être exécutée.",
  'Automation deleted': 'Automatisation supprimée',
  'Unknown workspace': 'Espace de travail inconnu',
  'Create a workspace first — an automation always runs inside one.':
    'Créez d’abord un espace de travail — une automatisation s’exécute toujours dans l’un d’eux.',
  'Give the agent a prompt and a schedule. It runs with the same permissions, memory and learning as a session you start by hand.':
    'Donnez à l’agent une consigne et un horaire. Il s’exécute avec les mêmes permissions, la même mémoire et le même apprentissage qu’une session lancée à la main.',
  'Each firing continues the same session, so context accumulates across runs.':
    'Chaque déclenchement poursuit la même session, le contexte s’accumule donc au fil des runs.',
  continuous: 'continue',
  paused: 'en pause',
  '{n} consecutive failure': '{n} échec consécutif',
  '{n} consecutive failures': '{n} échecs consécutifs',
  last: 'dernier',
  next: 'prochain',
  'Run {name} now': 'Exécuter {name} maintenant',
  'More actions for {name}': "Plus d’actions pour {name}",
  'Automation updated': 'Automatisation modifiée',
  'Automation created': 'Automatisation créée',
  'Could not save the automation.': "L’automatisation n’a pas pu être enregistrée.",
  'Edit automation': "Modifier l’automatisation",
  'Choose a workspace': 'Choisissez un espace de travail',
  'Claude CLI {version} · {auth}': 'CLI Claude {version} · {auth}',
  'Model chosen by the learned policy': 'Modèle choisi par la politique apprise',
  'Could not start the help session.': "La session d’aide n’a pas pu démarrer.",
  'You are on Metaclaude {version}. The guide below ships with it.':
    'Vous êtes sur Metaclaude {version}. Le guide ci-dessous est fourni avec.',
  'Merged into an existing memory': 'Fusionné dans une mémoire existante',
  'Memory added': 'Mémoire ajoutée',
  'Could not save that memory.': "Cette mémoire n’a pas pu être enregistrée.",
  'Could not update that memory.': "Cette mémoire n’a pas pu être mise à jour.",
  'Memory deleted': 'Mémoire supprimée',
  'Could not delete that memory.': "Cette mémoire n’a pas pu être supprimée.",
  'Maintenance failed.': 'La maintenance a échoué.',
  'Insight accepted': 'Enseignement accepté',
  'Insight rejected': 'Enseignement rejeté',
  'Could not update that insight.': "Cet enseignement n’a pas pu être mis à jour.",
  'Nothing distilled — the procedures do not cohere into one skill yet.':
    'Rien de distillé — les procédures ne forment pas encore une compétence cohérente.',
  'The synthesis could not run.': "La synthèse n’a pas pu s’exécuter.",
  'Could not install that skill.': "Cette compétence n’a pas pu être installée.",
  'Memory scope: {scope}': 'Portée de la mémoire : {scope}',
  'Similarity score {score}': 'Score de similarité {score}',
  shown: 'affichées',
  'Nothing matches those filters': 'Aucun résultat pour ces filtres',
  'No memories yet': 'Aucune mémoire pour le moment',
  'Try a broader kind, or clear the keyword filter.':
    'Essayez un type plus large, ou effacez le filtre par mot-clé.',
  'Memories accumulate as runs finish and the reflexion pass distils them. You can also write one yourself.':
    'Les mémoires s’accumulent à mesure que les runs se terminent et que la passe de réflexion les distille. Vous pouvez aussi en écrire une vous-même.',
  confidence: 'confiance',
  'Unpin {title}': 'Désépingler {title}',
  'Pin {title}': 'Épingler {title}',
  pinned: 'épinglée',
  'Show less': 'Voir moins',
  'Show more': 'Voir plus',
  used: 'utilisée',
  succeeded: 'réussis',
  updated: 'modifiée',
  'Confidence {value}': 'Confiance {value}',
  "Read this workspace's accumulated procedures and, if they cohere, draft one skill — as a proposal below, never installed directly.":
    'Lit les procédures accumulées dans cet espace de travail et, si elles sont cohérentes, rédige une compétence — sous forme de proposition ci-dessous, jamais installée directement.',
  'Marketplace {name} added.': 'Place de marché {name} ajoutée.',
  'That marketplace could not be added.': "Cette place de marché n’a pas pu être ajoutée.",
  'That marketplace could not be changed.': "Cette place de marché n’a pas pu être modifiée.",
  'Marketplace removed.': 'Place de marché retirée.',
  'That marketplace could not be removed.': "Cette place de marché n’a pas pu être retirée.",
  'Installed {name} — {parts}.': '{name} installé — {parts}.',
  'That plugin could not be installed.': "Ce plugin n’a pas pu être installé.",
  'That plugin could not be changed.': "Ce plugin n’a pas pu être modifié.",
  'Plugin removed.': 'Plugin retiré.',
  'That plugin could not be removed.': "Ce plugin n’a pas pu être retiré.",
  'Remove plugin {name}': 'Retirer le plugin {name}',
  'Remove {name}?': 'Retirer {name} ?',
  'this plugin': 'ce plugin',
  'this marketplace': 'cette place de marché',
  installed: 'installé',
  'Could not start the run.': "Le run n’a pas pu démarrer.",
  'Unknown device': 'Appareil inconnu',
  '{browser} on {platform}': '{browser} sur {platform}',
  'Signed out {n} other device': '{n} autre appareil déconnecté',
  'Signed out {n} other devices': '{n} autres appareils déconnectés',
  'of {n} core': 'sur {n} cœur',
  'of {n} cores': 'sur {n} cœurs',
  'Could not start a session.': "La session n’a pas pu démarrer.",
  'Could not adopt that session.': "Cette session n’a pas pu être adoptée.",
  running: 'en cours',
  waiting: 'en attente',
  'Settings saved': 'Réglages enregistrés',
  'Could not save the settings.': "Les réglages n’ont pas pu être enregistrés.",
  'Workspace archived': 'Espace de travail archivé',
  'Workspace restored': 'Espace de travail restauré',
  'Workspace and files deleted': 'Espace de travail et fichiers supprimés',
  'Workspace removed': 'Espace de travail retiré',
  'Could not delete the workspace.': "L’espace de travail n’a pas pu être supprimé.",
  'Hide archived': 'Masquer les archivés',
  'Show archived': 'Afficher les archivés',
  archived: 'archivé',
  learning: 'apprentissage',
  bypass: 'contournement',
  'Actions for {name}': 'Actions pour {name}',
  'Workspace created': 'Espace de travail créé',
  'Use colour {swatch}': 'Utiliser la couleur {swatch}',
  'Delete workspace and files': "Supprimer l’espace de travail et les fichiers",
  'Delete workspace': "Supprimer l’espace de travail",
  '{n} card': '{n} carte',
  '{n} cards': '{n} cartes',
  'sub-task': 'sous-tâche',
  disabled: 'désactivé',
  failed: 'échoué',
  error: 'erreur',
  global: 'global',
  update: 'mise à jour',
  tokens: 'tokens',
  '{n} tool exposed': '{n} outil exposé',
  '{n} tools exposed': '{n} outils exposés',
  'Good — reinforce this approach': 'Bon — renforcer cette approche',
  'Poor — try something else next time': 'Médiocre — essayer autre chose la prochaine fois',
  'Everything checks out.': 'Tout est en ordre.',
  'Working, with something worth a look.': 'Fonctionne, avec un point à regarder.',
  'Something needs attention.': 'Quelque chose demande votre attention.',
  'ok': 'ok',
  'warn': 'alerte',
  'fail': 'échec',
  'Explain how this project is structured': 'Explique comment ce projet est structuré',
  'Find and fix any failing tests': 'Trouve et corrige les tests en échec',
  'Review my recent changes': 'Relis mes modifications récentes',
  'Read': 'Lire',
  'Write': 'Écrire',
  'Edit': 'Modifier',
  'Search': 'Rechercher',
  'Subagent': 'Sous-agent',
  '{n} entry changed': '{n} entrée modifiée',
  '{n} entries changed': '{n} entrées modifiées',
  'Delete {n} skill?': 'Supprimer {n} compétence ?',
  'Delete {n} skills?': 'Supprimer {n} compétences ?',
  'Delete {n} subagent?': 'Supprimer {n} sous-agent ?',
  'Delete {n} subagents?': 'Supprimer {n} sous-agents ?',
  '{n} step left before everything this can do is switched on.': '{n} étape avant que tout ce que cela sait faire soit activé.',
  '{n} steps left before everything this can do is switched on.': '{n} étapes avant que tout ce que cela sait faire soit activé.',
  '{n} run working right now': '{n} run au travail en ce moment',
  '{n} runs working right now': '{n} runs au travail en ce moment',
  '{n} decision waiting on you': '{n} décision vous attend',
  '{n} decisions waiting on you': '{n} décisions vous attendent',
  'Sent to {n} device.': 'Envoyé à {n} appareil.',
  'Sent to {n} devices.': 'Envoyé à {n} appareils.',
  '{n} device subscribed but the test could not be delivered{err}.': '{n} appareil inscrit, mais le test n’a pas pu être livré{err}.',
  '{n} devices subscribed but the test could not be delivered{err}.': '{n} appareils inscrits, mais le test n’a pas pu être livré{err}.',
  '{n} device subscribed across the deployment.': '{n} appareil inscrit sur le déploiement.',
  '{n} devices subscribed across the deployment.': '{n} appareils inscrits sur le déploiement.',
  '{n} server did not connect': '{n} serveur n’a pas répondu',
  '{n} servers did not connect': '{n} serveurs n’ont pas répondu',
  '{n} action waiting for you': '{n} action en attente de votre décision',
  '{n} actions waiting for you': '{n} actions en attente de votre décision',
  '{n} recovery code remaining.': '{n} code de récupération restant.',
  '{n} recovery codes remaining.': '{n} codes de récupération restants.',
  '{n} key enrolled': '{n} clé enrôlée',
  '{n} keys enrolled': '{n} clés enrôlées',
  '{n} card blocked': '{n} carte bloquée',
  '{n} cards blocked': '{n} cartes bloquées',
  '{n} due soon': '{n} à échéance proche',
  'A quiet day — no runs in the last 24 hours, and every self-check passes.': 'Journée calme — aucun run sur les dernières 24 heures, et toutes les auto-vérifications passent.',
  'No runs in the last 24 hours': 'Aucun run sur les dernières 24 heures',
  'the doctor reports {status}': 'le doctor rapporte {status}',
  '{n} run in the last 24 hours': '{n} run sur les dernières 24 heures',
  '{n} runs in the last 24 hours': '{n} runs sur les dernières 24 heures',
  '{n} failure worth a look': '{n} échec à regarder',
  '{n} failures worth a look': '{n} échecs à regarder',
  '{n} approval waiting on you': '{n} approbation vous attend',
  '{n} approvals waiting on you': '{n} approbations vous attendent',
  '{n} card waiting for review': '{n} carte en attente de relecture',
  '{n} cards waiting for review': '{n} cartes en attente de relecture',
  Browser: 'Navigateur',
  Unknown: 'Inconnu',
  'Create a workspace first — a server is connected for a run, and a run happens in one.': 'Créez d’abord un espace de travail — un serveur est connecté pour un run, et un run s’exécute dans l’un d’eux.',
  'Test in which workspace?': 'Tester dans quel espace de travail ?',
  'No server was mounted in {workspace}.': 'Aucun serveur monté dans {workspace}.',
  'Every server answered in {workspace}.': 'Tous les serveurs ont répondu dans {workspace}.',
  "Don't ask": 'Ne pas demander',
  'Research and propose only. No tool is ever executed.': 'Étudie et propose seulement. Aucun outil n’est jamais exécuté.',
  'Ask before anything that writes, deletes or runs a command.': 'Demande avant toute écriture, suppression ou commande.',
  'File edits apply automatically; commands still need approval.': 'Les modifications de fichiers s’appliquent automatiquement ; les commandes demandent toujours une approbation.',
  'A classifier decides, and asks you only when it is unsure.': 'Un classifieur décide, et ne vous demande qu’en cas de doute.',
  'Never prompt. Anything not pre-approved is denied outright.': 'Ne demande jamais. Tout ce qui n’est pas pré-approuvé est refusé d’emblée.',
  'No permission checks at all. Only for disposable sandboxes.': 'Aucun contrôle de permission. Uniquement pour des bacs à sable jetables.',
  'Paste a token first.': 'Collez d’abord un jeton.',
  'Paste the code first.': 'Collez d’abord le code.',
  'Enter a 6-digit code or a recovery code.': 'Saisissez un code à 6 chiffres ou un code de récupération.',
  'The push endpoint must be https.': 'Le point de terminaison push doit être en https.',
  'An MCP server cannot be both excluded and preferred.': 'Un serveur MCP ne peut pas être à la fois exclu et préféré.',
  'Sections': 'Sections',
  'Global': 'Global',
  'Google': 'Google',
  'Check': 'Vérifier',
  'Open': 'Ouvrir',
  'Commit': 'Commiter',
  'Sessions': 'Sessions',
  'Delete': 'Supprimer',
  'skill': 'skill',
  'Runs': 'Runs',
  'Success': 'Réussite',
  'Cost': 'Coût',
  'Effort': 'Effort',
  'Posterior': 'A posteriori',
  'runs': 'runs',
  'Run now': 'Exécuter maintenant',
  'Board': 'Board',
  'Semantic': 'Sémantique',
  'Filter': 'Filtrer',
  'Recall': 'Rappel',
  'Clear': 'Effacer',
  'Nothing waiting': 'Rien en attente',
  'Plugins': 'Plugins',
  'Claude CLI': 'CLI Claude',
  'New': 'Nouveau',
  'No workspaces': 'Aucun espace de travail',
  'Ask': 'Demander',
  'Accept edits': 'Accepter les modifications',
  'Auto': 'Auto',
  'Bypass': 'Contournement',
  '{name} was not mounted in {workspace}.': '{name} n’a pas été monté dans {workspace}.',
  '{name} did not connect.': '{name} ne s’est pas connecté.',
  'Connects this server exactly as a run would, and says what it exposes.': 'Connecte ce serveur exactement comme le ferait un run, et dit ce qu’il expose.',
  '{name} answered with {n} tool.': '{name} a répondu avec {n} outil.',
  '{name} answered with {n} tools.': '{name} a répondu avec {n} outils.',
  'Test': 'Tester',
  '{name} needs authorisation.': '{name} demande une autorisation.',
  'It answered, but refused the connection until it is authorised.': 'Il a répondu, mais refuse la connexion tant qu’il n’est pas autorisé.',
  '{name} is still connecting.': '{name} est encore en cours de connexion.',
  'Test again in a moment.': 'Retestez dans un instant.',
  '{name} is switched off, so a run would not mount it.': '{name} est désactivé : un run ne le monterait pas.',
  '{name} reported no status at all.': '{name} n’a rapporté aucun statut.',
  '{n} server needs authorisation': '{n} serveur demande une autorisation',
  '{n} servers need authorisation': '{n} serveurs demandent une autorisation',
  'Authorise': 'Autoriser',
  'Authorised': 'Autorisé',
  'Authorise again': 'Autoriser de nouveau',
  'Forget this authorization': 'Oublier cette autorisation',
  'Opens the server’s own sign-in. Metaclaude keeps the token and sends it with every run.': 'Ouvre la connexion propre au serveur. Metaclaude conserve le jeton et l’envoie à chaque run.',
  'Authorised. The token is stored and runs will use it.': 'Autorisé. Le jeton est enregistré et les runs l’utiliseront.',
  'The authorization was refused at the provider.': 'L’autorisation a été refusée chez le fournisseur.',
  'That authorization link was incomplete.': 'Ce lien d’autorisation était incomplet.',
  'The authorization could not be completed.': 'L’autorisation n’a pas pu aboutir.',
  'It may have expired, or already been used. Try again.': 'Elle a peut-être expiré, ou déjà servi. Réessayez.',
  'Could not start the authorization.': 'L’autorisation n’a pas pu démarrer.',
  '{name} is no longer authorised.': '{name} n’est plus autorisé.',
  'The stored tokens were deleted. Runs will find it unauthorised.': 'Les jetons enregistrés ont été supprimés. Les runs le trouveront non autorisé.',
  'Could not forget that authorization.': 'Cette autorisation n’a pas pu être oubliée.',
};

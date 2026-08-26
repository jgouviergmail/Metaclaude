"""
Deux pièges dans un heredoc dont le délimiteur n'est pas entre guillemets.

1. Un accent grave nu est une substitution de commande. provision.sh a écrit
   "there is no `Port` here" dans une config sshd et le shell a exécuté `Port` —
   c'est ainsi qu'un paragraphe expliquant un verrouillage est devenu la chose
   qui a arrêté le provisioning. Shellcheck ne regarde pas dans les corps de
   heredoc.

2. Une barre oblique inverse en fin de ligne est une continuation : le shell la
   mange avant d'écrire, et l'opérateur reçoit une seule longue ligne au lieu de
   la commande sur deux lignes qui a été écrite. À l'intérieur d'un `$( ... )`
   c'est au contraire correct — la substitution est du code, pas du texte — donc
   on suit la profondeur et on ne signale qu'au niveau zéro.
"""

import re, sys, os

problems = []
for path in sys.argv[1:]:
    if not os.path.isfile(path):
        continue
    lines = open(path).read().split("\n")
    i = 0
    while i < len(lines):
        m = re.search(r"<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$", lines[i])
        if m:
            delim, j = m.group(1), i + 1
            while j < len(lines) and lines[j].strip() != delim:
                j += 1
            depth = 0
            for k, b in enumerate(lines[i + 1 : j], start=i + 2):
                # Un accent grave échappé est du texte ; un accent grave nu est exécuté.
                if re.search(r"(?<!\\)`", b):
                    problems.append((path, k, delim, "backtick: " + b.strip()[:60]))

                opens = len(re.findall(r"\$\(", b))
                closes = len(re.findall(r"\)", b))
                # Signalé seulement hors substitution : la barre oblique est
                # alors du texte que le shell efface, pas de la syntaxe.
                if depth == 0 and opens == 0 and re.search(r"(?<!\\)\\$", b):
                    problems.append((path, k, delim, "line continuation: " + b.strip()[:60]))
                depth = max(0, depth + opens - closes)
            i = j
        i += 1

for p, k, d, t in problems:
    print("  %s:%d  (<<%s)  %s" % (p, k, d, t))
sys.exit(1 if problems else 0)

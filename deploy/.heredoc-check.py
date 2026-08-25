import re, sys, os
problems = []
for path in sys.argv[1:]:
    if not os.path.isfile(path): continue
    lines = open(path).read().split("\n")
    i = 0
    while i < len(lines):
        m = re.search(r"<<-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*$", lines[i])
        if m:
            delim, j = m.group(1), i + 1
            while j < len(lines) and lines[j].strip() != delim:
                j += 1
            for k, b in enumerate(lines[i+1:j], start=i+2):
                # un accent grave échappé est du texte ; un accent grave nu est exécuté
                if re.search(r"(?<!\\)`", b):
                    problems.append((path, k, delim, b.strip()[:70]))
            i = j
        i += 1
for p, k, d, t in problems:
    print("  %s:%d  (<<%s)  %s" % (p, k, d, t))
sys.exit(1 if problems else 0)

# Inter

Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

Licensed under the SIL Open Font License, Version 1.1
<https://openfontlicense.org>

The file beside this one is the `latin` subset of the variable face, weights
400–700, served from this deployment rather than from a third party: the app's
Content-Security-Policy is `default-src 'self'` and `font-src 'self' data:`, so
a font host would simply be blocked — and a self-hosted face is also one fewer
party who learns when someone opens the app.

`latin-ext` is deliberately NOT shipped. It weighs 83 kB against this file's
47 kB, and French needs none of it: the `latin` unicode-range above covers
U+0152-0153, which is `Œ` and `œ`, along with every accented character the
interface uses.

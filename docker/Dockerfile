# syntax=docker/dockerfile:1.7
#
# Metaclaude — multi-stage build.
#
# Stages:
#   deps    → install workspace dependencies with a warm pnpm store cache
#   build   → compile shared, api and web
#   runtime → a minimal, non-root image with only production dependencies
#
# The Claude CLI is installed globally in the runtime stage: the Agent SDK
# spawns it as a subprocess, so it must exist in the final image, not just at
# build time.

# A full patch version, not `22`, so a rebuild months from now produces the same
# image. Check the tag exists before bumping it: `node:22.20.1-bookworm-slim` was
# pinned here and was never published, which fails the build at the first FROM.
ARG NODE_VERSION=22.23.2

# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    # Never let a build or a runtime install phone home.
    DO_NOT_TRACK=1 \
    npm_config_update_notifier=false

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# ──────────────────────────────────────────────────────────────────────────────
FROM base AS deps

# pnpm prompts before removing an existing modules directory, and a build has no
# TTY to answer with — it aborts instead (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
# Set here rather than in `base` so it reaches `deps` and `build` but never the
# runtime image, where the agent spawns a CLI that reads this variable too.
ENV CI=true

# better-sqlite3 compiles a native addon when no prebuild matches the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Copy only the manifests first so the dependency layer is reused whenever
# source changes but dependencies do not.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────────
FROM deps AS build

COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
# The web build reaches outside apps/web: src/lib/help.ts bundles the user
# guide and the changelog with `import.meta.glob`. Without these two lines the
# glob matches nothing and the image ships a Help screen whose sections render
# empty — vite.config.ts now refuses to build in that state, so forgetting
# them fails here instead of in production.
COPY docs/ docs/
COPY CHANGELOG.md ./

RUN pnpm --filter @metaclaude/shared build \
 && pnpm --filter @metaclaude/api build \
 && pnpm --filter @metaclaude/web build

# Strip dev dependencies from the tree we are about to copy into runtime.
#
# --ignore-scripts is safe here despite the native dependency: better-sqlite3 13
# ships prebuilt binaries (prebuilds/linux-x64.node) and declares no install
# script, so this replaces the modules directory without losing the addon.
# Verified by running exactly this command and then opening a database.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts
# onnxruntime-node ships every platform's binaries — 124 MB of Windows and
# 35 MB of macOS in an image that runs Linux. Its postinstall (skipped above)
# only fetches CUDA libraries on request; the CPU binary is in the tarball.
RUN rm -rf node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/darwin \
           node_modules/.pnpm/onnxruntime-node@*/node_modules/onnxruntime-node/bin/napi-v6/win32
# The same, one level down, for the two extraction libraries that ship a
# browser build beside the one Node runs. pdfjs-dist has `build/` (modern) and
# `legacy/build/` (what this codebase imports, for Node's own reasons), plus
# source maps nobody reads in production; exceljs has a `dist/` bundle beside
# the `lib/` it actually loads. About 45 MB between them.
RUN rm -rf node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/build \
           node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/*.map \
           node_modules/.pnpm/exceljs@*/node_modules/exceljs/dist

# ──────────────────────────────────────────────────────────────────────────────
# The embedding model, fetched at build time and pinned by revision. The
# runtime never downloads (`allowRemoteModels` is off in the API), so what
# this stage holds is what retrieval runs on. Its own stage so the 570 MB
# layer is cached across source changes and only rebuilt when the fetch
# script — which carries the pin — moves.
FROM base AS model
ARG EMBEDDING_MODEL=Xenova/bge-m3
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY deploy/fetch-embedding-model.sh /usr/local/bin/fetch-embedding-model.sh
RUN /usr/local/bin/fetch-embedding-model.sh "$EMBEDDING_MODEL" /models

# ──────────────────────────────────────────────────────────────────────────────
FROM base AS runtime

# `git` is required for workspace cloning and the source-control panel.
# `tini` gives us correct signal handling and reaps the CLI subprocesses the
# agent spawns — without it, a stopped container leaves zombies behind.
#
# `poppler-utils` is what reads an uploaded PDF, and the difference from the
# built-in JavaScript fallback is measured rather than assumed: poppler
# rejoins a word its typesetter split across two lines, where the fallback
# hands over the two halves. 165 such words on one real paper, each findable
# by neither half. 26 MB, 32 packages. Without it the API falls back, names
# the fallback on every document it reads, warns at boot and warns in the
# doctor — so a host that lost this line says so rather than quietly
# retrieving less.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client tini curl \
      poppler-utils \
 && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user. The agent executes model-authored commands, so
# root in the container would mean root over the mounted volumes.
RUN groupadd --gid 10001 metaclaude \
 && useradd --uid 10001 --gid metaclaude --create-home --home-dir /home/metaclaude metaclaude

WORKDIR /opt/metaclaude

COPY --from=build --chown=metaclaude:metaclaude /app/node_modules ./node_modules
COPY --from=build --chown=metaclaude:metaclaude /app/package.json ./package.json
COPY --from=build --chown=metaclaude:metaclaude /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=metaclaude:metaclaude /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=metaclaude:metaclaude /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=metaclaude:metaclaude /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=metaclaude:metaclaude /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=metaclaude:metaclaude /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=metaclaude:metaclaude /app/apps/web/dist ./web

# One Claude CLI, and it is the one that runs the work.
#
# The image used to carry two. `npm install -g @anthropic-ai/claude-code` at a
# version pinned in an ARG here, plus the binary the Agent SDK vendors for the
# build platform — and nothing made the two agree. Measured in production:
# 2.1.247 on the PATH against 2.1.263 under the SDK, in one container. The SDK
# spawns its own unless `pathToClaudeCodeExecutable` says otherwise and nothing
# sets it, so every run went through the second while every reading — the
# credentials card, the doctor, the update badge — measured the first. A version
# an operator is shown that no run uses is worse than showing none, and the
# badge was comparing the wrong number against the registry.
#
# So the PATH entry becomes a link to the binary the SDK will actually spawn:
# one version by construction, `docker compose exec app claude setup-token`
# reaching the same CLI the agent does, and ~240 MB of image back. The pin
# moves with `@anthropic-ai/claude-agent-sdk` in pnpm-lock.yaml, which is
# reviewable in exactly the way the ARG was.
#
# Exactly one, or the build fails: a `head -1` over two candidates would pick by
# directory order and hide the very ambiguity this exists to remove.
RUN set -eu; \
    found="$(find node_modules/.pnpm -type f -name claude -path '*claude-agent-sdk-*' | sort)"; \
    count="$(printf '%s' "$found" | grep -c . || true)"; \
    if [ "$count" != "1" ]; then \
      echo "expected exactly one SDK-bundled Claude CLI, found $count:"; \
      printf '%s\n' "$found"; \
      exit 1; \
    fi; \
    ln -sf "/opt/metaclaude/$found" /usr/local/bin/claude; \
    claude --version

# The system workspace copies the documentation into itself at boot, so the
# agent can read how the thing it stewards works. Until now `docs/` was only
# reached by the web build, one stage up, and the runtime never had it.
COPY --from=build --chown=metaclaude:metaclaude /app/docs ./docs
# The sources too, for the same reader: the steward copies them into its
# workspace at boot and reads the TypeScript it runs — with the tests beside
# it — rather than the compiled output outside its reach. The trees are the
# ones `SOURCE_TREES` in services/system-workspace.ts names; check.sh holds
# the two lists together. The repository's CLAUDE.md is renamed on the way
# in, because under its own name the CLI would load it as instructions.
COPY --from=build --chown=metaclaude:metaclaude /app/apps/api/src ./source/apps/api/src
COPY --from=build --chown=metaclaude:metaclaude /app/packages/shared/src ./source/packages/shared/src
COPY --from=build --chown=metaclaude:metaclaude /app/apps/web/src ./source/apps/web/src
COPY --chown=metaclaude:metaclaude CLAUDE.md ./source/CLAUDE.md
# The sentence-transformer retrieval runs on, loaded offline from here.
COPY --from=model --chown=metaclaude:metaclaude /models ./models

COPY --chown=metaclaude:metaclaude docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# State lives on volumes, so these are mount points rather than image content.
#
# Two roots, and they are deliberately not nested. /var/lib holds application
# state — the database, the sealed vault, master.key — and /srv holds the
# directories the *agent* writes into while running model-authored commands.
# The workspaces root used to sit inside the data directory, which put every
# workspace one `..` from the key and made "is this under the data directory?"
# true for every legitimate workspace path. `loadConfig` now refuses that
# layout outright, so this is the shape the image has to ship.
RUN mkdir -p /var/lib/metaclaude /srv/metaclaude/workspaces \
 && chown -R metaclaude:metaclaude /var/lib/metaclaude /srv/metaclaude

ENV NODE_ENV=production \
    METACLAUDE_HOST=0.0.0.0 \
    METACLAUDE_PORT=8787 \
    METACLAUDE_DATA_DIR=/var/lib/metaclaude \
    METACLAUDE_WORKSPACES_DIR=/srv/metaclaude/workspaces \
    METACLAUDE_WEB_DIR=/opt/metaclaude/web \
    METACLAUDE_EMBEDDING_CACHE=/opt/metaclaude/models \
    HOME=/home/metaclaude

USER metaclaude

EXPOSE 8787

# Liveness only — this endpoint is deliberately public and uninformative.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "apps/api/dist/index.js"]

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

# ──────────────────────────────────────────────────────────────────────────────
FROM base AS runtime

# `git` is required for workspace cloning and the source-control panel.
# `tini` gives us correct signal handling and reaps the CLI subprocesses the
# agent spawns — without it, a stopped container leaves zombies behind.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git openssh-client tini curl \
 && rm -rf /var/lib/apt/lists/*

# The Claude CLI. Pinned so an upstream change cannot alter agent behaviour
# without an explicit, reviewable image rebuild.
ARG CLAUDE_CLI_VERSION=2.1.245
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CLI_VERSION} \
 && npm cache clean --force \
 && claude --version

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
    HOME=/home/metaclaude

USER metaclaude

EXPOSE 8787

# Liveness only — this endpoint is deliberately public and uninformative.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "--enable-source-maps", "apps/api/dist/index.js"]

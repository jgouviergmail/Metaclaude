/**
 * Database schema, expressed as an ordered list of migrations.
 *
 * Migrations are append-only: never edit a shipped statement, add a new one.
 * The runner records each applied version in `_migrations` inside the same
 * transaction that applies it, so a crash mid-migration leaves no partial state.
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    sql: /* sql */ `
      -- ── Identity ───────────────────────────────────────────────────────────
      CREATE TABLE users (
        id             TEXT PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name   TEXT NOT NULL DEFAULT '',
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL CHECK (role IN ('owner','operator','viewer')),
        totp_secret    TEXT,
        totp_enabled   INTEGER NOT NULL DEFAULT 0,
        recovery_codes TEXT NOT NULL DEFAULT '[]',
        failed_logins  INTEGER NOT NULL DEFAULT 0,
        locked_until   INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        last_login_at  INTEGER
      );

      CREATE TABLE auth_sessions (
        id          TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        csrf_hash   TEXT NOT NULL,
        user_agent  TEXT,
        ip_address  TEXT,
        created_at  INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        revoked_at  INTEGER
      );
      CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id, expires_at);

      -- ── Workspaces ─────────────────────────────────────────────────────────
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        slug        TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        path        TEXT NOT NULL,
        color       TEXT NOT NULL DEFAULT '#6366f1',
        icon        TEXT NOT NULL DEFAULT 'folder',
        archived    INTEGER NOT NULL DEFAULT 0,
        settings    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE INDEX idx_workspaces_archived ON workspaces(archived, updated_at DESC);

      -- ── Sessions & runs ────────────────────────────────────────────────────
      CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title              TEXT NOT NULL DEFAULT '',
        claude_session_id  TEXT,
        status             TEXT NOT NULL DEFAULT 'idle',
        model              TEXT NOT NULL DEFAULT 'default',
        effort             TEXT,
        permission_mode    TEXT NOT NULL DEFAULT 'default',
        agent_name         TEXT,
        pinned             INTEGER NOT NULL DEFAULT 0,
        archived           INTEGER NOT NULL DEFAULT 0,
        total_cost_usd     REAL NOT NULL DEFAULT 0,
        total_input_tokens INTEGER NOT NULL DEFAULT 0,
        total_output_tokens INTEGER NOT NULL DEFAULT 0,
        run_count          INTEGER NOT NULL DEFAULT 0,
        created_at         INTEGER NOT NULL,
        updated_at         INTEGER NOT NULL,
        last_activity_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_sessions_workspace ON sessions(workspace_id, archived, last_activity_at DESC);
      CREATE INDEX idx_sessions_claude ON sessions(claude_session_id);

      CREATE TABLE runs (
        id            TEXT PRIMARY KEY,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        prompt        TEXT NOT NULL,
        status        TEXT NOT NULL,
        policy        TEXT NOT NULL DEFAULT '{}',
        usage         TEXT NOT NULL DEFAULT '{}',
        category      TEXT,
        error         TEXT,
        rating        REAL,
        reward        REAL,
        triggered_by  TEXT NOT NULL DEFAULT 'user',
        started_at    INTEGER NOT NULL,
        finished_at   INTEGER
      );
      CREATE INDEX idx_runs_session ON runs(session_id, started_at);
      CREATE INDEX idx_runs_workspace_time ON runs(workspace_id, started_at DESC);
      CREATE INDEX idx_runs_status ON runs(status) WHERE status IN ('queued','running','waiting_approval');
      CREATE INDEX idx_runs_category ON runs(category, started_at DESC);

      -- Transcript events are the append-only source of truth for a run.
      CREATE TABLE transcript_events (
        id        TEXT PRIMARY KEY,
        run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq       INTEGER NOT NULL,
        kind      TEXT NOT NULL,
        at        INTEGER NOT NULL,
        payload   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_transcript_run_seq ON transcript_events(run_id, seq);
      CREATE INDEX idx_transcript_session ON transcript_events(session_id, at);

      -- ── Memory & learning ──────────────────────────────────────────────────
      CREATE TABLE memories (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,
        title         TEXT NOT NULL,
        content       TEXT NOT NULL,
        tags          TEXT NOT NULL DEFAULT '[]',
        confidence    REAL NOT NULL DEFAULT 0.7,
        use_count     INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        pinned        INTEGER NOT NULL DEFAULT 0,
        source_run_id TEXT,
        embedding     BLOB,
        embedding_dim INTEGER,
        embedding_model TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_used_at  INTEGER
      );
      CREATE INDEX idx_memories_scope ON memories(workspace_id, kind, confidence DESC);
      CREATE INDEX idx_memories_updated ON memories(updated_at DESC);

      -- Full-text index keeps lexical recall alongside vector similarity; the
      -- retriever fuses both, which beats either alone on short queries.
      CREATE VIRTUAL TABLE memories_fts USING fts5(
        title, content, tags,
        content='memories', content_rowid='rowid', tokenize='porter unicode61'
      );
      CREATE TRIGGER memories_fts_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;
      CREATE TRIGGER memories_fts_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      END;
      CREATE TRIGGER memories_fts_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO memories_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
      END;

      -- Links a run to the memories retrieved for it, so reinforcement can be
      -- credited precisely once the run's outcome is known.
      CREATE TABLE memory_usages (
        run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        score     REAL NOT NULL,
        PRIMARY KEY (run_id, memory_id)
      );

      CREATE TABLE policy_arms (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        category       TEXT NOT NULL,
        model          TEXT NOT NULL,
        effort         TEXT,
        alpha          REAL NOT NULL DEFAULT 1,
        beta           REAL NOT NULL DEFAULT 1,
        trials         INTEGER NOT NULL DEFAULT 0,
        total_reward   REAL NOT NULL DEFAULT 0,
        mean_cost_usd  REAL NOT NULL DEFAULT 0,
        mean_duration_ms REAL NOT NULL DEFAULT 0,
        updated_at     INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_policy_arm_unique
        ON policy_arms(COALESCE(workspace_id,''), category, model, COALESCE(effort,''));

      -- Labelled exemplars for the kNN task classifier.
      CREATE TABLE task_exemplars (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        category     TEXT NOT NULL,
        text         TEXT NOT NULL,
        embedding    BLOB NOT NULL,
        embedding_dim INTEGER NOT NULL,
        embedding_model TEXT NOT NULL,
        weight       REAL NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_exemplars_scope ON task_exemplars(workspace_id, category);

      CREATE TABLE insights (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        run_id       TEXT REFERENCES runs(id) ON DELETE SET NULL,
        kind         TEXT NOT NULL,
        title        TEXT NOT NULL,
        body         TEXT NOT NULL,
        confidence   REAL NOT NULL DEFAULT 0.5,
        status       TEXT NOT NULL DEFAULT 'new',
        payload      TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_insights_status ON insights(status, created_at DESC);

      -- ── Extensibility: skills, agents, MCP ─────────────────────────────────
      CREATE TABLE skills (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL,
        body          TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        auto_generated INTEGER NOT NULL DEFAULT 0,
        use_count     INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_skills_name ON skills(COALESCE(workspace_id,''), name);

      CREATE TABLE agents (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        description  TEXT NOT NULL,
        prompt       TEXT NOT NULL,
        tools        TEXT,
        model        TEXT,
        enabled      INTEGER NOT NULL DEFAULT 1,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_agents_name ON agents(COALESCE(workspace_id,''), name);

      CREATE TABLE mcp_servers (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        transport    TEXT NOT NULL,
        command      TEXT,
        args         TEXT NOT NULL DEFAULT '[]',
        url          TEXT,
        env_keys     TEXT NOT NULL DEFAULT '[]',
        headers      TEXT NOT NULL DEFAULT '{}',
        enabled      INTEGER NOT NULL DEFAULT 1,
        status       TEXT NOT NULL DEFAULT 'unknown',
        last_error   TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_mcp_name ON mcp_servers(COALESCE(workspace_id,''), name);

      -- ── Automations ────────────────────────────────────────────────────────
      CREATE TABLE automations (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name          TEXT NOT NULL,
        description   TEXT NOT NULL DEFAULT '',
        prompt        TEXT NOT NULL,
        trigger       TEXT NOT NULL,
        policy        TEXT NOT NULL DEFAULT '{}',
        continuous    INTEGER NOT NULL DEFAULT 0,
        session_id    TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        max_consecutive_failures INTEGER NOT NULL DEFAULT 3,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        enabled       INTEGER NOT NULL DEFAULT 1,
        last_run_at   INTEGER,
        last_status   TEXT,
        next_run_at   INTEGER,
        run_count     INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
      CREATE INDEX idx_automations_due ON automations(enabled, next_run_at);

      -- ── Secrets & audit ────────────────────────────────────────────────────
      CREATE TABLE secrets (
        id          TEXT PRIMARY KEY,
        scope       TEXT NOT NULL,
        key         TEXT NOT NULL,
        ciphertext  BLOB NOT NULL,
        iv          BLOB NOT NULL,
        tag         BLOB NOT NULL,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_secrets_scope_key ON secrets(scope, key);

      -- Hash-chained so tampering with any row invalidates every row after it.
      CREATE TABLE audit_log (
        id         TEXT PRIMARY KEY,
        at         INTEGER NOT NULL,
        actor      TEXT NOT NULL,
        action     TEXT NOT NULL,
        target     TEXT,
        ip_address TEXT,
        outcome    TEXT NOT NULL,
        detail     TEXT,
        prev_hash  TEXT NOT NULL,
        hash       TEXT NOT NULL
      );
      CREATE INDEX idx_audit_at ON audit_log(at DESC);

      -- Small persistent key/value store for kernel bookkeeping.
      CREATE TABLE kv (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'incremental_memory_decay',
    sql: /* sql */ `
      -- When the forgetting curve was last applied to this row.
      --
      -- Decay must be measured from the previous sweep, not from the last use:
      -- the janitor runs every six hours, so applying a factor derived from
      -- total idle time to an already-decayed value compounds quadratically and
      -- collects memories roughly eight times too early.
      ALTER TABLE memories ADD COLUMN last_decayed_at INTEGER;
    `,
  },
  {
    version: 3,
    name: 'staged_totp_enrolment',
    sql: /* sql */ `
      -- A TOTP secret that has been generated but not yet proven.
      --
      -- Enrolment used to write straight to \`totp_secret\` and clear
      -- \`totp_enabled\`, which meant starting an enrolment *turned off* an
      -- already-working second factor before anything was verified. Staging the
      -- candidate here leaves the live secret untouched until the user proves
      -- they can generate a code from the new one.
      ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
    `,
  },
  {
    version: 4,
    name: 'mcp_header_secrets',
    sql: /* sql */ `
      -- Header *names* for an HTTP MCP server; the values move to the vault.
      --
      -- An HTTP MCP server authenticates through \`Authorization\`, so the
      -- headers map held credentials in plaintext on the row and returned them
      -- through the API. The names stay visible (they are configuration); the
      -- values are sealed like every other secret.
      --
      -- The existing \`headers\` column is left in place: migrations run before
      -- the vault is available, so the Registry backfills it at construction —
      -- moving any values it still holds into the vault and clearing it.
      ALTER TABLE mcp_servers ADD COLUMN header_keys TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 5,
    name: 'agent_plugins',
    sql: /* sql */ `
      -- Installed Agent Plugins (the 1.0.0 standard).
      --
      -- The manifest is stored whole rather than shredded into columns. The
      -- specification permits an \`extensions\` object whose contents a client
      -- must not validate, and future versions will add fields; a schema that
      -- projected today's ten fields would quietly discard both. What is
      -- promoted to a column is only what the application queries or sorts on.
      --
      -- \`root\` is the directory on disk. It is derived from the plugin name
      -- and is UNIQUE because two plugins of the same name would otherwise
      -- overwrite each other's files.
      CREATE TABLE plugins (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        version       TEXT,
        description   TEXT,
        source        TEXT NOT NULL,
        root          TEXT NOT NULL UNIQUE,
        manifest      TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        installed_at  INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );

      CREATE INDEX plugins_enabled ON plugins(enabled);
    `,
  },
  {
    version: 6,
    name: 'run_rewind_point',
    sql: /* sql */ `
      -- The anchor a run can be rewound to.
      --
      -- File checkpointing has always been switched on for workspaces that ask
      -- for it, but nothing could act on it: rewinding needs the uuid the CLI
      -- assigns to the user message that started the turn, and that uuid only
      -- exists on the wire. It arrives as a replay acknowledgement while the run
      -- is streaming, so it is captured there and stored here — after the run
      -- ends there is nowhere else to get it.
      --
      -- NULL means the run predates this column, ran with checkpointing off, or
      -- the CLI never sent the ack. All three are the same thing to the UI: the
      -- run cannot be rewound, and it says so rather than offering a button
      -- that fails.
      ALTER TABLE runs ADD COLUMN rewind_point TEXT;
    `,
  },
  {
    version: 7,
    name: 'totp_last_step',
    sql: /* sql */ `
      -- The TOTP counter most recently accepted for this user.
      --
      -- Verification allows ±1 period of clock drift, so one code is valid for
      -- around ninety seconds. Nothing recorded that it had been used, so the
      -- same six digits could be replayed for a second, independent session
      -- inside that window.
      --
      -- This column does not make a code single-use on its own, and an earlier
      -- version of this comment claimed the recovery codes beside it always
      -- had been. Neither was true: both branches read a snapshot of the user
      -- row taken before the ~100 ms scrypt and wrote unconditionally, so two
      -- *concurrent* logins with one code — of either kind — both succeeded.
      -- What makes them single-use is that the write is now the check, with the
      -- condition in the WHERE clause; see consumeSecondFactor in security/auth.ts.
      -- (No backticks in here: this whole block is a template literal.)
      --
      -- The counter rather than the code: the next period's code must still
      -- work the moment it rolls over, and a stored code would have to be
      -- compared against rather than ordered.
      --
      -- NULL means no code has been consumed since this column existed, which
      -- accepts anything in the window exactly as before.
      ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
    `,
  },
  {
    version: 8,
    name: 'marketplaces',
    sql: /* sql */ `
      -- Plugin marketplaces, the CLI-native kind: sources handed to the CLI as
      -- extraKnownMarketplaces so the CLI itself fetches and installs from
      -- them. Global by design — a marketplace is a trust decision about a
      -- publisher, made once by the owner; which of its plugins run where is
      -- per-workspace (workspaces.settings.enabledPlugins).
      --
      -- The source is stored whole as JSON for the same reason the plugin
      -- manifest is: its shape is the CLI's, and shredding it into columns
      -- would silently discard whatever field the CLI adds next.
      CREATE TABLE marketplaces (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL UNIQUE,
        source     TEXT NOT NULL,
        enabled    INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 9,
    name: 'run_served_model',
    sql: /* sql */ `
      -- The model that actually served the run, from the CLI's own init
      -- message. The policy records what Metaclaude *asked for*, and under
      -- Auto that can be literally 'default' — the CLI then chooses, and
      -- nothing recorded its choice. NULL means the run predates this column
      -- or the CLI never said; the UI then falls back to the policy.
      ALTER TABLE runs ADD COLUMN served_model TEXT;
    `,
  },
  {
    version: 10,
    name: 'attachments',
    sql: /* sql */ `
      -- Files a message carries. The bytes live on disk under the workspace's
      -- attachments/ directory (content-hash named, so two uploads of the
      -- same file share one file); this table is the ledger — who uploaded
      -- what, into which session, and which run consumed it. run_id is NULL
      -- from upload until the message is submitted; binding it is the
      -- write-is-the-check that stops one pending upload being sent twice.
      -- All three references cascade. Without ON DELETE, enforced foreign
      -- keys made any session that ever carried an attachment undeletable —
      -- the review caught that before this migration reached any real
      -- database (a red CI blocks both the tag and the deployable image, so
      -- editing it in place was still safe). Rows follow their owners; the
      -- bytes under attachments/ stay, because they are ordinary workspace
      -- content the operator can see and manage.
      CREATE TABLE attachments (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id       TEXT REFERENCES runs(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        path         TEXT NOT NULL,
        mime         TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        sha256       TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_attachments_session ON attachments(session_id, created_at);
      CREATE INDEX idx_attachments_run ON attachments(run_id);
      CREATE INDEX idx_attachments_hash ON attachments(workspace_id, sha256);
    `,
  },
  {
    version: 11,
    name: 'board',
    sql: /* sql */ `
      -- The board: tasks the operator and the agents share. Three tables —
      -- the cards, their comments, and an append-only history that is what
      -- makes concurrent human/agent edits auditable instead of mysterious.
      --
      -- order_key is a fractional position within (workspace, status): the
      -- server computes a key between two neighbours on every move, so
      -- ordering never needs a renumbering sweep and two clients moving
      -- cards at once cannot corrupt each other's positions.
      --
      -- archived_at is a timestamp, not a status: an archived card keeps the
      -- column it died in, which is what a restore should restore. Every
      -- foreign key cascades — the attachments table taught that lesson.
      CREATE TABLE tasks (
        id             TEXT PRIMARY KEY,
        workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        parent_id      TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL DEFAULT '',
        status         TEXT NOT NULL DEFAULT 'todo',
        priority       TEXT NOT NULL DEFAULT 'normal',
        assignee       TEXT,
        run_id         TEXT REFERENCES runs(id) ON DELETE SET NULL,
        due_at         INTEGER,
        order_key      TEXT NOT NULL,
        blocked_reason TEXT,
        created_by     TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        archived_at    INTEGER
      );
      CREATE INDEX idx_tasks_board ON tasks(workspace_id, status, order_key);
      CREATE INDEX idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX idx_tasks_run ON tasks(run_id);

      CREATE TABLE task_comments (
        id         TEXT PRIMARY KEY,
        task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author     TEXT NOT NULL,
        body       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_task_comments ON task_comments(task_id, created_at);

      CREATE TABLE task_events (
        id      TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        actor   TEXT NOT NULL,
        kind    TEXT NOT NULL,
        detail  TEXT NOT NULL DEFAULT '',
        at      INTEGER NOT NULL
      );
      CREATE INDEX idx_task_events ON task_events(task_id, at);
    `,
  },
  {
    version: 12,
    name: 'push_subscriptions',
    sql: /* sql */ `
      -- One row per browser push endpoint. The endpoint is the identity: a
      -- re-subscribe from the same browser upserts rather than duplicates,
      -- and a push service answering 404/410 deletes the row outright.
      CREATE TABLE push_subscriptions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint   TEXT NOT NULL UNIQUE,
        p256dh     TEXT NOT NULL,
        auth       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_error TEXT
      );
      CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
    `,
  },
];

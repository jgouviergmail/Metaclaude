/**
 * Plugin marketplaces — the CLI-native plugin store.
 *
 * Metaclaude stores only the *sources*. The CLI itself fetches a marketplace
 * and installs the plugins enabled from it (handed over as
 * `extraKnownMarketplaces` / `enabledPlugins` in the run's settings payload,
 * with `CLAUDE_CODE_SYNC_PLUGIN_INSTALL` letting a headless session install);
 * Metaclaude never unpacks or executes marketplace content. The one thing
 * fetched here is `marketplace.json`, and only to *show* the catalogue — the
 * install path never depends on it.
 *
 * Adding a marketplace is a trust decision: its plugins bring skills, hooks
 * and MCP servers into the agent. The routes gate it owner-level, the same
 * authority as installing a plugin by path.
 */

import {
  Marketplace,
  MarketplaceCatalogue,
  MarketplacePlugin,
  newId,
  type MarketplaceInput,
  type MarketplaceSource,
} from '@metaclaude/shared';
import type { Db } from '../db/index.js';

export class MarketplacesError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'MarketplacesError';
  }
}

interface MarketplaceRow {
  id: string;
  name: string;
  source: string;
  enabled: 0 | 1;
  created_at: number;
}

const CATALOGUE_TTL_MS = 5 * 60_000;

export interface MarketplacesDeps {
  db: Db;
  /** Fetch a URL's body as text. Injected so tests never touch the network. */
  fetchText: (url: string) => Promise<string>;
  now?: () => number;
}

export class MarketplacesService {
  private readonly cache = new Map<string, { at: number; catalogue: MarketplaceCatalogue }>();

  constructor(private readonly deps: MarketplacesDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private toMarketplace(row: MarketplaceRow): Marketplace {
    return Marketplace.parse({
      id: row.id,
      name: row.name,
      source: JSON.parse(row.source),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
    });
  }

  list(): Marketplace[] {
    return this.deps.db
      .prepare<[], MarketplaceRow>('SELECT * FROM marketplaces ORDER BY name')
      .all()
      .map((row) => this.toMarketplace(row));
  }

  get(id: string): Marketplace | null {
    const row = this.deps.db
      .prepare<[string], MarketplaceRow>('SELECT * FROM marketplaces WHERE id = ?')
      .get(id);
    return row ? this.toMarketplace(row) : null;
  }

  add(input: MarketplaceInput): Marketplace {
    const id = newId('marketplace');
    try {
      this.deps.db
        .prepare('INSERT INTO marketplaces (id, name, source, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
        .run(id, input.name, JSON.stringify(input.source), this.now());
    } catch (error) {
      if (error instanceof Error && /UNIQUE/.test(error.message)) {
        throw new MarketplacesError(`A marketplace named "${input.name}" already exists.`, 409);
      }
      throw error;
    }
    return this.get(id) as Marketplace;
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return (
      this.deps.db
        .prepare('UPDATE marketplaces SET enabled = ? WHERE id = ?')
        .run(enabled ? 1 : 0, id).changes > 0
    );
  }

  remove(id: string): boolean {
    this.cache.delete(id);
    return this.deps.db.prepare('DELETE FROM marketplaces WHERE id = ?').run(id).changes > 0;
  }

  /**
   * The `extraKnownMarketplaces` value for a run: every *enabled* marketplace,
   * source passed through verbatim. Disabling severs the source here — the
   * listing screen keeps the row, the CLI stops seeing it.
   */
  settingsPayload(): Record<string, { source: MarketplaceSource }> {
    const payload: Record<string, { source: MarketplaceSource }> = {};
    for (const marketplace of this.list()) {
      if (marketplace.enabled) payload[marketplace.name] = { source: marketplace.source };
    }
    return payload;
  }

  /**
   * The marketplace's own `marketplace.json`, for browsing. A failure is part
   * of the answer, never an exception: the screen's job is to say "this
   * source is broken and here is why".
   */
  async catalogue(id: string, options: { force?: boolean } = {}): Promise<MarketplaceCatalogue> {
    const marketplace = this.get(id);
    if (!marketplace) throw new MarketplacesError('That marketplace does not exist.', 404);

    const cached = this.cache.get(id);
    if (!options.force && cached && this.now() - cached.at < CATALOGUE_TTL_MS) {
      return cached.catalogue;
    }

    const catalogue = await this.fetchCatalogue(marketplace);
    this.cache.set(id, { at: this.now(), catalogue });
    return catalogue;
  }

  private catalogueUrl(source: MarketplaceSource): string {
    if (source.source === 'url') return source.url;
    // The CLI's default manifest location, at the ref the source pins.
    const ref = source.ref ?? 'HEAD';
    const path = source.path ?? '.claude-plugin/marketplace.json';
    return `https://raw.githubusercontent.com/${source.repo}/${ref}/${path}`;
  }

  private async fetchCatalogue(marketplace: Marketplace): Promise<MarketplaceCatalogue> {
    const base = {
      marketplaceId: marketplace.id,
      name: marketplace.name,
      fetchedAt: this.now(),
    };
    try {
      const body = await this.deps.fetchText(this.catalogueUrl(marketplace.source));
      const manifest = JSON.parse(body) as { plugins?: unknown };
      const entries = Array.isArray(manifest.plugins) ? manifest.plugins : [];
      const plugins = entries.flatMap((entry) => {
        const raw = entry as Record<string, unknown>;
        // Authors appear as strings or as { name } objects; normalise before
        // the schema so a lenient parse stays lenient.
        const author =
          typeof raw.author === 'object' && raw.author !== null
            ? ((raw.author as Record<string, unknown>).name ?? null)
            : (raw.author ?? null);
        const parsed = MarketplacePlugin.safeParse({ ...raw, author });
        return parsed.success ? [parsed.data] : [];
      });
      return MarketplaceCatalogue.parse({ ...base, plugins, error: null });
    } catch (error) {
      return MarketplaceCatalogue.parse({
        ...base,
        plugins: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

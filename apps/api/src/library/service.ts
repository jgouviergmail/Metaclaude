/**
 * The built-in library, served.
 *
 * Listing decorates the catalogue with an `installed` flag — true when a
 * *global* registry record of the same kind carries the entry's name, because
 * global scope is the only place install writes to. A workspace-scoped
 * namesake neither blocks an install nor marks the shelf as stocked.
 *
 * Install copies the entry into the registry: global scope, **disabled**, and
 * from then on it is the operator's record — editable, renamable, deletable
 * like anything hand-written. The library keeps the original, so deleting or
 * renaming the copy simply makes the entry installable again.
 */

import type { LibraryListingEntry } from '@metaclaude/shared';
import type { Registry } from '../services/registry.js';
import { RegistryError } from '../services/registry.js';
import { LIBRARY, type LibraryEntry } from './catalog.js';

// The shared wire type is the contract; typing the listing with it is what
// keeps this service and the web app from drifting apart.
export type LibraryListing = LibraryListingEntry;

export class LibraryService {
  constructor(private readonly registry: Registry) {}

  list(): LibraryListing[] {
    const skills = new Set(this.registry.listSkills(null).map((skill) => skill.name));
    const agents = new Set(this.registry.listAgents(null).map((agent) => agent.name));
    return LIBRARY.map((entry) => ({
      ...entry,
      installed: (entry.kind === 'skill' ? skills : agents).has(entry.name),
    }));
  }

  install(name: string): { entry: LibraryEntry; id: string } {
    const entry = LIBRARY.find((candidate) => candidate.name === name);
    if (!entry) throw new RegistryError('That library entry does not exist.', 404);

    const existing =
      entry.kind === 'skill' ? this.registry.listSkills(null) : this.registry.listAgents(null);
    // The registry's own uniqueness guard would 409 anyway; this pre-check
    // exists for the message — "already installed" is what the button means.
    if (existing.some((record) => record.name === entry.name)) {
      throw new RegistryError(`"${entry.name}" is already installed.`, 409);
    }


    if (entry.kind === 'skill') {
      const skill = this.registry.upsertSkill({
        workspaceId: null,
        name: entry.name,
        description: entry.description,
        body: entry.body,
        category: entry.category,
        enabled: false,
      });
      return { entry, id: skill.id };
    }
    const agent = this.registry.upsertAgent({
      workspaceId: null,
      name: entry.name,
      description: entry.description,
      prompt: entry.prompt,
      category: entry.category,
      enabled: false,
    });
    return { entry, id: agent.id };
  }
}

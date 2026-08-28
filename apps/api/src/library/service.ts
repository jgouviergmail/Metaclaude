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

import type { ConnectorListingEntry, LibraryListingEntry } from '@metaclaude/shared';
import type { Registry } from '../services/registry.js';
import { RegistryError } from '../services/registry.js';
import { LIBRARY, type LibraryEntry } from './catalog.js';
import { CONNECTORS, type Connector } from './connectors.js';

// The shared wire types are the contract; typing the listings with them is
// what keeps this service and the web app from drifting apart.
export type LibraryListing = LibraryListingEntry;
export type ConnectorListing = ConnectorListingEntry;

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

  /* ------------------------------ Connectors ----------------------------- */

  listConnectors(): ConnectorListing[] {
    const installed = new Set(this.registry.listMcpServers(null).map((server) => server.name));
    return CONNECTORS.map((connector) => ({
      ...connector,
      args: [...connector.args],
      installed: installed.has(connector.name),
    }));
  }

  /**
   * Install a connector as a **disabled** global MCP server, sealing the
   * credential the operator pasted.
   *
   * Disabled matters more here than it does for a skill: an enabled MCP server
   * is mounted into every run of every workspace, so an install that switched
   * it on would widen what the agent can reach on one click. The operator
   * enables it once they have checked what it connected to — which the
   * "From Claude" tab reports for real.
   *
   * A required credential is required here rather than at the edge: the
   * registry would happily store a server with no secret, and it would fail at
   * run time with an authentication error that reads like a bad token instead
   * of a missing one.
   */
  installConnector(name: string, secret?: string): { connector: Connector; id: string } {
    const connector = CONNECTORS.find((candidate) => candidate.name === name);
    if (!connector) throw new RegistryError('That connector does not exist.', 404);

    if (this.registry.listMcpServers(null).some((server) => server.name === connector.name)) {
      throw new RegistryError(`"${connector.name}" is already installed.`, 409);
    }

    const value = secret?.trim() ?? '';
    const credential = connector.credential;
    if (credential?.required && !value) {
      throw new RegistryError(
        `${connector.title} needs a credential: ${credential.key}. ${credential.hint}`,
      );
    }
    // A credential for a connector that takes none would be sealed under a slot
    // nothing ever reads — a secret stored for no reason is a secret leaked for
    // no reason.
    const sealed =
      credential && value ? { [credential.key]: `${credential.prefix}${value}` } : undefined;

    const server = this.registry.upsertMcpServer({
      workspaceId: null,
      name: connector.name,
      transport: connector.transport,
      command: connector.command,
      args: [...connector.args],
      url: connector.url,
      env: credential?.kind === 'env' ? sealed : undefined,
      headers: credential?.kind === 'header' ? sealed : undefined,
      enabled: false,
    });
    return { connector, id: server.id };
  }
}

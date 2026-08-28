/**
 * The connector directory — remote and packaged MCP servers, curated here.
 *
 * The question this answers is one every operator asks within a day: "on
 * claude.ai I switch on Gmail, Calendar and Drive; where are they?" The honest
 * answer is in the guide — a headless agent cannot complete an interactive
 * OAuth consent, and the setup token the container pairs with is scoped to
 * inference — so this file does the next best thing: it collects the MCP
 * endpoints that *do* work without a browser, with their exact URL and the
 * exact name of the credential they want.
 *
 * That filter is the whole point, and it is stricter than a list of famous
 * servers would be. **Every entry here authenticates with something an
 * operator can paste**: a header, an environment variable, or nothing at all.
 * An endpoint whose only path is OAuth 2.1 is deliberately absent, however
 * well-known its publisher, because installing it would produce a server that
 * can never connect — the same wall as the claude.ai connectors, one click
 * further in.
 *
 * Facts before entries. Each URL, header name and package name below was read
 * from the publisher's own repository or documentation, not from an aggregator
 * — `docsUrl` records where — because a directory that guesses a header is
 * worse than no directory: the failure surfaces as an authentication error the
 * operator will blame on their own key. Two of these are the reason the
 * directory earns its keep: Sentry wants `Sentry-Bearer`, not `Bearer` (it
 * reserves `Bearer` for MCP's own OAuth tokens), and Google Maps wants
 * `X-Goog-Api-Key` rather than any Authorization header at all. Nobody guesses
 * either one.
 *
 * The trust story is the library's, unchanged: curated in this repository,
 * reviewed like code, never fetched from a store. It is also *tied* to the
 * advisor's allowlist — `connectors.test.ts` runs every entry through the same
 * `checkMcpTrust` the advisor applies to its own proposals, so adding a
 * connector means vouching for its publisher in one place that both features
 * read.
 *
 * Install writes the server **disabled**, exactly as the library does, and
 * seals whatever credential the operator pasted into the vault. Nothing here
 * ever holds a credential value; `credential.key` is a name.
 */

import type { LibraryCategory, McpTransport } from '@metaclaude/shared';

/**
 * What the operator must supply for a connector to authenticate.
 *
 * `prefix` exists because the scheme word is part of the header value and
 * differs between publishers — it is prepended to what is pasted, so the
 * operator supplies the token and nothing else.
 */
export interface ConnectorCredential {
  /** A sealed HTTP header (remote servers) or an environment variable (stdio). */
  kind: 'header' | 'env';
  /** The header or variable name. A *name*: values live in the vault. */
  key: string;
  /** Prepended verbatim to the pasted value, e.g. `Bearer `. Often empty. */
  prefix: string;
  /** Where the operator gets it, in their words. */
  hint: string;
  /**
   * False for endpoints that answer anonymously and only *improve* with a key
   * — the install must not demand one, or the connector looks unavailable to
   * someone who has no account with the publisher.
   */
  required: boolean;
}

export interface Connector {
  /** The registry name the server is installed under. */
  name: string;
  /** How the publisher writes it, for the card's heading. */
  title: string;
  publisher: string;
  category: LibraryCategory;
  /** One line: what it lets the agent do. */
  description: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: readonly string[];
  credential: ConnectorCredential | null;
  /** The publisher's own page these facts were read from. */
  docsUrl: string;
}

const BEARER = 'Bearer ';

export const CONNECTORS: readonly Connector[] = [
  {
    name: 'github',
    title: 'GitHub',
    publisher: 'GitHub',
    category: 'engineering',
    description:
      'Issues, pull requests, code search and Actions across the repositories your token can reach.',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      key: 'Authorization',
      prefix: BEARER,
      hint: 'A GitHub personal access token. Give it only the repositories and scopes this agent should touch — it can do everything the token can.',
      required: true,
    },
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    name: 'sentry',
    title: 'Sentry',
    publisher: 'Sentry',
    category: 'ops',
    description:
      'Read issues, events and stack traces from your Sentry organisation so a run can debug from the real error.',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      key: 'Authorization',
      // Sentry's own doc is emphatic that this is not `Bearer`: it reserves
      // that word for MCP OAuth access tokens, so a token sent as `Bearer`
      // fails in a way that reads like a bad token.
      prefix: 'Sentry-Bearer ',
      hint: 'A Sentry user auth token, from your organisation settings. Sent as Sentry-Bearer, not Bearer — Sentry keeps Bearer for its own OAuth.',
      required: true,
    },
    docsUrl: 'https://github.com/getsentry/sentry-mcp',
  },
  {
    name: 'context7',
    title: 'Context7',
    publisher: 'Upstash',
    category: 'engineering',
    description:
      'Version-accurate documentation for thousands of libraries, so the agent writes against the API that exists.',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      key: 'Authorization',
      prefix: BEARER,
      hint: 'Optional. A Context7 API key raises the rate limit; the endpoint answers without one.',
      required: false,
    },
    docsUrl: 'https://github.com/upstash/context7',
  },
  {
    name: 'exa',
    title: 'Exa',
    publisher: 'Exa',
    category: 'research',
    description:
      'Neural web search that returns the page contents, not just links — for research a run has to read.',
    transport: 'http',
    url: 'https://mcp.exa.ai/mcp',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      key: 'Authorization',
      prefix: BEARER,
      hint: 'Optional. Anonymous access is rate-limited; a key from the Exa dashboard lifts it.',
      required: false,
    },
    docsUrl: 'https://github.com/exa-labs/exa-mcp-server',
  },
  {
    name: 'apify',
    title: 'Apify',
    publisher: 'Apify',
    category: 'data',
    description:
      'Run scrapers and data extractors from the Apify store — structured data out of sites with no API.',
    transport: 'http',
    url: 'https://mcp.apify.com',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      key: 'Authorization',
      prefix: BEARER,
      hint: 'An Apify API token from your account settings. Runs cost Apify credits, so watch what you enable.',
      required: true,
    },
    docsUrl: 'https://github.com/apify/actors-mcp-server',
  },
  {
    name: 'huggingface',
    title: 'Hugging Face',
    publisher: 'Hugging Face',
    category: 'research',
    description:
      'Search models, datasets, Spaces and papers on the Hub, and read repository files directly.',
    transport: 'http',
    url: 'https://huggingface.co/mcp',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      key: 'Authorization',
      prefix: BEARER,
      hint: 'A Hugging Face access token, from your account settings. Read-only is enough for search.',
      required: true,
    },
    docsUrl: 'https://github.com/huggingface/hf-mcp-server',
  },
  {
    name: 'notion',
    title: 'Notion',
    publisher: 'Notion',
    category: 'writing',
    description:
      'Read and write the Notion pages and databases you share with your integration — notes, trackers, wikis.',
    // The hosted endpoint at mcp.notion.com is OAuth-only, so it is not here.
    // Notion's own package takes an integration token from the environment,
    // which is the path that works unattended.
    transport: 'stdio',
    url: null,
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    credential: {
      kind: 'env',
      key: 'NOTION_TOKEN',
      prefix: '',
      hint: 'An internal integration token (starts ntn_). Create the integration in Notion, then share each page or database with it — it sees nothing you have not shared.',
      required: true,
    },
    docsUrl: 'https://github.com/makenotion/notion-mcp-server',
  },
  {
    name: 'stripe',
    title: 'Stripe',
    publisher: 'Stripe',
    category: 'money',
    description:
      'Query customers, payments, subscriptions and invoices — what the restricted key you supply permits, and no more.',
    transport: 'stdio',
    url: null,
    command: 'npx',
    args: ['-y', '@stripe/mcp'],
    credential: {
      kind: 'env',
      key: 'STRIPE_SECRET_KEY',
      prefix: '',
      hint: 'Use a **restricted** key, not your secret key: the restricted key’s permissions are exactly what the agent can do.',
      required: true,
    },
    docsUrl: 'https://github.com/stripe/agent-toolkit',
  },
  {
    name: 'google-maps',
    title: 'Google Maps',
    publisher: 'Google',
    category: 'travel',
    description:
      'Routes with real travel time, place search and local weather — what a trip or a moving plan needs to be honest.',
    transport: 'http',
    url: 'https://mapstools.googleapis.com/mcp',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      // Not an Authorization header at all — Google's Maps Grounding endpoint
      // takes the key in its own header, and sending Bearer fails silently
      // enough to waste an afternoon.
      key: 'X-Goog-Api-Key',
      prefix: '',
      hint: 'A Google Maps Platform API key with Maps Grounding Lite enabled. Restrict it to that API in the Cloud console — it is billed per call.',
      required: true,
    },
    docsUrl: 'https://developers.google.com/maps/ai/grounding-lite/reference/mcp',
  },
  {
    name: 'wolfram',
    title: 'Wolfram',
    publisher: 'Wolfram Research',
    category: 'learning',
    description:
      'Computation and curated facts: units, dates, nutrition, geography, statistics — answers with the arithmetic actually done.',
    transport: 'http',
    url: 'https://services.wolfram.com/api/mcp',
    command: null,
    args: [],
    credential: {
      kind: 'header',
      key: 'Authorization',
      prefix: BEARER,
      hint: 'A Wolfram MCP Service API key, from your Wolfram account developer tools.',
      required: true,
    },
    docsUrl: 'https://github.com/WolframResearch/AgentTools',
  },
  {
    name: 'sequential-thinking',
    title: 'Sequential thinking',
    publisher: 'Anthropic',
    category: 'general',
    description:
      'A scratchpad for multi-step reasoning the agent can revise as it goes — no account, no key, nothing leaves the container.',
    transport: 'stdio',
    url: null,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    credential: null,
    docsUrl: 'https://github.com/modelcontextprotocol/servers',
  },
];

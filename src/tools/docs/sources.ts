// Curated list of public Boros documentation sources surfaced by the
// `search_boros_docs` tool and as MCP Resources. These are the single source
// of truth — adding a new doc URL means adding one entry here; the tool and
// resource registrations both iterate over DOC_SOURCES.

export type DocKind = 'gitbook' | 'docsite' | 'openapi';

export interface DocSource {
  id: string;
  label: string;
  url: string;
  kind: DocKind;
  description: string;
}

export const DOC_SOURCES: DocSource[] = [
  {
    id: 'overview',
    label: 'Boros Overview (GitBook)',
    url: 'https://pendle.gitbook.io/boros',
    kind: 'gitbook',
    description: 'High-level introduction for traders: what Boros is, how funding-rate swaps work, account model.',
  },
  {
    id: 'docs',
    label: 'Boros Docs (GitBook)',
    url: 'https://pendle.gitbook.io/boros/boros-docs?fallback=true',
    kind: 'gitbook',
    description: 'Detailed protocol mechanics: margining, settlement, ticks, AMM, liquidations.',
  },
  {
    id: 'dev',
    label: 'Boros Developer Docs',
    url: 'https://docs.pendle.finance/boros-dev',
    kind: 'docsite',
    description: 'Developer + integration reference: contracts, signing flow, agent approval, on-chain data.',
  },
  {
    id: 'openapi',
    label: 'Boros OpenAPI Reference',
    url: 'https://api-boros.pendle.finance/apis/docs#description/introduction',
    kind: 'openapi',
    description: 'REST API reference for /open-api endpoints (markets, orders, accounts).',
  },
];

export const DOC_SOURCE_IDS = DOC_SOURCES.map((s) => s.id) as [string, ...string[]];

export function getSourceById(id: string): DocSource | undefined {
  return DOC_SOURCES.find((s) => s.id === id);
}

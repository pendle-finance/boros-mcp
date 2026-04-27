// Catalog-vs-registry drift detection. Reaches into McpServer._registeredTools (private but
// present at runtime); if the SDK ever renames the field the assertion no-ops + warns on stderr.
import { TOOL_CATALOG } from './catalog.js';

export const ROUTER_TOOL_NAME = 'boros_router';

function readRegisteredToolNames(server: unknown): string[] | null {
  if (!server || typeof server !== 'object') return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registry = (server as any)._registeredTools;
  if (!registry || typeof registry !== 'object') return null;
  return Object.keys(registry);
}

export function assertCatalogMatchesRegistry(server: unknown): void {
  const registered = readRegisteredToolNames(server);
  if (registered === null) {
    process.stderr.write(
      '[boros-mcp][router] WARN: could not read McpServer._registeredTools — catalog drift detection skipped (SDK internal layout may have changed).\n',
    );
    return;
  }

  // Router is meta and must not recommend itself.
  const ignoredFromCatalog = new Set<string>([ROUTER_TOOL_NAME]);

  const registeredSet = new Set(registered);
  const catalogSet = new Set(TOOL_CATALOG.map((t) => t.name));

  const missingFromCatalog = registered
    .filter((n) => !catalogSet.has(n) && !ignoredFromCatalog.has(n))
    .sort();
  const extraInCatalog = [...catalogSet]
    .filter((n) => !registeredSet.has(n))
    .sort();

  if (missingFromCatalog.length === 0 && extraInCatalog.length === 0) return;

  const lines: string[] = ['[boros-mcp][router] Tool catalog drift detected:'];
  if (missingFromCatalog.length > 0) {
    lines.push(`  Missing from TOOL_CATALOG (registered but not routable): ${missingFromCatalog.join(', ')}`);
  }
  if (extraInCatalog.length > 0) {
    lines.push(`  Stale in TOOL_CATALOG (catalogued but not registered): ${extraInCatalog.join(', ')}`);
  }
  const msg = lines.join('\n') + '\n';

  // Throw in dev to force a fix; in prod, log only — routing miss beats taking the MCP down.
  if (process.env.NODE_ENV === 'production') {
    process.stderr.write(msg);
  } else {
    throw new Error(msg);
  }
}

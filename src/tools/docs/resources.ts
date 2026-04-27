// MCP Resources for the Boros doc URLs. Resources expose URI-addressable
// read-only data; clients that surface a resource picker (Claude Desktop,
// Cursor) can let users attach the docs without invoking a tool. We register
// the same set of URLs that `search_boros_docs` searches, so discoverability
// works whether the user's client prefers tools or resources.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DOC_SOURCES } from './sources.js';
import { fetchDoc } from './fetcher.js';

export function registerDocsResources(server: McpServer): void {
  for (const src of DOC_SOURCES) {
    server.registerResource(
      `boros-docs:${src.id}`,
      src.url,
      {
        title: src.label,
        description: src.description,
        mimeType: src.kind === 'openapi' ? 'application/json' : 'text/plain',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/plain',
            text: await fetchDoc(src.url),
          },
        ],
      }),
    );
  }
}

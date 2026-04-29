#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAllTools } from './tools/register.js';
import { startServer } from './wallet-flow/server.js';
import { loadAgent } from './agent/agent-manager.js';

async function main() {
  const actualPort = await startServer();
  process.stderr.write(`[boros-mcp] Localhost server running on http://127.0.0.1:${actualPort}\n`);

  const agentState = await loadAgent();
  switch (agentState) {
    case 'ready':
      process.stderr.write('[boros-mcp] Agent loaded and ready.\n');
      break;
    case 'locked':
      process.stderr.write('[boros-mcp] Agent is password-protected. Will prompt for password on first use.\n');
      break;
    case 'not_setup':
      process.stderr.write('[boros-mcp] No agent configured. Use setup_agent tool to connect your wallet.\n');
      break;
  }

  const server = new McpServer({
    name: 'boros-mcp',
    version: '0.1.0',
  });

  registerAllTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write('[boros-mcp] MCP server connected via stdio.\n');
}

main().catch((err) => {
  process.stderr.write(`[boros-mcp] Fatal error: ${err.message}\n`);
  process.exit(1);
});

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMarketsTools } from './markets/index.js';
import { registerProtocolTools } from './protocol/index.js';
import { registerAmmTools } from './amm/index.js';
import { registerFundingTools } from './funding/index.js';
import { registerEventsTools } from './events/index.js';
import { registerLeaderboardTools } from './leaderboard/index.js';
import { registerIncentivesTools } from './incentives/index.js';
import { registerPortfolioTools } from './portfolio/index.js';
import { registerAccountTools } from './account/index.js';
import { registerTradingTools } from './trading/index.js';
import { registerWalletTools } from './wallet/index.js';
import { registerAuthTools } from './auth/index.js';
import { registerGlossaryTool } from './glossary.js';

export function registerAllTools(server: McpServer): void {
  registerMarketsTools(server);
  registerProtocolTools(server);
  registerAmmTools(server);
  registerFundingTools(server);
  registerEventsTools(server);
  registerLeaderboardTools(server);
  registerIncentivesTools(server);
  registerPortfolioTools(server);
  registerAccountTools(server);
  registerTradingTools(server);
  registerWalletTools(server);
  registerAuthTools(server);
  registerGlossaryTool(server);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openApiGet } from '../../api/open-api.js';
import { jsonResult, enrichTimestamp } from '../../utils.js';
import {
  addressFieldOptional,
  paginationLimitField,
  resumeTokenField,
} from '../_schemas.js';
import { catchToErrorContent } from '../../agent/errors.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';

export function registerEventsOnChainTools(server: McpServer): void {
  server.registerTool(
    'get_on_chain_events',
    {
      annotations: { readOnlyHint: true },
      description: 'Query the backend\'s indexed catalogue of decoded Boros contract events (Router/MarketHub/Market/AMM/MarketFactory) with cursor-based pagination, sorted newest-first by (blockNumber, logIndex). Use this for protocol-wide audits ("all MarketCreated events", "all AgentApproved on the Router", "raw Liquidate logs"). Do NOT use for user-centric questions: trade fills on a known account → get_transaction_history; deposits/withdrawals/cash transfers on a known account → get_transfer_logs; liquidations with rate enrichment → get_liquidation_events; account snapshot → get_portfolio_summary. `sourceAddress` filters by *contract* address (Router/MarketHub/etc), NOT user wallet.',
      inputSchema: {
        eventName: z.string().optional().describe('Filter by event name (e.g. "BulkOrdersExecuted", "Liquidate", "MarketCreated", "AgentApproved", "EnterMarket"). Closed enum on the backend (see OnChainEventName); typos silently return 0 rows.'),
        sourceAddress: addressFieldOptional('sourceAddress', 'Filter by source CONTRACT address (e.g. Router 0x8080808080daB95eFED788a9214e400ba552DEf6) — not a user wallet'),
        fromBlockNumber: z.number().int().min(0).optional().describe('Start block (inclusive)'),
        toBlockNumber: z.number().int().min(0).optional().describe('End block (inclusive)'),
        limit: paginationLimitField({ max: 50, defaultValue: 20 }),
        resumeToken: resumeTokenField(),
      },
    },
    async ({ eventName, sourceAddress, fromBlockNumber, toBlockNumber, limit, resumeToken }) => {
      try {
        const res = await fetchWithRetry(() =>
          openApiGet('/v1/on-chain-events', {
            ...(eventName ? { eventName } : {}),
            ...(sourceAddress ? { sourceAddress } : {}),
            ...(fromBlockNumber !== undefined ? { fromBlockNumber } : {}),
            ...(toBlockNumber !== undefined ? { toBlockNumber } : {}),
            limit,
            ...(resumeToken ? { resumeToken } : {}),
          }),
        );
        const events = (res.events ?? []).map((e: any) => ({
          ...e,
          ...(e.blockTimestamp ? { timestamp: enrichTimestamp(e.blockTimestamp) } : {}),
        }));
        return jsonResult({
          count: events.length,
          events,
          ...(res.resumeToken ? { resumeToken: res.resumeToken } : {}),
          _context: {
            sortOrder: 'newest-first by (blockNumber, logIndex). To resume older, pass resumeToken.',
            eventIndex: 'Packed cursor: blockNumber * 1_000_000 + logIndex (already split into top-level blockNumber/logIndex).',
            data: 'Event-specific decoded fields (shape varies by eventName). Examples: BulkOrdersExecuted → {user, marketId, tif, matched, takerFee}; SingleOrderExecuted adds {ammId, takerOtcFee}; Liquidate has its own packed shape.',
            isFinalized: 'False until the indexer has confirmed past reorg depth. Treat unfinalized rows as reorg-able.',
            resumeToken: 'Pass as resumeToken to fetch the next page. Absent when there are no more results.',
            scope: 'Indexer is single-chain (Arbitrum). Indexed off-chain — these are decoded mongo documents, not live RPC eth_getLogs.',
          },
        });
      } catch (err) {
        return catchToErrorContent(err);
      }
    },
  );
}

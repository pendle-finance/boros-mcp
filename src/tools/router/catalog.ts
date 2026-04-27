// Hand-curated tool catalog for `boros_router`. Examples use `<marketId>` placeholders —
// hardcoded ids (e.g. 107) get copied verbatim by LLMs even when the asset doesn't match.
export interface ToolEntry {
  name: string;
  description: string;
  example?: string;
}

export const TOOL_CATALOG: ToolEntry[] = [
  { name: 'get_markets', description: 'List available markets (matured hidden by default)', example: 'get_markets({ limit: 20, includeMatured: false })' },
  { name: 'get_market', description: 'Get detailed info for a single market by ID', example: 'get_market({ marketId: <marketId> })' },
  { name: 'get_markets_by_ids', description: 'Bulk fetch markets by ID (preserves order, includes matured)', example: 'get_markets_by_ids({ marketIds: [<marketId>, <marketId>] })' },
  { name: 'get_assets', description: 'List supported collateral + price-reference assets (decimals, addresses, USD prices). Source of truth for tokenId.', example: 'get_assets({ includeNonCollateral: false })' },
  { name: 'get_orderbook', description: 'View order book depth for a market', example: 'get_orderbook({ marketId: <marketId> })' },
  { name: 'get_market_trades', description: 'Recent executed trades for a market (size, rate, txHash, timestamp). NOT OHLCV — use get_chart for candles.', example: 'get_market_trades({ marketId: <marketId>, limit: 20 })' },
  { name: 'get_chart', description: 'Get price/rate chart data', example: 'get_chart({ marketId: <marketId>, timeFrame: "1h", limit: 24 })' },
  { name: 'get_market_indicators', description: 'Get market indicators: underlying APR, future premium, fear & greed', example: 'get_market_indicators({ marketId: <marketId>, timeFrame: "1h", select: ["u", "fp"] })' },
  { name: 'get_indicators_export', description: 'Export OHLCV + indicators as CSV (rate-limited 3/min)', example: 'get_indicators_export({ marketId: <marketId>, timeFrame: "1h" })' },
  { name: 'get_strategies', description: 'View available trading strategies and arb opportunities', example: 'get_strategies()' },
  { name: 'get_gas_price', description: 'Get current gas price and estimated order cost', example: 'get_gas_price()' },
  { name: 'get_funding_rate_symbols', description: 'List available funding rate symbols across exchanges', example: 'get_funding_rate_symbols()' },
  { name: 'get_settlement_summary', description: 'Historical funding-rate settlement summaries per market', example: 'get_settlement_summary({ marketIds: [<marketId>], fromTimestamp: <unix>, toTimestamp: <unix> })' },
  { name: 'get_maker_incentives', description: 'Maker incentive campaign data per market', example: 'get_maker_incentives({ marketId: <marketId> })' },
  { name: 'get_liquidation_events', description: 'Recent liquidation events, newest-first', example: 'get_liquidation_events({ marketId: <marketId> })' },
  { name: 'get_on_chain_events', description: 'Raw on-chain events with filters (eventName, block range)', example: 'get_on_chain_events({ eventName: "BulkOrdersExecuted" })' },
  { name: 'get_tvl', description: 'Protocol TVL in USD with per-token breakdown', example: 'get_tvl()' },
  { name: 'get_leaderboard', description: 'Top traders by ROI for a period + token', example: 'get_leaderboard({ period: "7d", tokenId: <tokenId> })' },
  { name: 'search_leaderboard', description: 'Look up a user on the leaderboard', example: 'search_leaderboard({ userAddress: "0x...", period: "7d", tokenId: <tokenId> })' },
  { name: 'get_amm_user_rewards', description: 'AMM rewards (accrued + unclaimed) in USD with per-market breakdown (unclaimed + all-time PENDLE & swap fees)', example: 'get_amm_user_rewards({ userAddress: "0x..." })' },
  { name: 'get_vault_info', description: 'Get vault TVL, APY, and optional user LP position (summary list by default; pass marketId for full detail)', example: 'get_vault_info({ marketId: <marketId>, userAddress: "0x..." })' },
  { name: 'get_amm_info', description: 'Get AMM state, fee rate, and implied rate (only markets with metadata.ammId > 0)', example: 'get_amm_info({ marketId: <marketId> })' },

  { name: 'get_portfolio_summary', description: 'Aggregate portfolio snapshot: equity, margin, utilization, open-position/order counts — one call instead of collateral+positions+orders fan-out', example: 'get_portfolio_summary({ userAddress: "0x..." })' },
  { name: 'get_positions', description: 'List open positions (market, direction, size, entry APR, liquidation APR). For equity/margin roll-up, prefer get_portfolio_summary.', example: 'get_positions({ userAddress: "0x..." })' },
  { name: 'get_collateral', description: 'Check margin balance and available collateral per marketAcc', example: 'get_collateral({ userAddress: "0x..." })' },
  { name: 'get_gas_balance', description: 'Check gas balance for transaction fees', example: 'get_gas_balance({ userAddress: "0x..." })' },
  { name: 'get_transaction_history', description: 'View past trades and order history', example: 'get_transaction_history({ userAddress: "0x..." })' },
  { name: 'get_pnl_history', description: 'Get funding rate settlement history', example: 'get_pnl_history({ userAddress: "0x..." })' },
  { name: 'get_pnl_by_market', description: 'Per-market PnL summary (unrealised + trade + settlement)', example: 'get_pnl_by_market({ marketAcc: "0x...", marketId: <marketId> })' },
  { name: 'get_entered_markets', description: 'List markets a cross account has entered', example: 'get_entered_markets({ marketAcc: "0x..." })' },
  { name: 'get_limit_orders', description: 'List a user\'s limit orders (filterable by market/active status). Use this for "open orders" / "pending orders".', example: 'get_limit_orders({ userAddress: "0x...", isActive: true })' },
  { name: 'get_all_limit_orders', description: 'All limit orders (paginate-safe by placed event)', example: 'get_all_limit_orders({ userAddress: "0x..." })' },
  { name: 'get_transfer_logs', description: 'Deposit/withdrawal/transfer history', example: 'get_transfer_logs({ userAddress: "0x..." })' },
  { name: 'get_gas_history', description: 'Gas consumption history', example: 'get_gas_history({ userAddress: "0x..." })' },
  { name: 'get_agent_expiry', description: 'On-chain agent approval expiry for any agent address', example: 'get_agent_expiry({ userAddress: "0x...", agentAddress: "0x..." })' },

  { name: 'simulate_order', description: 'Simulate an order before execution (preview margin, fees, price impact)', example: 'simulate_order({ marketId: <marketId>, side: "long", size: "10", orderType: "market" })' },
  { name: 'place_order', description: 'Execute a trade after simulation', example: 'place_order({ marketId: <marketId>, side: "long", size: "10", orderType: "market" })' },
  { name: 'place_orders', description: 'Batched N single orders (advanced: raw limitTick, desiredRate, per-order ammId)', example: 'place_orders({ orders: [...] })' },
  { name: 'place_ladders', description: 'Bundled orderbook-only orders (MM ladder / gas-optimized taker batch)', example: 'place_ladders({ cross: true, ladders: [...] })' },
  { name: 'simulate_close', description: 'Simulate closing a position', example: 'simulate_close({ marketId: <marketId>, side: "long" })' },
  { name: 'close_position', description: 'Close an open position', example: 'close_position({ marketId: <marketId>, side: "long" })' },
  { name: 'simulate_deposit', description: 'Preview deposit state change without executing', example: 'simulate_deposit({ tokenId: <tokenId>, humanAmount: 100 })' },
  { name: 'simulate_cash_transfer', description: 'Preview a margin transfer between cross and isolated WITHOUT executing. Pair with cash_transfer.', example: 'simulate_cash_transfer({ marketId: <marketId>, direction: "cross_to_isolated", humanAmount: 100 })' },
  { name: 'cancel_orders', description: 'Cancel open limit orders', example: 'cancel_orders({ marketId: <marketId>, orderIds: ["<orderId>"] })' },
  { name: 'cash_transfer', description: 'Transfer margin between cross and isolated accounts', example: 'cash_transfer({ marketId: <marketId>, direction: "cross_to_isolated", humanAmount: 100 })' },
  { name: 'enter_exit_markets', description: 'Enter or exit markets on cross margin', example: 'enter_exit_markets({ action: "enter", marketIds: [<marketId>] })' },
  { name: 'simulate_add_liquidity', description: "Preview adding single-sided cash liquidity to a market's AMM pool. Fee-only preview; pair with add_liquidity. Cash inputs are Boros-internal 18d cash unit (NOT token-native).", example: 'simulate_add_liquidity({ marketId: <marketId>, humanCash: 100 })' },
  { name: 'add_liquidity', description: "Add single-sided cash liquidity to a market's AMM pool. Without an explicit `minLpOut` defaults to 0 (no slippage protection — sim does not project LP-out).", example: 'add_liquidity({ marketId: <marketId>, humanCash: 100, minLpOut: "0" })' },
  { name: 'simulate_remove_liquidity', description: "Preview burning LP tokens to receive single-sided cash from a market's AMM pool. Fee-only preview; pair with remove_liquidity.", example: 'simulate_remove_liquidity({ marketId: <marketId>, humanLp: 10 })' },
  { name: 'remove_liquidity', description: "Burn LP tokens to receive single-sided cash from a market's AMM pool. Without an explicit `minCashOut` defaults to 0 (no slippage protection — sim does not project cash-out).", example: 'remove_liquidity({ marketId: <marketId>, humanLp: 10, minCashOut: "0" })' },

  { name: 'deposit', description: 'Deposit collateral from wallet (opens browser)', example: 'deposit({ tokenId: <tokenId>, humanAmount: 100 })' },
  { name: 'withdraw', description: 'Withdraw collateral to wallet (opens browser, has cooldown)', example: 'withdraw({ tokenId: <tokenId>, humanAmount: 50 })' },
  { name: 'cancel_withdraw', description: 'Cancel a pending withdrawal in cooldown', example: 'cancel_withdraw({ tokenId: <tokenId> })' },
  { name: 'revoke_agent', description: 'Revoke an agent approval (opens browser)', example: 'revoke_agent({ agentAddress: "0x..." })' },
  { name: 'vault_pay_treasury', description: 'Pay treasury from wallet (vault path)', example: 'vault_pay_treasury({ tokenId: <tokenId>, humanAmount: 5 })' },
  { name: 'pay_gas', description: 'Top up off-chain gas budget (deducted from margin account)', example: 'pay_gas({ amount: 10, marketId: <marketId> })' },

  { name: 'setup_agent', description: 'Connect wallet and approve MCP as trading agent (opens browser)', example: 'setup_agent()' },
  { name: 'agent_status', description: 'Check agent connection status and expiry', example: 'agent_status()' },

  { name: 'search_boros_docs', description: 'Search public Boros docs (GitBook + dev docs + OpenAPI) for FAQ-style questions. Use BEFORE answering "how does X work" / "what is Y" instead of guessing.', example: 'search_boros_docs({ query: "how does cross margin work" })' },
];

export const CATALOG_BY_NAME: Map<string, ToolEntry> = new Map(
  TOOL_CATALOG.map((t) => [t.name, t]),
);

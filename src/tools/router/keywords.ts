// Keyword → tool mappings. Order matters: most-specific mappings first; ties favor first-declared.
export interface KeywordMapping {
  // Tokenized contiguous-sequence match — 'open' won't match inside 'open interest' / 'open orders'.
  keywords: string[];
  tools: string[];
  // When true, matcher returns the GLOSSARY block instead of tool suggestions.
  glossary?: boolean;
}

export const KEYWORD_MAPPINGS: KeywordMapping[] = [
  // FAQ runs BEFORE glossary so doc-style questions hit the live doc search; glossary wins on
  // specific terms (tick, marketAcc, YU, etc.).
  { keywords: ['faq', 'documentation', 'docs', 'doc', 'how does', 'how do i', 'where can i read', 'guide', 'tutorial', 'gitbook', 'openapi', 'api reference', 'help'], tools: ['search_boros_docs'] },

  { keywords: ['glossary', 'define', 'definition', 'explain', 'what is', 'what does', 'what means', 'meaning', 'tick', 'marketacc', 'market acc', 'yu', 'yield unit', 'cross margin', 'isolated margin'], tools: [], glossary: true },

  { keywords: ['portfolio', 'equity', 'net worth', 'portfolio value', 'total value', 'account value'], tools: ['get_portfolio_summary'] },
  { keywords: ['market', 'list', 'find', 'search', 'available', 'browse', 'markets'], tools: ['get_markets', 'get_market'] },
  { keywords: ['orderbook', 'order book', 'book', 'depth', 'bid', 'ask', 'spread'], tools: ['get_orderbook'] },
  // 'open' removed — over-matched "open interest"/"open orders". Use explicit verbs only.
  { keywords: ['trade', 'buy', 'sell', 'go long', 'go short', 'long position', 'short position', 'open position', 'place trade', 'place order', 'place a limit', 'place limit', 'place a market', 'place market', 'submit order', 'create order', 'swap'], tools: ['simulate_order', 'place_order'] },
  { keywords: ['close position', 'close', 'exit position', 'unwind'], tools: ['simulate_close', 'close_position'] },
  { keywords: ['cancel order', 'cancel orders', 'cancel'], tools: ['cancel_orders'] },
  // Limit/open orders — separate from trade-verb 'open' to avoid mis-routing to place_order.
  { keywords: ['limit order', 'limit orders', 'open orders', 'pending orders', 'active orders', 'my orders', 'resting orders'], tools: ['get_limit_orders', 'get_all_limit_orders'] },
  { keywords: ['recent trades', 'last trades', 'trade tape', 'tape', 'fills'], tools: ['get_market_trades'] },
  { keywords: ['position', 'holdings', 'pnl'], tools: ['get_positions', 'get_portfolio_summary'] },
  { keywords: ['balance', 'collateral', 'margin'], tools: ['get_collateral', 'get_portfolio_summary'] },
  { keywords: ['deposit', 'add funds'], tools: ['deposit'] },
  { keywords: ['withdraw', 'remove funds', 'pull out', 'take out'], tools: ['withdraw', 'cancel_withdraw'] },
  { keywords: ['transfer', 'move', 'shift'], tools: ['cash_transfer', 'simulate_cash_transfer'] },
  { keywords: ['gas', 'transaction fee'], tools: ['get_gas_balance', 'pay_gas', 'get_gas_price'] },
  { keywords: ['setup', 'connect', 'wallet', 'agent', 'approve', 'auth', 'authenticate', 'login'], tools: ['setup_agent'] },
  { keywords: ['status', 'check agent', 'connection'], tools: ['agent_status'] },
  { keywords: ['funding rate', 'funding', 'yield'], tools: ['get_market_indicators', 'get_chart'] },
  { keywords: ['chart', 'price', 'graph', 'candle', 'candlestick', 'ohlc', 'ohlcv'], tools: ['get_chart'] },
  { keywords: ['strategy', 'arb', 'arbitrage', 'opportunity'], tools: ['get_strategies'] },
  { keywords: ['history', 'past trades', 'trade log', 'transaction history'], tools: ['get_transaction_history'] },
  { keywords: ['indicator', 'underlying', 'premium', 'fear', 'greed'], tools: ['get_market_indicators'] },
  { keywords: ['settlement', 'pnl history', 'funding settlement'], tools: ['get_pnl_history'] },
  { keywords: ['enter market', 'exit market', 'cross margin market'], tools: ['enter_exit_markets', 'get_entered_markets'] },
  { keywords: ['tvl', 'total value locked', 'protocol size'], tools: ['get_tvl'] },
  { keywords: ['leaderboard', 'top traders', 'ranking', 'rank'], tools: ['get_leaderboard', 'search_leaderboard'] },
  { keywords: ['liquidation', 'liquidate', 'liquidated'], tools: ['get_liquidation_events'] },
  { keywords: ['on-chain event', 'on chain event', 'raw event', 'event log'], tools: ['get_on_chain_events'] },
  { keywords: ['maker incentive', 'maker reward', 'incentive campaign'], tools: ['get_maker_incentives'] },
  { keywords: ['funding rate symbol', 'symbol list', 'funding symbols'], tools: ['get_funding_rate_symbols'] },
  { keywords: ['settlement summary', 'market settlement'], tools: ['get_settlement_summary'] },
  { keywords: ['amm reward', 'vault reward', 'lp reward'], tools: ['get_amm_user_rewards'] },
  { keywords: ['vault', 'lp', 'liquidity pool'], tools: ['get_vault_info', 'get_amm_info'] },
  { keywords: ['pnl by market', 'market pnl', 'per-market pnl', 'per market pnl'], tools: ['get_pnl_by_market'] },
  { keywords: ['ladder', 'market maker', 'mm ladder', 'batch orders'], tools: ['place_ladders', 'place_orders'] },
  { keywords: ['simulate deposit', 'deposit preview'], tools: ['simulate_deposit'] },
  { keywords: ['simulate transfer', 'preview transfer', 'simulate cash transfer'], tools: ['simulate_cash_transfer'] },
  { keywords: ['revoke agent', 'remove agent', 'agent revoke'], tools: ['revoke_agent'] },
  { keywords: ['vault pay', 'vault treasury'], tools: ['vault_pay_treasury'] },
  { keywords: ['agent expiry', 'agent approval', 'third-party agent', 'third party agent'], tools: ['get_agent_expiry'] },
  { keywords: ['csv export', 'export csv', 'download indicator'], tools: ['get_indicators_export'] },
  { keywords: ['bulk market', 'markets by id', 'specific markets'], tools: ['get_markets_by_ids'] },
  { keywords: ['transfer log', 'deposit history', 'withdrawal history'], tools: ['get_transfer_logs'] },
  { keywords: ['gas history', 'gas spent'], tools: ['get_gas_history'] },
  { keywords: ['asset', 'assets', 'token list', 'list tokens', 'supported tokens', 'tokenid', 'token id', 'usd price'], tools: ['get_assets'] },
];

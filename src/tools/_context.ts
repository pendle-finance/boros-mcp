// Shared prose constants for tool `_context` metadata. Tools spread SIDE_CONTEXT only when their
// response actually carries a numeric side field.

export const APR_NOTE =
  'APR / rate fields are annualized decimals (0.05 = 5%). Fields ending in "Percent" are pre-formatted strings. Raw on-chain rate fields are 18-decimal scaled bigints — divide by 1e18.';

// Boros normalizes every collateral to 18 decimals internally (utils.ts:formatX18 hardcodes 18).
// Amount fields are already human-scaled — don't re-divide by token on-chain decimals.
export const AMOUNTS_IN_COLLATERAL_NOTE =
  'Amount fields (cash, margin, PnL, yield, fee, settlement) are already 18-decimal-normalized human strings (Boros internal cash unit, regardless of underlying token). Do NOT re-scale by the token\'s on-chain decimals. marketAccDecoded.tokenSymbol identifies the underlying token for display only.';

export const MARKET_ACC_ENCODING =
  'Packed bytes26. Do NOT hex-parse; use the *Decoded sibling ({root,accountId,tokenId,marketId,isCross}). marketId=0xFFFFFF means cross.';

export const SIDE_CONTEXT = { side: '0 = long, 1 = short' };

export const MARKET_ACC_CONTEXT = { marketAcc: MARKET_ACC_ENCODING };

// Glossary served on demand by `boros_glossary` — single place the LLM looks up definitions
// pruned from per-tool _context blocks. Keep entries short.
export const BOROS_GLOSSARY = {
  apr: APR_NOTE,
  underlyingApr: 'Current APR of the underlying asset — the live funding rate of the underlying exchange (e.g. Binance, Hyperliquid).',
  impliedApr: 'Market price of YU in yield-percentage terms — consensus on YU\'s average future yield. On entry, the implied yield becomes the position\'s fixed payable/receivable rate.',
  myFixedApr: 'Fixed APR of an open position, set by the weighted average of implied APRs during entry. Long pays this; short receives this.',
  liquidationImpliedApr: 'Implied APR level at which the position becomes liquidatable. Implied-APR moves directly affect Net Balance.',
  rateSensitivity: 'PnL change per 1% APR move (= 100× DV01 in TradFi interest-rate-swap terms). Higher with more time to maturity.',
  dailyVolatility: '7-day moving average of the market\'s implied-APR range — recent day-to-day swing magnitude.',
  notionalSize: 'Position size measured in YU (Yield Units). YU is denominated in the market\'s COLLATERAL token (look up the human symbol via get_assets, keyed by the market\'s tokenId), NOT the underlying base asset. Examples: on a USDT-collateralized BTC-funding market, 30 YU = 30 USDT of BTC-funding notional (~$30, not $3M). On a WETH-collateralized ETH-funding market, 200 YU = 200 WETH of ETH-funding notional (~$200 × ETH price). The dapp orderbook column header confirms this: it renders as "Total (<collateral> YU)".',
  side: '0 = long, 1 = short. Long pays fixed APR, receives floating. Short receives fixed APR, pays floating.',
  longRate: 'Long position on the underlying rate (a.k.a. Long YU). Pays the fixed APR set at entry, receives the floating underlying APR.',
  longRateApr: 'Expected ROI of a long-rate position if the average underlying APR holds until maturity.',
  shortRate: 'Short position on the underlying rate (a.k.a. Short YU). Receives the fixed APR set at entry, pays the floating underlying APR.',
  shortRateApr: 'Expected ROI of a short-rate position if the average underlying APR holds until maturity.',
  maturity: 'Pool end-time. At maturity the position is fully settled and reflected in collateral.',
  collateral: 'Capital backing the position. Becomes liquidatable when Net Balance falls below Maintenance Margin.',
  netBalance: 'Total in-position portfolio value = collateral + unrealized PnL. Collateral updates at each yield settlement; unrealized PnL tracks current implied APR.',
  maintenanceMargin: 'Minimum capital to keep the position open; dropping below triggers liquidation. = 50% of Initial Margin.',
  initialMargin: 'Margin consumed at entry. Function of notional size, time to maturity, and implied APR.',
  marginFloor: 'Lower bound on initial margin near maturity or when implied APR ≈ 0%, preventing margin from falling too low and capping bad-debt risk during volatility.',
  marketAcc: 'Packed bytes26 (root | accountId | tokenId | marketId). Do NOT hex-parse; use the *Decoded sibling field. marketId = 0xFFFFFF (16777215) means cross-margin (per token); any other value is isolated (per market).',
  cross: 'Cross-margin: one bucket per (root, accountId, tokenId), keyed by the 0xFFFFFF (16777215) marketId sentinel. Shared across every market entered for that token (see get_entered_markets). Distinct tokens = distinct cross buckets (USDT-cross ≠ WETH-cross).',
  isolated: 'Isolated margin: a per-market bucket keyed by (root, accountId, tokenId, real marketId). Each market has its own collateral and risk, walled off from cross and from other isolated markets. Move funds in/out via cash_transfer.',
  tick: 'Integer index into a discrete rate ladder. Convert tick→APR via getRateAtTick and APR→tick via estimateTickForRate. tickStep is per-market and must be respected when placing limit orders.',
  YU: 'Yield Unit. One YU = funding-bearing notional of 1 unit of the market\'s COLLATERAL token on the underlying perp — NOT 1 unit of the underlying base asset. The market\'s collateral is identified by its tokenId (resolve to a human symbol via get_assets). Confirmed by the dapp orderbook header which renders "Total (<collateral_symbol> YU)" — e.g. on a USDT-collateralized BTC market, the header reads "USDT YU" and 30 YU means 30 USDT of BTC-funding notional. To convert to USD: multiply YU by the collateral token\'s usdPrice (get_assets). In tool responses YU is signed + 18-dec formatted: positive = long taker, negative = short taker. Cost/margin/PnL are always in the same collateral token.',
  agent: 'Ephemeral Ethereum keypair generated by setup_agent and approved on-chain by the user wallet via the Pendle Boros Router contract for 30 days. Trading tools (place_order, cancel_orders, etc.) sign with this key; deposits/withdrawals still require the user wallet.',
  router: 'On-chain "Pendle Boros Router" contract at 0x8080808080daB95eFED788a9214e400ba552DEf6 on Arbitrum (chainId 42161). For trading flows use place_order (mode:"simulate" first, then mode:"execute"); for agent approval use setup_agent.',
};

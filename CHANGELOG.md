# @pendle/boros-mcp

## 0.2.0

### Minor Changes

- e5bb00f: Fix tools that drifted from the Boros backend.

  Previously broken, now working: `add_liquidity`/`remove_liquidity` with `mode:'execute'`, `cancel_withdraw`, `enter_exit_markets` on isolated-only markets and on matured markets, and `get_leaderboard` (all rejected `tokenId` at the schema).

  Corrected amounts: the `withdraw` simulation sent token-native decimals to an 18-decimal endpoint (off by 1e12 on USD₮0/USDC); raw 18-decimal values leaked under human-readable labels in `cash_transfer`, `simulate_place_order`, `get_positions` and `get_collateral`; `get_maker_incentives` reported an incentive range ~400x too narrow; the withdraw cooldown fell back to 48x the real value.

  Recovered data: `marketName` was missing from six account tools, ~19 advertised `include` names resolved to nothing across five tools, gas top-ups were reported as zero-cost debits, and a liquidated AMM pool read as healthy.

  Output shape changes: `get_maker_incentives` returns `rewardTokens` (per-reward map) instead of `rewardToken` (a string that has been wrong since rebates shipped), and `unclaimedRewards` is no longer a filter/sort key on `get_amm_user_rewards` — it now errors instead of silently returning nothing.

  AMM calldata is verified against the Router ABI and pinned on `ammId`/`marketId`/`amountExact` before signing; undecodable calldata throws rather than being signed.

## 0.1.8

### Patch Changes

- b81bcad: Add Boros documentation pointers so the model knows where to read more: a `docs` field on the `boros_glossary` tool and a documentation list in the README, covering the `docs.pendle.finance/boros-dev` pages plus the new bulk historical-data archive at `https://historical-data.boros.finance`. `get_market_ohlcv`, `get_market_trades` and `get_orderbook` now point to the archive for long-range history.

## 0.1.7

### Patch Changes

- 5d8d8f0: Improve logging

## 0.1.6

### Patch Changes

- e34a116: Add simulate_place_order tool to simulate place order without agent

## 0.1.5

### Patch Changes

- 0b73ebe: fix unit scaling bugs

## 0.1.4

### Patch Changes

- c156860: improve handling for isolated markets

## 0.1.3

### Patch Changes

- ec64951: `include` arrays on listing tools (e.g. `get_markets`, `get_orders`) now accept default field names as no-ops. Previously, passing a default field (e.g. `maturityIso` on `get_markets`) raised a Zod enum-mismatch error because the enum only contained `"all"` plus the optional-field list. Agents frequently mix default and optional field names when constructing `include`; this change makes the schema tolerant so the first call succeeds instead of forcing a retry. Downstream projection is unchanged — `buildIncludeSet` was already de-duping via Set.

  Fix misleading `YU` and `notionalSize` glossary entries. The previous text said "1 YU = 1 unit of underlying collateral (e.g. 1 BTC of Hyperliquid funding)" — which conflated the underlying perp's base asset with the market's collateral token. The dapp orderbook (`OrderbookList.vue`) renders YU sizes under "Total (<collateral_symbol> YU)", confirming that **1 YU = 1 unit of the market's collateral token of funding-bearing notional**, not 1 unit of the underlying base. For a USDT-collateralized BTC-funding market, 30 YU = 30 USDT of notional (~$30), not 30 BTC (~$3M). This fix prevents agents from over-sizing orders by orders of magnitude based on incorrect base-asset math.

## 0.1.2

### Patch Changes

- 24201f3: fix: Properly set env for workflows

## 0.1.1

### Patch Changes

- 360f130: Rename get_limit_orders → get_orders (now covers MARKET/TP/SL); switch get_collateral and get_portfolio_summary to /v1/accounts/market-acc-infos-by-root so dust sub-accounts (cash, no positions) are included.

## 0.1.0

### Minor Changes

- first release of boros MCP

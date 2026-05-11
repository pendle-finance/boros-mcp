---
"@pendle/boros-mcp": patch
---

`include` arrays on listing tools (e.g. `get_markets`, `get_orders`) now accept default field names as no-ops. Previously, passing a default field (e.g. `maturityIso` on `get_markets`) raised a Zod enum-mismatch error because the enum only contained `"all"` plus the optional-field list. Agents frequently mix default and optional field names when constructing `include`; this change makes the schema tolerant so the first call succeeds instead of forcing a retry. Downstream projection is unchanged — `buildIncludeSet` was already de-duping via Set.

Fix misleading `YU` and `notionalSize` glossary entries. The previous text said "1 YU = 1 unit of underlying collateral (e.g. 1 BTC of Hyperliquid funding)" — which conflated the underlying perp's base asset with the market's collateral token. The dapp orderbook (`OrderbookList.vue`) renders YU sizes under "Total (<collateral_symbol> YU)", confirming that **1 YU = 1 unit of the market's collateral token of funding-bearing notional**, not 1 unit of the underlying base. For a USDT-collateralized BTC-funding market, 30 YU = 30 USDT of notional (~$30), not 30 BTC (~$3M). This fix prevents agents from over-sizing orders by orders of magnitude based on incorrect base-asset math.

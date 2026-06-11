---
"@pendle/boros-mcp": patch
---

Add Boros documentation pointers so the model knows where to read more: a `docs` field on the `boros_glossary` tool and a documentation list in the README, covering the `docs.pendle.finance/boros-dev` pages plus the new bulk historical-data archive at `https://historical-data.boros.finance`. `get_market_ohlcv`, `get_market_trades` and `get_orderbook` now point to the archive for long-range history.

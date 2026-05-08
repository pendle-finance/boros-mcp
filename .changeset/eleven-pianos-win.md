---
"@pendle/boros-mcp": patch
---

Rename get_limit_orders → get_orders (now covers MARKET/TP/SL); switch get_collateral and get_portfolio_summary to /v1/accounts/market-acc-infos-by-root so dust sub-accounts (cash, no positions) are included.

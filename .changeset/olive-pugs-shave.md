---
"@pendle/boros-mcp": minor
---

Move every core and send-txs-bot call site onto open-api, so the server talks to a single host (`https://api-boros.pendle.finance/apis`).

- `CORE_API_URL` and `SEND_TXS_BOT_URL` are removed; only `OPEN_API_URL` remains.
- Withdrawal state now reads `/apis/v1/accounts/transfer-logs`, and the 18-decimal normalised `amount` is converted back to token-native units at the boundary — a 6-decimal token previously rendered 1e12x too large.
- Cooldowns are read on-chain from MarketHub. A reset personal cooldown (`type(uint32).max`) is treated as "use the global cooldown" instead of a ~136-year one, which used to report `isWithdrawalRestricted: true` falsely.
- `exemptCLOMarkets` is dropped from the global config shape — it was never read, and cost ~92 contract reads per call.

Note: `/apis/v1/send-txs/*` is metered at 5 CU per call against the 200 CU/min per-IP budget (~40 calls/min), where `/send-txs-bot` was unmetered.

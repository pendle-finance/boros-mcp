---
"@pendle/boros-mcp": minor
---

Fix tools that drifted from the Boros backend.

Previously broken, now working: `add_liquidity`/`remove_liquidity` with `mode:'execute'`, `cancel_withdraw`, `enter_exit_markets` on isolated-only markets and on matured markets, and `get_leaderboard` (all rejected `tokenId` at the schema).

Corrected amounts: the `withdraw` simulation sent token-native decimals to an 18-decimal endpoint (off by 1e12 on USD₮0/USDC); raw 18-decimal values leaked under human-readable labels in `cash_transfer`, `simulate_place_order`, `get_positions` and `get_collateral`; `get_maker_incentives` reported an incentive range ~400x too narrow; the withdraw cooldown fell back to 48x the real value.

Recovered data: `marketName` was missing from six account tools, ~19 advertised `include` names resolved to nothing across five tools, gas top-ups were reported as zero-cost debits, and a liquidated AMM pool read as healthy.

Output shape changes: `get_maker_incentives` returns `rewardTokens` (per-reward map) instead of `rewardToken` (a string that has been wrong since rebates shipped), and `unclaimedRewards` is no longer a filter/sort key on `get_amm_user_rewards` — it now errors instead of silently returning nothing.

AMM calldata is verified against the Router ABI and pinned on `ammId`/`marketId`/`amountExact` before signing; undecodable calldata throws rather than being signed.

# @pendle/boros-mcp

An [MCP](https://modelcontextprotocol.io) server that lets your AI assistant trade interest rate derivatives on [Boros](https://boros.finance) — Pendle's funding rate swap platform on Arbitrum.

Ask your model things like *"what's the current 3-month funding rate on BTC perp?"*, *"open a 0.5 ETH long on the 30-day market at 8% APR"*, or *"show my open positions and unrealized PnL"* — and it can answer or execute, end-to-end.

## What you get

- **57 tools** covering market data, account state, trading, and wallet operations
- **Delegated agent keys** — the LLM signs trades with an ephemeral key you authorize once, your main wallet stays cold
- **Simulate-then-execute** — every order is previewed before it touches the chain
- **Cross-margin and isolated-margin** support
- **Read-only by default** — destructive tools are clearly marked and require explicit approval

## Install

> **Beta release.** The package is currently published under the `beta` dist-tag. Use `@beta` to install, or pin a specific `0.x.y-beta.z` version.

Requires Node.js ≥ 18. The package ships a `boros-mcp` binary, so `npx` works without a global install:

```bash
npx -y @pendle/boros-mcp@beta
```

Or install globally:

```bash
npm install -g @pendle/boros-mcp@beta
boros-mcp
```

Building from source is only needed if you're hacking on the server:

```bash
git clone https://github.com/pendle-finance/boros-mcp
cd boros-mcp
npm install && npm run build
```

## Configure your client

### Claude Desktop / Claude Code

Add to your MCP config (`~/.claude/claude_desktop_config.json` or equivalent):

```json
{
  "mcpServers": {
    "boros": {
      "command": "npx",
      "args": ["-y", "@pendle/boros-mcp@beta"]
    }
  }
}
```

If you built from source, point at the local entry instead:

```json
{
  "mcpServers": {
    "boros": {
      "command": "node",
      "args": ["/absolute/path/to/boros-mcp/dist/index.js"]
    }
  }
}
```

### Other MCP clients

Run `npx -y @pendle/boros-mcp@beta` (or `boros-mcp` if installed globally) and point your client at it over stdio transport.

## First-run setup

On first use, ask your assistant to *"set up a Boros agent"*. The server will:

1. Generate a fresh Ethereum keypair (the **agent key**) locally
2. Open a browser page where you connect your real wallet and approve the agent on Boros's Router contract
3. Encrypt the agent key with AES-256-GCM and store it at `~/.boros-mcp/agent.enc`

The agent key expires after 30 days. Revoke it any time with *"revoke my Boros agent"*.

Your main wallet only signs once (the approval). Every trade after that is signed by the delegated agent.

## What it can do

| Domain | Examples |
|---|---|
| **Market data** | List markets, get orderbook, funding rate history, AMM info, price charts, market indicators |
| **Account** | Open positions, PnL, transaction history, gas balance, settlement summary |
| **Trading** | Place / cancel orders, place ladders, close positions, cash transfers between markets |
| **Wallet** | Deposit, withdraw, cancel pending withdrawals (browser-signed by your main wallet) |
| **Discovery** | Built-in router that picks the right tool for a natural-language request, plus searchable docs |

Run *"list Boros tools"* with the server connected for the full list and per-tool descriptions.

## Environment variables

All optional — sensible defaults are baked in.

| Variable | Default | Purpose |
|---|---|---|
| `BOROS_API_URL` | `https://api.boros.finance/open-api` | Boros REST API |
| `BOROS_SEND_TXS_URL` | `https://api.boros.finance/send-txs-bot` | Tx submission endpoint |
| `BOROS_MCP_PORT` | `3000` | Local server port (used for the wallet-approval browser flow) |
| `ARBITRUM_RPC` | `https://arb1.arbitrum.io/rpc` | Arbitrum RPC endpoint |

## Security model

- Agent key lives **only** on your machine, encrypted at rest under a scrypt-derived key
- Wallet operations (deposit / withdraw) **never** use the agent key — they always re-prompt your real wallet in the browser
- Trade calldata is verified against the simulated parameters before signing
- The MCP server only listens on `localhost`; the browser approval pages POST results back to that local socket

## Useful links

- Source & issues: <https://github.com/pendle-finance/boros-mcp>
- Boros app: <https://boros.finance>
- Pendle: <https://pendle.finance>
- Model Context Protocol: <https://modelcontextprotocol.io>

## License

MIT

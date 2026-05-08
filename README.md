# @pendle/boros-mcp

[MCP](https://modelcontextprotocol.io) server that lets your AI assistant trade interest rate derivatives on [Boros](https://boros.finance) — Pendle's funding rate swap platform on Arbitrum.

Ask things like *"current 3-month BTC perp funding rate?"*, *"open 0.5 ETH long on the 30-day market at 8% APR"*, *"show open positions and unrealized PnL"*.

- **44 tools**: market data, account state, trading, wallet, AMM
- **Delegated agent key** — LLM signs trades with an ephemeral key you authorize once; main wallet stays cold
- **Simulate-then-execute** — every order previewed before chain submit
- Cross-margin and isolated-margin
- Wallet ops always re-prompt your real browser wallet

## Install

Node ≥ 18. Ships a `boros-mcp` binary.

```bash
npx -y @pendle/boros-mcp
# or
yarn global add @pendle/boros-mcp && boros-mcp
```

From source (only if hacking on it):

```bash
git clone https://github.com/pendle-finance/boros-mcp
cd boros-mcp && yarn install && yarn build
```

## Configure your client

The server speaks MCP over **stdio**, so any compliant client can launch it. Pick the one you use.

### Claude Code

One command (recommended):

```bash
claude mcp add boros -- npx -y @pendle/boros-mcp
```

Add `--scope user` for global (all projects) instead of the default project scope. Verify with `claude mcp list`.

### Claude Desktop

Edit `claude_desktop_config.json`:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "boros": {
      "command": "npx",
      "args": ["-y", "@pendle/boros-mcp"]
    }
  }
}
```

Restart the app to load the server.

### Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.boros]
command = "npx"
args = ["-y", "@pendle/boros-mcp"]
```

### Gemini CLI

Edit `~/.gemini/settings.json` (or your project's `.gemini/settings.json`):

```json
{
  "mcpServers": {
    "boros": {
      "command": "npx",
      "args": ["-y", "@pendle/boros-mcp"]
    }
  }
}
```

### opencode

Edit `~/.config/opencode/opencode.json` (or `opencode.json` at the project root):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "boros": {
      "type": "local",
      "command": ["npx", "-y", "@pendle/boros-mcp"],
      "enabled": true
    }
  }
}
```

### Built from source

Replace the `command`/`args` block in any of the configs above with:

```json
"command": "node",
"args": ["/absolute/path/to/boros-mcp/dist/index.js"]
```

### Other MCP clients

Run `npx -y @pendle/boros-mcp` (or `boros-mcp` if globally installed) and point your client at it over stdio transport.

## How approvals work — read this first

Boros MCP is **not** a pure JSON-RPC MCP. Alongside the stdio MCP channel it spins up a small HTTP server on `127.0.0.1:<random-port>` to broker browser-side wallet signatures. Necessary because Boros wallet operations require signatures from your **real** wallet, which lives in the browser, not in the LLM.

### Two classes of action

| Class | Tools | Signing key | Browser involved? |
|---|---|---|---|
| **Trading & AMM** | `place_order`, `place_orders`, `close_position`, `cancel_orders`, `add_liquidity`, `remove_liquidity`, `cash_transfer`, … | **Agent key** (delegated, on-disk) | No — fully autonomous |
| **Wallet & agent lifecycle** | `setup_agent`, `revoke_agent`, `deposit`, `withdraw`, `cancel_withdraw`, `vault_pay_treasury` | **Your main wallet** | Yes — browser callback |

### Localhost callback flow

When you run e.g. *"deposit 100 USDC into Boros"*:

1. Tool call returns a localhost URL with a one-time token: `http://127.0.0.1:<ephemeral-port>/deposit?token=<uuid>`. Server auto-opens it; URL is also echoed to stderr (`[boros-mcp] Opening browser: …`) so you can paste manually.
2. Page prompts your browser wallet (MetaMask, Rabby, …) to sign and broadcast the tx. Private key never leaves the browser.
3. After confirmation, page POSTs `txHash` back to the same localhost port.
4. Server **verifies the receipt on-chain**: tx hit `ROUTER_ADDRESS`, function selector is in the per-action allowlist, signed-from address matches your registered wallet. Only then does the tool call resolve success to the LLM.

If verification fails (wrong contract, wrong selector, wrong signer), the tool call errors and nothing further happens.

### First-run agent setup

On first use, ask *"set up a Boros agent"*. The server:

1. Generates a fresh Ethereum keypair (the **agent key**) in-process.
2. Opens an `/approve-agent` page where you connect your real wallet and **sign one EIP-712 typed message** (not a transaction — no gas paid; `send-txs-bot` relays the approval on-chain).
3. Once the relay tx confirms, encrypts the agent key with AES-256-GCM (scrypt-derived KDF, optional password) and stores it at `~/.boros-mcp/agent.enc`.

Subsequent trades signed locally by the delegated agent — no browser, no popups. Wallet operations always re-prompt the browser.

The agent is bounded on-chain to ~12 trade/AMM router selectors — it **cannot** withdraw, transfer to other wallets, change account managers, or approve other agents. Default expiry 30 days (`expiryDays` overrides, 1–365). Revoke via *"revoke my Boros agent"* (also a wallet-flow action).

### Why this matters for client config

- Server **must run as a long-lived child process** of the MCP client (which `claude mcp add` and the configs above all do). Not a one-shot RPC server — the in-memory `pendingActions` map is what makes the localhost callback safe (token → action lookup with TTL).
- **Port is ephemeral** (OS-assigned per startup). Do not firewall a fixed port; do not expose. Server only binds `127.0.0.1`.
- If your MCP client is sandboxed without browser/loopback access (e.g. remote container), wallet-signing tools will not work. Trading-only flows still function once an agent is provisioned from a non-sandboxed environment.

## Environment variables

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `ARBITRUM_RPC` | `https://arb1.arbitrum.io/rpc` | Arbitrum RPC endpoint |
| `BOROS_MCP_PRETTY` | unset | Set to `1` to pretty-print JSON tool responses (debug; ~30–40% more tokens) |

## Security model

- Agent key lives **only** on your machine, encrypted at rest under a scrypt-derived key (optional password, AES-256-GCM)
- Wallet operations (deposit / withdraw / agent setup / revoke / vault treasury) **never** use the agent key — always re-prompt your real wallet via the localhost callback
- Trade calldata verified against the simulated parameters before signing (selector allowlist + intent verification)
- Browser-callback transactions verified on-chain after submission: receipt status, target contract (`ROUTER_ADDRESS`), function selector (per-action allowlist), and signer address must all match. A malicious page cannot resolve a deposit by pointing at an unrelated successful tx.
- HTTP server only listens on `127.0.0.1`, on an **OS-assigned ephemeral port** chosen fresh each launch (no stable port to bookmark or expose). The chosen URL is logged to stderr at startup and embedded in every signing-page link returned by tools.
- One-time tokens scope each pending action (deposit, withdraw, agent approval, …) to a single browser callback. Tokens kept in memory only, invalidated on use or process exit.

## Links

- Source & issues: <https://github.com/pendle-finance/boros-mcp>
- Boros app: <https://boros.finance>
- Pendle: <https://pendle.finance>
- MCP: <https://modelcontextprotocol.io>

## License

MIT

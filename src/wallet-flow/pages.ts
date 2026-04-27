import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARBITRUM_RPC, CHAIN_ID, ROUTER_ADDRESS } from '../config.js';
import { pendingActions } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname=dist/wallet-flow; pages ship to dist/pages.
export const PAGES_DIR = path.join(__dirname, '..', 'pages');

/** Escape a JSON string so it is safe to embed inside an HTML `<script>` block. */
export function escapeJsonForScript(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Escape a value for safe use in an HTML attribute (double-quoted context). */
export function escapeHtmlAttribute(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function injectPageVars(html: string, token: string, serverPort: number): string {
  // Defense-in-depth — these are compile-time constants / UUIDs, but escape anyway.
  html = html.replace(/\{\{ROUTER_ADDRESS\}\}/g, escapeHtmlAttribute(ROUTER_ADDRESS));
  html = html.replace(/\{\{CHAIN_ID\}\}/g, escapeHtmlAttribute(CHAIN_ID.toString()));
  html = html.replace(/\{\{RPC_URL\}\}/g, escapeHtmlAttribute(ARBITRUM_RPC));
  html = html.replace(/\{\{TOKEN\}\}/g, escapeHtmlAttribute(token ?? ''));
  html = html.replace(/\{\{PORT\}\}/g, escapeHtmlAttribute(serverPort.toString()));
  return html;
}

export function serveHtmlPage(
  pageName: string,
  req: express.Request,
  res: express.Response,
  serverPort: number,
): void {
  const token = req.query.token as string;
  const action = token ? pendingActions.get(token) : undefined;
  const filePath = path.join(PAGES_DIR, `${pageName}.html`);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('Page not found');
    return;
  }
  let html = fs.readFileSync(filePath, 'utf-8');
  html = injectPageVars(html, token, serverPort);

  if (action?.data?.agentAddress) {
    html = html.replace(/\{\{AGENT_ADDRESS\}\}/g, escapeHtmlAttribute(String(action.data.agentAddress)));
  }
  if (action?.data?.expiryDays != null) {
    html = html.replace(/\{\{EXPIRY_DAYS\}\}/g, escapeHtmlAttribute(String(action.data.expiryDays)));
  }
  if (action?.data) {
    // TX_DATA embeds inside `<script type="application/json">` — escape to prevent block escape.
    html = html.replace(/\{\{TX_DATA\}\}/g, escapeJsonForScript(action.data));
    html = html.replace(/\{\{EXPECTED_ADDRESS\}\}/g, escapeHtmlAttribute(String(action.data.expectedAddress ?? '')));
  }
  res.type('html').send(html);
}

export const UNLOCK_PAGE_HTML = `
      <!DOCTYPE html>
      <html><head><title>Unlock Boros MCP Agent</title>
      <style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:20px;background:#0f1117;color:#e4e4e7}
      h1{font-size:1.4em}input{width:100%;padding:10px;margin:8px 0;box-sizing:border-box;background:#1a1b23;border:1px solid #2e2f3a;border-radius:8px;color:#e4e4e7;font-size:1em}
      button{background:#6366f1;color:white;border:none;padding:12px 20px;border-radius:8px;cursor:pointer;font-size:1em;width:100%;margin-top:8px}
      button:hover{background:#4f46e5}.error{color:#ef4444}.success{color:#22c55e}</style>
      </head><body>
      <h1>Unlock Boros MCP Agent</h1>
      <p style="color:#a1a1aa;margin-bottom:16px">Enter your password to decrypt the agent key.</p>
      <input type="password" id="password" placeholder="Password" autofocus>
      <button onclick="unlock()">Unlock</button>
      <p id="status" style="margin-top:12px"></p>
      <script>
      async function unlock() {
        const pw = document.getElementById('password').value;
        const res = await fetch('/api/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pw })
        });
        const data = await res.json();
        const el = document.getElementById('status');
        if (data.ok) {
          el.className = 'success';
          el.textContent = 'Agent unlocked! You can close this tab.';
        } else {
          el.className = 'error';
          el.textContent = data.error || 'Wrong password';
        }
      }
      document.getElementById('password').addEventListener('keydown', e => { if (e.key === 'Enter') unlock(); });
      </script></body></html>
    `;

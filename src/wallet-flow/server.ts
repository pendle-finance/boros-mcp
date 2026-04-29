import express from 'express';
import open from 'open';
import { agentKeyStore, pendingActions } from './state.js';
import { serveHtmlPage, UNLOCK_PAGE_HTML } from './pages.js';
import { handleComplete } from './routes-complete.js';
import { unlockAgent } from '../agent/agent-manager.js';

export { createPendingAction, storeAgentKey } from './state.js';

// Set on listen() — 0 = OS picks ephemeral port (RFC 8252 §7.3 loopback redirect).
let serverPort: number = 0;
// Lazy: open unlock page only once, on first auth-requiring tool call.
let unlockBrowserOpened = false;

function corsMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.headers.origin;
  const allowed = [
    `http://127.0.0.1:${serverPort}`,
    `http://localhost:${serverPort}`,
  ];
  if (origin && !allowed.includes(origin)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

export async function startServer(): Promise<number> {
  const app = express();
  app.use(express.json());
  app.use(corsMiddleware);

  // Liveness probe — no agent fields (would leak to co-resident processes); use agent_status MCP tool.
  app.get('/', (_req, res) => {
    res.json({ status: 'running', port: serverPort });
  });

  app.get('/approve-agent', (req, res) => serveHtmlPage('approve-agent', req, res, serverPort));
  app.get('/deposit', (req, res) => serveHtmlPage('deposit', req, res, serverPort));
  app.get('/withdraw', (req, res) => serveHtmlPage('withdraw', req, res, serverPort));
  app.get('/cancel-withdraw', (req, res) => serveHtmlPage('cancel-withdraw', req, res, serverPort));
  app.get('/sign-tx', (req, res) => serveHtmlPage('sign-tx', req, res, serverPort));

  app.get('/unlock', (_req, res) => { res.type('html').send(UNLOCK_PAGE_HTML); });

  app.post('/api/unlock', (req, res) => {
    const ok = unlockAgent(req.body.password ?? '');
    if (ok) {
      // Allow unlock page to re-open if agent is re-locked later.
      unlockBrowserOpened = false;
    }
    res.json({ ok });
  });

  app.post('/api/complete', handleComplete);

  app.get('/api/pending-action/:token', (req, res) => {
    const action = pendingActions.get(req.params.token);
    if (!action) { res.status(404).json({ error: 'Not found' }); return; }
    if (Date.now() > action.expiresAt) {
      pendingActions.delete(req.params.token);
      agentKeyStore.delete(req.params.token);
      res.status(410).json({ error: 'Expired' });
      return;
    }
    // Public data only — agentKeyStore never exposed.
    res.json({ data: action.data });
  });

  return new Promise<number>((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('Unexpected listen address shape (expected AddressInfo)'));
        return;
      }
      serverPort = addr.port;
      resolve(addr.port);
    });
    srv.on('error', reject);
  });
}

export function getServerPort(): number { return serverPort; }

export function openUnlockPageOnce(): string {
  const url = `http://127.0.0.1:${serverPort}/unlock`;
  if (unlockBrowserOpened) return url;
  unlockBrowserOpened = true;
  process.stderr.write(`[boros-mcp] Agent locked. Open unlock page: ${url}\n`);
  open(url).catch(() => {});
  return url;
}

export async function openPage(pagePath: string, queryParams?: Record<string, string>): Promise<string> {
  let url = `http://127.0.0.1:${serverPort}${pagePath}`;
  if (queryParams) {
    const params = new URLSearchParams(queryParams);
    url += `?${params.toString()}`;
  }
  // Echo to stderr so user can navigate manually if auto-open fails.
  process.stderr.write(`[boros-mcp] Opening browser: ${url}\n`);
  await open(url).catch(() => {});
  return url;
}

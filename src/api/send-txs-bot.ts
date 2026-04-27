import { SEND_TXS_BOT_URL } from '../config.js';

/** POST to send-txs-bot with JSON body. Returns parsed .data or full JSON. */
export async function sendTxsBotPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${SEND_TXS_BOT_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`send-txs-bot ${res.status}: ${res.statusText} — ${text}`);
    (err as any).status = res.status;
    try { Object.assign(err, JSON.parse(text)); } catch {}
    throw err;
  }
  const json = await res.json();
  return json.data ?? json;
}

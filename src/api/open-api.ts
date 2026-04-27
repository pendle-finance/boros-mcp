import { OPEN_API_URL } from '../config.js';

/** GET from open-api with query params. Returns parsed .data or full JSON. */
export async function openApiGet(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<any> {
  const url = new URL(`${OPEN_API_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`API ${res.status}: ${res.statusText} — ${body}`);
    (err as any).status = res.status;
    try { Object.assign(err, JSON.parse(body)); } catch {}
    throw err;
  }
  const json = await res.json();
  return json.data ?? json;
}

/** POST to open-api with JSON body. Returns parsed .data or full JSON. */
export async function openApiPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${OPEN_API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`API ${res.status}: ${res.statusText} — ${text}`);
    (err as any).status = res.status;
    try { Object.assign(err, JSON.parse(text)); } catch {}
    throw err;
  }
  const json = await res.json();
  return json.data ?? json;
}

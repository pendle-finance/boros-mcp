const MAX_RETRIES = 3;
const MAX_RETRY_WAIT_MS = 60_000;

// 408=req-timeout, 429=rate-limit, 502/503/504=gateway/unavailable.
const TRANSIENT_STATUSES = new Set<number>([408, 429, 502, 503, 504]);

// Node 18+ fetch wraps the real error in `.cause`.
const TRANSIENT_ERRNOS = new Set<string>([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function jitter(ms: number): number {
  return ms + Math.random() * 400 + 100; // 100-500ms jitter
}

function extractErrno(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const direct = e.code;
  if (typeof direct === 'string') return direct;
  const cause = e.cause;
  if (cause && typeof cause === 'object') {
    const c = (cause as Record<string, unknown>).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

function isTransientNetworkError(err: unknown): boolean {
  const errno = extractErrno(err);
  if (errno && TRANSIENT_ERRNOS.has(errno)) return true;
  // Undici/node fetch: `TypeError: fetch failed`.
  if (err instanceof TypeError && /fetch failed/i.test(String(err.message ?? ''))) return true;
  return false;
}

export async function fetchWithRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      const errObj = err as Record<string, any>;
      const status = (errObj?.status ?? errObj?.statusCode ?? errObj?.response?.status) as number | undefined;

      const httpTransient = typeof status === 'number' && TRANSIENT_STATUSES.has(status);
      const netTransient = isTransientNetworkError(err);

      if ((!httpTransient && !netTransient) || attempt === MAX_RETRIES) throw err;

      // Exponential backoff 1s/2s/4s capped at MAX_RETRY_WAIT_MS.
      let waitMs = Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);

      const headers: any = errObj?.headers ?? errObj?.response?.headers;
      if (headers && typeof headers === 'object') {
        const h = headers as Record<string, string>;
        const retryAfter = h['retry-after'] ?? h['Retry-After'] ?? h['x-ratelimit-reset'] ?? h['X-RateLimit-Reset'];
        if (retryAfter) {
          const parsed = parseInt(retryAfter, 10);
          if (!isNaN(parsed)) {
            // Treat large values (>1e9) as Unix timestamp seconds.
            const hinted = parsed > 1_000_000_000
              ? Math.max(0, parsed * 1000 - Date.now())
              : parsed * 1000;
            waitMs = hinted;
          }
        }
      }

      if (waitMs > MAX_RETRY_WAIT_MS) {
        // Surface the server's ask instead of silently capping.
        const secs = Math.ceil(waitMs / 1000);
        const capSecs = Math.ceil(MAX_RETRY_WAIT_MS / 1000);
        const hint = `rate limited, retry-after ${secs}s exceeds cap ${capSecs}s — back off before retry`;
        if (err instanceof Error) {
          try { err.message = `${err.message} (${hint})`; } catch { /* message readonly on some Error subclasses */ }
          throw err;
        }
        throw new Error(hint);
      }

      await new Promise(resolve => setTimeout(resolve, jitter(waitMs)));
    }
  }

  throw lastError;
}

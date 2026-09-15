/**
 * Postgres refuses U+0000 in both text and jsonb, and one refused row fails its whole
 * batch — which the flush loop then retries forever, so a single `head` of a binary
 * file in a transcript froze every row behind it. Swap it for U+FFFD, the same mark
 * the rest of that binary output already renders as.
 */
const noNul = (_k, v) => (typeof v === 'string' && v.includes('\u0000') ? v.replaceAll('\u0000', '\uFFFD') : v);

export const serializeBatch = (payload) => JSON.stringify(payload, noNul);

export async function postBatch(url, token, payload, timeoutMs = 60_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/api/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: serializeBatch(payload),
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    return { ok: res.ok, status: res.status, text: text.slice(0, 500) };
  } finally {
    clearTimeout(t);
  }
}

/** Ask the board to prune bulky columns for sessions older than its RETENTION_DAYS. */
export async function postRetention(url, token) {
  const res = await fetch(`${url}/api/retention`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, text: text.slice(0, 300) };
}

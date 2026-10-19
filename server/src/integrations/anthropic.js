// Anthropic: store the company's key for the AI workstream and check it with the
// Models API (GET /v1/models, read-only and free). The AI code (server/src/ai) uses the key.
import { ProviderError, httpFailure, request } from './http.js';

export async function testAnthropic({ apiKey }) {
  const r = await request('anthropic', 'https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
  });
  if (r.ok) return { status: 'ok', message: 'Connected.' };
  const type = r.json?.error?.type || null;
  if (r.status === 401) throw new ProviderError('anthropic', 'Anthropic refused the key. Create a new one in the Claude Console > API keys.', { status: 401, code: type, kind: 'auth' });
  if (r.status === 403) throw new ProviderError('anthropic', 'This key does not have permission to use the API.', { status: 403, code: type, kind: 'auth' });
  if (r.status === 529) throw new ProviderError('anthropic', 'Anthropic is overloaded right now. Try again in a minute.', { status: 529, code: type, retry: true, kind: 'unavailable' });
  throw httpFailure('anthropic', r.status, r.json?.error?.message, type);
}

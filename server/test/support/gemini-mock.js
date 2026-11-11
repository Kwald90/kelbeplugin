// A scripted stand-in for Gemini's generateContent REST endpoint, so no test calls the real
// API. It replaces the fetch gemini-client.js uses (setGeminiFetch) with one that answers from
// a queue of scripted responses and records every request body and header.
import { setGeminiFetch } from '../../src/ai/gemini-client.js';

/** A successful generateContent response: candidate parts + usage. */
export function geminiTurn(parts, { finishReason = 'STOP', usage = { promptTokenCount: 1000, candidatesTokenCount: 120 } } = {}) {
  return { status: 200, data: { candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata: usage } };
}
// A `sig` makes the part carry a thoughtSignature, as Gemini 3.x thinking models do; the client
// must echo it back on the same part in later turns or generateContent 400s on tool calls.
export const geminiText = (t, sig) => ({ text: t, ...(sig ? { thoughtSignature: sig } : {}) });
export const geminiCall = (name, args, sig) => ({ functionCall: { name, args }, ...(sig ? { thoughtSignature: sig } : {}) });

/** An HTTP error response (401, 429, 400, 500, …). */
export function geminiError(status, message = 'error') {
  return { status, data: { error: { code: status, message, status: 'ERROR' } } };
}

/**
 * Install the fake fetch. `script` is a list of responses (geminiTurn/geminiError), Errors to
 * throw (a network failure), or functions (body) => response. Returns the recorded calls.
 */
export function mockGemini(script = []) {
  const queue = [...script];
  const calls = [];
  setGeminiFetch(async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers || {}, body });
    let next = queue.shift();
    if (typeof next === 'function') next = next(body);
    if (next instanceof Error) throw next;
    if (!next) next = geminiTurn([geminiText('(no more scripted turns)')]);
    const status = next.status || 200;
    const data = next.data;
    return { ok: status >= 200 && status < 300, status, async json() { return data; } };
  });
  return { calls, push: (...r) => queue.push(...r), pending: () => queue.length };
}

export function restoreGemini() {
  setGeminiFetch(null);
}

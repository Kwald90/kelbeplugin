// Gemini — Google's Generative Language API, used to transcribe the audio of a site walkthrough.
// The key is Fishtape's own, set by an HQ admin in HQ -> Platform keys (platform-secrets.js,
// provider "gemini", env GEMINI_API_KEY) and resolved per job so a freshly saved key works
// without a restart. Verified against ai.google.dev/gemini-api/docs/audio (2026-11-03):
//   POST {base}/models/{model}:generateContent   header x-goog-api-key: <key>
//   body { contents:[{ parts:[{text}, {inlineData:{mimeType, data:<base64>}}] }] }
//   -> candidates[].content.parts[].text   (transcription is asked for in the prompt)
// Inline audio is capped at a 20 MB request, so the caller extracts a small mono 16 kHz clip;
// the model id and base are env-overridable so a Google rename never needs a code change.
import { loadPlatformSecretsMap } from './platform-secrets.js';

export const TRANSCRIBE_PROMPT =
  'Transcribe the spoken narration in this audio verbatim as plain text. '
  + 'It is an electrician narrating a walk through a job site, so expect electrical and construction '
  + 'terms. Return only the transcript, with light punctuation and no timestamps, labels or commentary. '
  + 'If there is no clear speech, return an empty response.';

/** Gemini settings; the model and base are overridable so a provider rename needs no code change. */
export function geminiSettings(config, env = process.env) {
  return {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.8-flash',
    apiBase: String(env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
    // A margin under the hard 20 MB inline-request limit (base64 inflates bytes by ~4/3).
    maxInlineBytes: Number(env.GEMINI_MAX_INLINE_BYTES) || 13 * 1024 * 1024,
  };
}

/**
 * Is a Gemini key configured? Cheap: the overlaid env var, else a row in platform_secrets (the
 * app pool can SELECT it). Used to gate the client button and reject a transcribe early.
 */
export async function geminiConfigured(db, env = process.env) {
  if (env.GEMINI_API_KEY) return true;
  try {
    const r = await db.query("SELECT 1 FROM platform_secrets WHERE name = 'gemini.api_key'");
    return r.rows.length > 0;
  } catch { return false; }
}

/** Resolve the actual key: a value set in HQ wins, else the server env var. */
export async function resolveGeminiKey(db, sealer, env = process.env) {
  try {
    const map = await loadPlatformSecretsMap(db, sealer);
    if (map['gemini.api_key']) return map['gemini.api_key'];
  } catch { /* fall back to env */ }
  return env.GEMINI_API_KEY || '';
}

/** Pull the text out of a generateContent response (joins the candidate's text parts). */
export function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('').trim();
}

/**
 * Transcribe one inline audio clip. Throws an Error with a safe message on any API failure.
 * @param {{ apiKey:string, model:string, apiBase:string, audioBase64:string, mimeType:string,
 *           prompt?:string, timeoutMs?:number, fetchImpl?:typeof fetch }} o
 * @returns {Promise<string>}
 */
export async function transcribeAudio({ apiKey, model, apiBase, audioBase64, mimeType, prompt = TRANSCRIBE_PROMPT, timeoutMs = 120_000, fetchImpl = fetch }) {
  if (!apiKey) throw Object.assign(new Error('AI transcription is not configured.'), { code: 'not_configured' });
  const url = `${apiBase}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType, data: audioBase64 } }] }],
    generationConfig: { temperature: 0 },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(e?.name === 'AbortError' ? 'The transcription timed out.' : 'Could not reach the transcription service.');
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = data?.error?.message || `Transcription failed (${res.status}).`;
    // Never surface the key; the API echoes the request in some errors.
    throw new Error(String(msg).replace(apiKey, '[key]').slice(0, 300));
  }
  const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
  const text = extractText(data);
  if (!text && blocked && blocked !== 'STOP') throw new Error(`The transcription was blocked (${blocked}).`);
  return text;
}

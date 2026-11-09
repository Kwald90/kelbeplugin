// Google Gemini as an alternative chat provider for the in-app assistant. Where client.js
// wraps Anthropic's SDK, this file drives Gemini's REST API (services/gemini.js has the key
// plumbing and settings) and maps between our internal, Anthropic-shaped message history and
// Gemini's `contents`/`tools` shape, both ways.
//
// Non-streaming: one POST per model turn (:generateContent). chat.js re-emits the result
// through the same server-sent-event channel the Anthropic path uses, so the PWA chat UI
// renders it unchanged (text arrives as one delta; tool chips and drafts are identical).
//
// The tools are the SAME tool objects chat.js runs for Anthropic; only their JSON-Schema is
// re-shaped into Gemini functionDeclarations here. An injectable fetch (setGeminiFetch) keeps
// tests off the real API; never log the key, the prompt or the response body.
import { ApiError } from '../errors.js';

let fetchImpl = (...a) => globalThis.fetch(...a);

/** Test seam: replace the fetch used for Gemini calls (pass null to restore the real one). */
export function setGeminiFetch(fn) {
  fetchImpl = fn || ((...a) => globalThis.fetch(...a));
}

/** No Gemini key configured (HQ → Platform keys, or GEMINI_API_KEY). */
export function geminiNotConnected() {
  return new ApiError(409, 'ai_not_connected',
    'This company is set to run the assistant on Google Gemini, but no Gemini API key is configured. Set one in HQ → Platform keys.',
    { integration: 'gemini', guide: 'gemini' });
}

const PROVIDERS = ['anthropic', 'gemini'];

/**
 * Which provider answers a turn. Preference comes from settings.ai.provider
 * ('auto' | 'anthropic' | 'gemini'); 'auto' keeps Anthropic when its key is set, else uses
 * Gemini when a Gemini key is available, else falls back to Anthropic (so the familiar
 * "connect Anthropic" error still shows when nothing is configured).
 */
export function chooseProvider(pref, hasAnthropic, hasGemini) {
  if (PROVIDERS.includes(pref)) return pref;
  if (hasAnthropic) return 'anthropic';
  if (hasGemini) return 'gemini';
  return 'anthropic';
}

// ---- schema + message mapping ------------------------------------------------

const TYPE = { string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', object: 'OBJECT', array: 'ARRAY' };

/**
 * Our JSON Schema -> Gemini's OpenAPI-subset Schema. Gemini rejects keywords it does not
 * know (additionalProperties, $schema, default, min/maxLength, eager flags), so keep only the
 * structural ones; our own validate.js still checks inputs against the full schema before a
 * tool runs, so nothing is lost.
 */
export function geminiSchema(s) {
  if (!s || typeof s !== 'object') return undefined;
  const out = {};
  const type = s.type && TYPE[s.type] ? TYPE[s.type] : undefined;
  let description = s.description ? String(s.description) : '';
  // Gemini allows `enum` ONLY on a STRING type. A string (or untyped) enum stays an enum; an enum on
  // an integer/number/boolean (e.g. the CEC tools' terminationC [60,75,90]) would make Gemini reject
  // the whole tool with a 400 — so keep the numeric type and fold the allowed values into the
  // description instead, so the model still picks a valid one.
  if (Array.isArray(s.enum) && s.enum.length) {
    if (!s.type || s.type === 'string') {
      out.type = TYPE.string;
      out.enum = s.enum.map(String);
    } else {
      if (type) out.type = type;
      description = `${description}${description ? ' ' : ''}Allowed values: ${s.enum.join(', ')}.`.trim();
    }
  } else if (type) {
    out.type = type;
  }
  if (description) out.description = description;
  if (s.type === 'object' && s.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(s.properties)) out.properties[k] = geminiSchema(v);
    if (Array.isArray(s.required) && s.required.length) out.required = [...s.required];
  }
  if (s.type === 'array' && s.items) out.items = geminiSchema(s.items);
  return out;
}

/** Our apiTools() list -> Gemini `tools` (a single functionDeclarations group), or undefined. */
export function toGeminiTools(apiTools) {
  if (!apiTools?.length) return undefined;
  return [{
    functionDeclarations: apiTools.map((t) => {
      const decl = { name: t.name, description: t.description };
      const params = geminiSchema(t.input_schema);
      // A declaration with no properties must omit `parameters` entirely.
      if (params && params.properties && Object.keys(params.properties).length) decl.parameters = params;
      return decl;
    }),
  }];
}

/**
 * Internal history (append-only Anthropic-shaped blocks, as stored in ai_messages) -> Gemini
 * `contents`. Assistant role becomes 'model'; tool_use -> functionCall; tool_result ->
 * functionResponse (Gemini keys these by function name, so map the id back via the tool_use
 * that produced it); images -> inlineData; thinking blocks are dropped (Gemini has no slot).
 * @param {{ role: 'user'|'assistant', content: any[] }[]} messages
 */
export function toGeminiContents(messages) {
  const nameById = new Map();
  const contents = [];
  for (const m of messages || []) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b.type === 'image' && b.source?.type === 'base64') parts.push({ inlineData: { mimeType: b.source.media_type, data: b.source.data } });
      else if (b.type === 'tool_use') { nameById.set(b.id, b.name); parts.push({ functionCall: { name: b.name, args: b.input || {} } }); }
      else if (b.type === 'tool_result') {
        const name = nameById.get(b.tool_use_id) || String(b.tool_use_id || 'tool');
        let response;
        try { response = JSON.parse(b.content); } catch { response = { result: String(b.content ?? '') }; }
        if (response === null || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
        if (b.is_error) response = { error: response };
        parts.push({ functionResponse: { name, response } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

/** Gemini candidate parts -> internal assistant content blocks (text, tool_use). */
export function partsToBlocks(parts, nextId) {
  const blocks = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    if (typeof p.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text });
    else if (p.functionCall?.name) blocks.push({ type: 'tool_use', id: nextId(), name: p.functionCall.name, input: p.functionCall.args || {} });
  }
  return blocks;
}

// ---- the call ----------------------------------------------------------------

/**
 * Gemini HTTP errors -> ApiError a person can act on. Never includes the key, the prompt or
 * the upstream body (Gemini echoes request fragments in some messages). Parallels
 * client.js upstreamError.
 */
export function geminiUpstreamError(status) {
  if (status === 401 || status === 403) {
    return new ApiError(409, 'ai_key_rejected', 'Google rejected the Gemini API key. Check it in HQ → Platform keys.', { integration: 'gemini', guide: 'gemini' });
  }
  if (status === 429) return new ApiError(429, 'ai_rate_limited', 'Gemini is rate limiting the key. Try again in a minute.');
  if (status === 400) return new ApiError(502, 'ai_bad_request', 'The AI service refused the request. Try again or start a new conversation.');
  if (status >= 500) return new ApiError(503, 'ai_unavailable', 'Gemini is busy right now. Try again shortly.');
  return new ApiError(502, 'ai_error', 'The AI service returned an error. Try again.');
}

/** A network failure or timeout reaching Gemini -> ApiError (no key or body in the message). */
export function geminiNetworkError(e) {
  if (e instanceof ApiError) return e;
  if (e?.name === 'AbortError') return new ApiError(503, 'ai_unavailable', 'The AI request timed out. Try again shortly.');
  return new ApiError(503, 'ai_unavailable', 'Could not reach Gemini. Try again shortly.');
}

/**
 * One Gemini model turn (non-streaming). Returns the candidate's parts, finish reason, model
 * and a usage block already shaped like the Anthropic one ({ input_tokens, output_tokens })
 * so recordUsage logs it the same way. Throws an ApiError on any failure.
 * @param {{ apiKey: string, settings: { model: string, apiBase: string }, systemText?: string,
 *           contents: any[], tools?: any[], generationConfig?: object,
 *           signal?: AbortSignal, timeoutMs?: number }} o
 */
export async function geminiGenerate({ apiKey, settings, systemText, contents, tools, generationConfig, signal, timeoutMs = 120_000 }) {
  if (!apiKey) throw geminiNotConnected();
  const url = `${settings.apiBase}/models/${encodeURIComponent(settings.model)}:generateContent`;
  const body = { contents };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (tools) body.tools = tools;
  if (generationConfig) body.generationConfig = generationConfig;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) { if (signal.aborted) ctrl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (signal?.aborted) throw new ApiError(499, 'ai_cancelled', 'The request was cancelled.');
    throw geminiNetworkError(e);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) throw geminiUpstreamError(res.status);
  const cand = data?.candidates?.[0];
  const u = data?.usageMetadata || {};
  return {
    parts: cand?.content?.parts || [],
    finishReason: String(cand?.finishReason || '').toUpperCase(),
    blockReason: data?.promptFeedback?.blockReason || null,
    model: settings.model,
    usage: { input_tokens: u.promptTokenCount || 0, output_tokens: u.candidatesTokenCount || 0 },
  };
}

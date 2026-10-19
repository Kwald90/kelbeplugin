// Talks to the AI endpoints (/api/v1/ai/*): JSON calls, the streamed chat reply
// (server-sent events over fetch, since EventSource can't POST), photo downsizing and a
// small, safe Markdown-ish renderer for replies (DOM text nodes only, never innerHTML).
//
// Where the API lives and how requests are signed in: js/session.js apiFetch (same origin with the
// session cookie on the web; the API origin and the Keychain bearer token in the iOS app).
// configureAssistantApi({ base, headers }) overrides both, e.g. to point a test at another server.
import { apiFetch } from '../session.js';

const cfg = { base: null, headers: null };

export function configureAssistantApi({ base, headers } = {}) {
  if (base !== undefined) cfg.base = base;
  if (headers !== undefined) cfg.headers = headers;
}

function authHeaders() {
  const h = typeof cfg.headers === 'function' ? cfg.headers() : cfg.headers;
  return h || {};
}

export class ApiFailure extends Error {
  constructor(status, error = {}) {
    super(error.message || (status === 0 ? 'Could not reach the Fishtape server.' : 'Something went wrong.'));
    this.status = status;
    this.code = error.code || (status === 0 ? 'offline' : 'error');
    this.details = error.details || null;
  }
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = { accept: 'application/json', 'x-fishtape': '1', ...authHeaders() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const init = { method, credentials: 'include', cache: 'no-store', headers, body: body === undefined ? undefined : JSON.stringify(body), signal };
  try {
    return await (cfg.base != null ? fetch(cfg.base + path, init) : apiFetch(path, init));
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiFailure(0);
  }
}

async function failure(res) {
  let err = {};
  try { err = (await res.json()).error || {}; } catch { /* not JSON */ }
  return new ApiFailure(res.status, err);
}

/** JSON call: api('/api/v1/ai/status'), api(path, { method: 'POST', body }). */
export async function api(path, opts = {}) {
  const res = await request(path, opts);
  if (!res.ok) throw await failure(res);
  if (res.status === 204) return null;
  return res.json();
}

/**
 * Send a chat message and read the streamed reply. onEvent(event, data) gets start,
 * text_start, text, progress, tool, draft, notice, error and done.
 */
export async function streamMessage(conversationId, body, onEvent, signal) {
  const res = await request(`/api/v1/ai/conversations/${encodeURIComponent(conversationId)}/messages`, { method: 'POST', body, signal });
  if (!res.ok) throw await failure(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev) { try { onEvent(ev, data ? JSON.parse(data) : null); } catch (e) { console.error(e); } }
    }
  }
}

/** Downsize a photo to at most `max` px on the long edge, as base64 JPEG. */
export function photoForUpload(file, max = 1568) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * k);
      c.height = Math.round(img.naturalHeight * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      resolve({ mediaType: 'image/jpeg', data: dataUrl.slice(dataUrl.indexOf(',') + 1), preview: dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a photo we can read.')); };
    img.src = url;
  });
}

/** Inline **bold** and `code` as DOM nodes. */
function inline(text) {
  const frag = document.createDocumentFragment();
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.append(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    const el = document.createElement(tok.startsWith('**') ? 'strong' : 'code');
    el.textContent = tok.startsWith('**') ? tok.slice(2, -2) : tok.slice(1, -1);
    frag.append(el);
    last = m.index + tok.length;
  }
  if (last < text.length) frag.append(document.createTextNode(text.slice(last)));
  return frag;
}

/** Paragraphs, "-" / "1." lists, **bold** and `code`. Everything else is plain text. */
export function renderReply(text) {
  const root = document.createElement('div');
  root.className = 'ai-md';
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) { list = document.createElement(/^\s*\d/.test(line) ? 'ol' : 'ul'); root.append(list); }
      const li = document.createElement('li');
      li.append(inline(bullet[1]));
      list.append(li);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const p = document.createElement('p');
    p.append(inline(line.replace(/^#{1,6}\s+/, '')));
    root.append(p);
  }
  return root;
}

/**
 * Ask the sync layer (js/sync.js, exposed as globalThis.kelbe.sync) to run now, so a
 * document the server just wrote shows up on this device. Resolves when it is done.
 */
export async function requestSync() {
  try { await globalThis.kelbe?.sync?.syncNow?.(); } catch { /* offline: the next cycle brings it */ }
}

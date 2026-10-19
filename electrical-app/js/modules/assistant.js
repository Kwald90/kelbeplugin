// Assistant (#/assistant): chat with the Fishtape assistant and the CEC helper, review
// drafts it proposes, approve background suggestions, connect outside agents (MCP), and
// the company's AI cap. Also adds an "Ask Fishtape" button on estimates, invoices and jobs.
// Everything goes through the server with the company's own Anthropic key; the AI only
// drafts, and a person accepts, approves or discards here.
import { api, ApiFailure, photoForUpload, renderReply, requestSync, streamMessage } from '../lib/assistant-api.js';
import { formatMoney } from '../lib/money.js';
import { getUnits } from '../lib/units.js';
import * as kit from '../ui.js';

const SPARK = '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>';
const TABS = [
  { id: 'chat', label: 'Assistant' },
  { id: 'cec', label: 'CEC helper' },
  { id: 'drafts', label: 'Drafts' },
  { id: 'suggestions', label: 'Suggestions' },
  { id: 'agents', label: 'Connect agents' },
];
const money = (c) => formatMoney(c);
const usd = (cents) => `US$${((Number(cents) || 0) / 100).toFixed(2)}`;
const SOURCE = {
  price_book: ['Price book', 'success'], labour_rate: ['Labour rate', 'info'], ai_estimate: ['Check price', 'warning'], unpriced: ['No price', 'danger'],
  estimate: ['Estimate', 'info'], time_entries: ['Approved time', 'info'], stock_moves: ['Materials used', 'info'], change_order: ['Change order', 'accent'],
};

export default {
  id: 'assistant',
  title: 'Assistant',
  icon: SPARK,
  group: 'home',
  perm: 'dashboard',
  render(root, ctx) {
    const { ui } = ctx;
    const tab = TABS.some((x) => x.id === ctx.params[0]) ? ctx.params[0] : 'chat';
    const body = ui.h('div', { class: 'stack' });
    const statusHost = ui.h('div', { class: 'ai-status' });
    root.append(ui.page({
      title: 'Assistant',
      subtitle: 'Drafts estimates and invoices, answers CEC questions with the calculators, and flags follow-ups. You review and approve everything.',
    }, statusHost, ui.tabs(TABS, tab, (id) => ctx.nav(`#/assistant/${id}`)), body));
    let cleanup = null;
    loadStatus().then((status) => {
      statusHost.append(statusBar(ui, status));
      if (tab === 'chat' || tab === 'cec') {
        const panel = chatPanel(ui, { mode: tab === 'cec' ? 'cec' : 'assistant', status, nav: ctx.nav });
        cleanup = panel.cleanup;
        body.append(panel.el);
      } else if (tab === 'drafts') body.append(draftsTab(ui, ctx));
      else if (tab === 'suggestions') body.append(suggestionsTab(ui, ctx, status));
      else body.append(agentsTab(ui, ctx, status));
    });
    return () => cleanup?.();
  },
};

// ---------- status ----------

let statusCache = null;
async function loadStatus(force = false) {
  if (!force && statusCache && Date.now() - statusCache.at < 60_000) return statusCache.value;
  let value;
  try { value = { ok: true, ...(await api('/api/v1/ai/status')) }; } catch (e) { value = { ok: false, error: e instanceof ApiFailure ? e : new ApiFailure(0) }; }
  statusCache = { at: Date.now(), value };
  return value;
}

function problemFor(status, mode = 'assistant') {
  if (!status.ok) {
    const e = status.error;
    if (e.status === 0) return { title: 'Can\'t reach the Fishtape server', text: 'The assistant needs a connection. Field tools keep working offline.' };
    if (e.status === 401) return { title: 'Sign in to use the assistant', text: 'The assistant works with your company account on the Fishtape server.' };
    if (e.code === 'mfa_required' || e.code === 'mfa_enrolment_required') return { title: 'Finish two-step sign-in', text: e.message };
    return { title: 'The assistant is not available', text: e.message };
  }
  const feature = mode === 'cec' ? status.features.cec : status.features.assistant;
  if (!feature) return { title: 'Part of the Business plan', text: 'The assistant, CEC helper and background agents come with Business. An owner can upgrade from Settings.', lock: true };
  if (!status.connected) return { title: 'Connect Anthropic in Integrations', text: 'Fishtape\'s AI runs on your company\'s own Anthropic API key, so your data and your bill stay yours. An owner or admin adds the key once in Integrations.', connect: true };
  if (status.cap?.reached) return { title: 'Monthly AI cap reached', text: `This month's estimated spend reached the ${usd(status.cap.monthlyCapCents)} cap. An owner or admin can raise it under Connect agents.` };
  return null;
}

function problemCard(ui, p) {
  return ui.h('div', { class: ['card', 'ai-problem'] },
    ui.h('div', { class: 'row' }, ui.icon(p.lock ? 'lock' : p.connect ? 'key' : 'info', 20), ui.h('strong', null, p.title)),
    ui.h('p', { class: 'muted' }, p.text),
    p.connect ? ui.h('div', { class: 'row' }, ui.button('Open Integrations', { variant: 'primary', icon: 'link', href: '#/integrations' })) : null);
}

function statusBar(ui, status) {
  if (!status.ok) return ui.h('span');
  const u = status.usage;
  return ui.h('div', { class: 'row ai-status-row muted' },
    ui.badge(status.connected ? 'Anthropic connected' : 'Anthropic not connected', status.connected ? 'success' : 'warning'),
    ui.h('span', null, `This month: ${u.calls} call${u.calls === 1 ? '' : 's'}, about ${usd(u.costCents)} of ${usd(status.cap.monthlyCapCents)} cap`));
}

// ---------- chat ----------

const convKey = (mode, screen) => `ft.ai.conv.${mode}${screen ? `.${screen.collection}.${screen.id}` : ''}`;
const remember = (k, v) => { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch { /* ignore */ } };
const recall = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };

/**
 * The chat surface, used on #/assistant and in the "Ask Fishtape" sheet.
 * @returns {{ el: HTMLElement, cleanup: () => void }}
 */
export function chatPanel(ui, { mode = 'assistant', status, screen = null, nav }) {
  const { h } = ui;
  const el = h('div', { class: ['ai-chat', mode === 'cec' ? 'cec' : null] });
  const log = h('div', { class: 'ai-log', 'aria-live': 'polite' });
  let convId = recall(convKey(mode, screen));
  let busy = null;
  let photos = [];

  const problem = problemFor(status, mode);
  if (problem) { el.append(problemCard(ui, problem)); return { el, cleanup: () => {} }; }

  const input = h('textarea', {
    class: 'ai-input', rows: 2, placeholder: mode === 'cec' ? 'Ask a code question, e.g. "Voltage drop on 45 m of 10 AWG at 24 A, 240 V?"' : (screen ? 'Ask about this, e.g. "Add a dedicated 20 A circuit for the fridge"' : 'e.g. "Draft an estimate for 12 pot lights and 3 switches for the Smith job"'),
    'aria-label': 'Message',
    onKeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } },
  });
  const thumbs = h('div', { class: 'ai-thumbs' });
  const sendBtn = ui.button('Send', { variant: 'primary', icon: 'send', onClick: () => send() });
  const stopBtn = ui.button('Stop', { variant: 'ghost', icon: 'stop', onClick: () => busy?.abort() });
  stopBtn.hidden = true;
  const photoBtn = ui.button('', { variant: 'ghost', icon: 'image', title: 'Attach a photo', onClick: pickPhoto });
  const newBtn = ui.button('New chat', { size: 'sm', variant: 'ghost', icon: 'plus', onClick: () => { convId = null; remember(convKey(mode, screen), null); ui.clear(log); intro(); } });

  el.append(
    h('div', { class: 'row ai-chat-head' }, h('span', { class: 'muted ai-mode' }, mode === 'cec' ? 'CEC 2024 helper: answers cite rule and table numbers. Advisory; check with your inspector.' : 'Drafts are reviewed by you before anything changes.'), h('span', { class: 'grow' }), newBtn),
    log,
    h('div', { class: 'ai-composer' }, thumbs, h('div', { class: 'row ai-compose-row' }, photoBtn, input, stopBtn, sendBtn)));

  function intro() {
    log.append(h('div', { class: 'ai-empty muted' }, mode === 'cec'
      ? 'Ask about ampacity, conductor size, voltage drop, conduit or box fill, a dwelling service load or a motor circuit. Answers come from Fishtape\'s CEC calculators, in your units.'
      : 'Ask for an estimate from your price book, an invoice for a job, or a quick look-up. You can attach a photo of a panel or a sketch.'));
  }

  async function pickPhoto() {
    if (photos.length >= 3) return ui.toast('Up to 3 photos per message', 'error');
    const file = await ui.pickFile('image/*');
    if (!file) return;
    try {
      const p = await photoForUpload(file);
      photos.push(p);
      drawThumbs();
    } catch (e) { ui.toast(e.message, 'error'); }
  }
  function drawThumbs() {
    ui.clear(thumbs);
    photos.forEach((p, i) => thumbs.append(h('span', { class: 'ai-thumb' }, h('img', { src: p.preview, alt: 'Attached photo' }),
      h('button', { type: 'button', class: 'ai-thumb-x', 'aria-label': 'Remove photo', onClick: () => { photos.splice(i, 1); drawThumbs(); } }, '×'))));
  }

  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function userBubble(text, images) {
    log.querySelector('.ai-empty')?.remove();
    log.append(h('div', { class: 'ai-msg user' }, images ? h('div', { class: 'muted ai-attached' }, `${images} photo${images > 1 ? 's' : ''} attached`) : null, text ? h('div', null, text) : null));
  }

  /** An assistant bubble that grows as events arrive. */
  function assistantBubble() {
    const bubble = h('div', { class: 'ai-msg assistant' });
    log.append(bubble);
    let textEl = null, raw = '';
    const tools = new Map();
    return {
      textStart() { textEl = null; raw = ''; },
      text(delta) {
        if (!textEl) { textEl = h('div', { class: 'ai-text' }); bubble.append(textEl); raw = ''; }
        raw += delta;
        textEl.replaceChildren(renderReply(raw));
      },
      progress(delta) {
        let p = bubble.lastElementChild;
        if (!p || !p.classList.contains('ai-progress')) { p = h('div', { class: 'ai-progress muted' }); bubble.append(p); textEl = null; }
        p.textContent += delta;
      },
      tool({ id, label, status }) {
        let chip = tools.get(id);
        if (!chip) { chip = h('div', { class: 'ai-tool' }); tools.set(id, chip); bubble.append(chip); textEl = null; }
        chip.dataset.status = status;
        chip.replaceChildren(ui.icon(status === 'done' ? 'check' : status === 'error' ? 'alert' : 'activity', 14), h('span', null, label || 'Working'));
      },
      draft(d) { bubble.append(draftCard(ui, d, { nav })); textEl = null; },
      note(text, tone = 'muted') { bubble.append(h('div', { class: ['ai-note', tone] }, text)); textEl = null; },
      el: bubble,
    };
  }

  async function ensureConversation() {
    if (convId) return convId;
    const c = await api('/api/v1/ai/conversations', { method: 'POST', body: { mode, units: getUnits('metric'), ...(screen ? { screen } : {}) } });
    convId = c.id;
    remember(convKey(mode, screen), convId);
    return convId;
  }

  async function send() {
    const text = input.value.trim();
    if (busy || (!text && !photos.length)) return;
    const images = photos.map(({ mediaType, data }) => ({ mediaType, data }));
    userBubble(text, images.length);
    input.value = '';
    photos = []; drawThumbs();
    const b = assistantBubble();
    b.el.classList.add('pending');
    busy = new AbortController();
    sendBtn.disabled = true; stopBtn.hidden = false;
    scroll();
    try {
      const id = await ensureConversation();
      await streamMessage(id, { text, ...(images.length ? { images } : {}) }, (ev, data) => {
        b.el.classList.remove('pending');
        if (ev === 'text_start') b.textStart();
        else if (ev === 'text') b.text(data.delta);
        else if (ev === 'progress') b.progress(data.delta);
        else if (ev === 'tool') b.tool(data);
        else if (ev === 'draft') b.draft(data);
        else if (ev === 'notice') b.note(data.message);
        else if (ev === 'error') b.note(data.message, 'danger');
        scroll();
      }, busy.signal);
    } catch (e) {
      b.el.classList.remove('pending');
      if (e?.name === 'AbortError') b.note('Stopped.');
      else if (e instanceof ApiFailure && e.status === 404 && convId) { convId = null; remember(convKey(mode, screen), null); b.note('That conversation has ended. Send your message again to start a new one.', 'danger'); }
      else b.note(e.message || 'Something went wrong.', 'danger');
    } finally {
      busy = null; sendBtn.disabled = false; stopBtn.hidden = true;
      statusCache = null;
      scroll();
      input.focus();
    }
  }

  async function restore() {
    if (!convId) return intro();
    try {
      const c = await api(`/api/v1/ai/conversations/${encodeURIComponent(convId)}`);
      const drafts = new Map((c.drafts || []).map((d) => [d.id, d]));
      if (!c.messages.length) intro();
      for (const m of c.messages) {
        if (m.role === 'user') { userBubble(m.text, m.images); continue; }
        const b = assistantBubble();
        for (const part of m.parts) {
          if (part.type === 'text') { b.textStart(); b.text(part.text); } else if (part.type === 'progress') b.progress(part.text);
          else if (part.type === 'tool') { const s = m.tools.find((x) => x.id === part.id); if (s) b.tool(s); }
        }
      }
      for (const d of drafts.values()) log.append(draftCard(ui, d, { nav }));
      scroll();
    } catch {
      convId = null; remember(convKey(mode, screen), null); intro();
    }
  }
  restore();
  return { el, cleanup: () => busy?.abort() };
}

// ---------- drafts ----------

/** A reviewable diff of a proposed estimate or invoice, with Accept / Discard. */
export function draftCard(ui, d, { nav, onDecided } = {}) {
  const { h } = ui;
  const p = d.proposal || {};
  const card = h('div', { class: ['card', 'ai-draft'], dataset: { draft: d.id } });
  const kind = d.kind === 'invoice' ? 'Invoice' : 'Estimate';
  const acceptLabel = d.kind === 'invoice' ? 'Create draft invoice' : p.mode === 'append' ? `Add ${p.lines?.length || 0} line${p.lines?.length === 1 ? '' : 's'} to ${p.number || 'the estimate'}` : 'Create draft estimate';
  const rows = (p.lines || []).map((l) => {
    const [label, tone] = SOURCE[l.source] || ['', 'neutral'];
    return h('tr', null,
      h('td', null, l.description, l.kind === 'labour' ? h('span', { class: 'muted' }, ' (labour)') : null),
      h('td', { class: 'right num' }, String(l.qty)),
      h('td', { class: 'right num' }, money(l.unitCents)),
      h('td', { class: 'right num' }, money(Math.round(l.qty * l.unitCents))),
      h('td', null, label ? ui.badge(label, tone) : null));
  });
  const t = p.after || {};
  const totals = h('div', { class: 'ai-totals' },
    p.before ? h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Total now'), h('span', { class: 'grow' }), h('span', { class: 'num' }, money(p.before.totalCents))) : null,
    h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Subtotal'), h('span', { class: 'grow' }), h('span', { class: 'num' }, money(t.subtotalCents))),
    ...(t.taxes || []).filter((x) => x.cents || x.note).map((x) => h('div', { class: 'row' }, h('span', { class: 'muted' }, `${x.label} ${x.pct}%${x.note ? ` (${x.note})` : ''}`), h('span', { class: 'grow' }), h('span', { class: 'num' }, money(x.cents)))),
    h('div', { class: 'row ai-total' }, h('strong', null, p.before ? 'Total after' : 'Total'), h('span', { class: 'grow' }), h('strong', { class: 'num' }, money(t.totalCents))));
  const statusEl = h('div', { class: 'row ai-draft-actions' });
  const draw = (state, recordId) => {
    ui.clear(statusEl);
    if (state === 'proposed') {
      h(statusEl, null,
        ui.button('Discard', { variant: 'ghost', size: 'sm', onClick: () => decide('discard') }),
        h('span', { class: 'grow' }),
        ui.button(acceptLabel, { variant: 'primary', size: 'sm', icon: 'check', onClick: () => decide('accept') }));
    } else {
      h(statusEl, null, ui.statusBadge(state === 'accepted' ? 'accepted' : 'declined'), h('span', { class: 'muted' }, state === 'accepted' ? ' Saved as a draft document.' : ' Discarded.'), h('span', { class: 'grow' }),
        state === 'accepted' && recordId ? ui.button(`Open ${kind.toLowerCase()}`, { size: 'sm', icon: d.kind === 'invoice' ? 'receipt' : 'file-text', onClick: () => openRecord(ui, nav, d.kind === 'invoice' ? 'invoices' : 'estimates', recordId) }) : null);
    }
  };
  async function decide(action) {
    try {
      const r = await api(`/api/v1/ai/drafts/${d.id}/${action}`, { method: 'POST' });
      const rec = r.record || null;
      draw(action === 'accept' ? 'accepted' : 'discarded', rec?.id || r.draft?.resultId);
      if (action === 'accept') { requestSync(); ui.toast(`${kind} ${rec?.number || ''} saved as a draft`.replace('  ', ' '), 'success'); }
      onDecided?.(action);
    } catch (e) {
      ui.toast(e.code === 'version_conflict' ? 'The estimate changed since this was drafted. Ask the assistant to draft it again.' : e.message, 'error', 4000);
    }
  }
  draw(d.status, d.resultId);
  h(card, null,
    h('div', { class: 'row' }, ui.icon(d.kind === 'invoice' ? 'receipt' : 'file-text', 18), h('strong', null, `${kind} draft`), h('span', { class: 'grow' }), p.tax?.description ? h('span', { class: 'muted ai-tax' }, `${p.tax.description}${p.tax.provinceName ? `, ${p.tax.provinceName}` : ''}`) : null),
    h('p', { class: 'ai-summary' }, d.summary),
    (p.warnings || []).length ? h('ul', { class: 'ai-warnings' }, p.warnings.map((w) => h('li', null, w))) : null,
    h('div', { class: 'table-wrap' }, h('table', { class: 'table ai-lines' },
      h('thead', null, h('tr', null, h('th', null, p.mode === 'append' ? 'Lines to add' : 'Lines'), h('th', { class: 'right' }, 'Qty'), h('th', { class: 'right' }, 'Unit'), h('th', { class: 'right' }, 'Amount'), h('th', null, 'From'))),
      h('tbody', null, rows))),
    totals, statusEl);
  return card;
}

/** Go to a document; if sync has not brought it to this device yet, sync first. */
async function openRecord(ui, nav, coll, id) {
  const store = globalThis.kelbe?.store;
  if (!store || store.get(coll, id)) return nav(`#/${coll}/${id}`);
  ui.toast('Fetching it from the server…');
  await requestSync();
  if (store.get(coll, id)) nav(`#/${coll}/${id}`);
  else ui.toast('It is saved on the server and will appear after the next sync.', 'info', 4000);
}

function draftsTab(ui, ctx) {
  const { h } = ui;
  const host = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading drafts…'));
  api('/api/v1/ai/drafts?status=proposed').then(({ data }) => {
    ui.clear(host);
    if (!data.length) return host.append(ui.empty({ icon: 'file-text', title: 'No drafts waiting', text: 'Estimates and invoices the assistant or a connected agent proposes wait here for you.' }));
    for (const d of data) host.append(draftCard(ui, d, { nav: ctx.nav }));
  }).catch((e) => { ui.clear(host); host.append(problemCard(ui, { title: 'Could not load drafts', text: e.message })); });
  return host;
}

// ---------- suggestions ----------

const KIND_ICON = { overdue_invoice: 'receipt', permit_expiry: 'shield-check', certification_expiry: 'id-card', licence_expiry: 'id-card', low_stock: 'box', unapproved_time: 'clock' };

function suggestionsTab(ui, ctx, status) {
  const { h } = ui;
  const host = h('div', { class: 'stack' });
  const list = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading…'));
  const manager = ctx.auth?.isManager?.() ?? true;
  const head = h('div', { class: 'row' },
    h('p', { class: 'muted ai-p' }, 'Every day Fishtape checks for overdue invoices, permits and certifications expiring within 30 days, stock below its reorder point and time waiting more than a week for approval. Each finding becomes a draft here; nothing is sent until you approve it.'),
    h('span', { class: 'grow' }),
    manager && status.ok && status.features.background ? ui.button('Run checks now', { size: 'sm', icon: 'activity', onClick: runNow }) : null);
  host.append(head, list);
  if (status.ok && !status.features.background) { ui.clear(list); list.append(problemCard(ui, problemFor({ ...status, features: { assistant: false } }))); return host; }

  async function runNow() {
    try {
      const r = await api('/api/v1/ai/background/run', { method: 'POST' });
      ui.toast(r.skipped ? `Skipped: ${r.skipped}` : `${r.created} new suggestion${r.created === 1 ? '' : 's'}`, 'success');
      load();
    } catch (e) { ui.toast(e.message, 'error'); }
  }

  function item(s) {
    const m = s.message;
    const subject = m && m.channel !== 'task' ? h('input', { class: 'input', value: m.subject || '', 'aria-label': 'Subject' }) : null;
    const body = m && m.channel !== 'task' ? h('textarea', { class: 'input', rows: 6, 'aria-label': 'Message' }, m.body || '') : null;
    const approveLabel = !m ? 'Done' : m.channel === 'email' ? 'Approve and queue email' : m.channel === 'sms' ? 'Approve and queue text' : 'Add to outbox tasks';
    const card = h('div', { class: ['card', 'ai-suggestion'] },
      h('div', { class: 'row' }, ui.icon(KIND_ICON[s.kind] || 'info', 18), h('strong', null, s.title), h('span', { class: 'grow' }), s.draftedBy === 'ai' ? ui.badge('Worded by AI', 'accent') : null),
      s.detail ? h('p', { class: 'muted ai-p' }, s.detail) : null,
      m && m.channel !== 'task' ? h('div', { class: 'stack ai-message' }, h('div', { class: 'muted' }, `${m.channel === 'email' ? 'Email' : 'Text'} to ${m.to || '(no address)'}`), subject, body) : null,
      manager ? h('div', { class: 'row' },
        ui.button('Dismiss', { size: 'sm', variant: 'ghost', onClick: () => act('dismiss') }),
        h('span', { class: 'grow' }),
        s.related ? ui.button('Open', { size: 'sm', variant: 'ghost', href: s.kind === 'unapproved_time' ? '#/time' : relatedHref(s.related) }) : null,
        ui.button(approveLabel, { size: 'sm', variant: 'primary', icon: 'check', onClick: () => act('approve') })) : h('p', { class: 'muted' }, 'A manager approves or dismisses this.'));
    async function act(action) {
      try {
        const payload = action === 'approve' && subject ? { subject: subject.value, body: body.value } : {};
        await api(`/api/v1/ai/suggestions/${s.id}/${action}`, { method: 'POST', body: payload });
        if (action === 'approve') requestSync();
        ui.toast(action === 'approve' ? 'Approved and queued' : 'Dismissed', 'success');
        card.remove();
      } catch (e) { ui.toast(e.message, 'error'); }
    }
    return card;
  }

  async function load() {
    try {
      const { data } = await api('/api/v1/ai/suggestions?status=open');
      ui.clear(list);
      if (!data.length) list.append(ui.empty({ icon: 'check', title: 'Nothing needs attention', text: 'New findings show up here after the daily check.' }));
      for (const s of data) list.append(item(s));
    } catch (e) { ui.clear(list); list.append(problemCard(ui, { title: 'Could not load suggestions', text: e.message })); }
  }
  load();
  return host;
}

function relatedHref(r) {
  const route = { invoices: 'invoices', permits: 'compliance', certifications: 'compliance', employees: 'employees', items: 'inventory' }[r.collection];
  if (r.collection === 'invoices') return `#/invoices/${encodeURIComponent(r.id)}`;
  return `#/${route || 'dashboard'}`;
}

// ---------- connect agents (MCP) and AI settings ----------

function copyRow(ui, label, text) {
  const { h } = ui;
  return h('div', { class: 'ai-copy' }, h('div', { class: 'muted' }, label),
    h('div', { class: 'row' }, h('pre', { class: 'ai-pre' }, text),
      ui.button('', { size: 'sm', variant: 'ghost', icon: 'copy', title: `Copy ${label}`, onClick: async () => { try { await navigator.clipboard.writeText(text); ui.toast('Copied', 'success'); } catch { ui.toast('Copy failed: select and copy it instead', 'error'); } } })));
}

function agentsTab(ui, ctx, status) {
  const { h } = ui;
  const endpoint = `${location.origin}/api/mcp`;
  const host = h('div', { class: 'stack' });
  host.append(h('div', { class: 'card stack' },
    h('h3', null, 'Connect Claude or another AI agent (MCP)'),
    h('p', { class: 'muted ai-p' }, 'Outside agents can work with your company\'s data through Fishtape\'s MCP server: look up and update records, run the CEC calculators and draft estimates for you to approve here. They sign in with an API key, and the key\'s scopes decide what they can see and change. Agents can\'t delete records, record payments or send anything.'),
    status.ok && !status.features.mcp ? problemCard(ui, { title: 'Part of the Business plan', text: 'The MCP server comes with Business.', lock: true }) : null,
    h('ol', { class: 'ai-steps' },
      h('li', null, 'An owner or admin creates an API key (POST /api/v1/api-keys until the API keys screen lands). Give it only the scopes the agent needs, for example ', h('code', null, 'items:read'), ', ', h('code', null, 'clients:read'), ' and ', h('code', null, 'estimates:write'), '.'),
      h('li', null, 'Add the server to your agent with the key, as below. Keep the key secret: anyone with it can act for your company within its scopes.'),
      h('li', null, 'Drafts the agent proposes appear under Drafts; you accept or discard them.')),
    copyRow(ui, 'Server URL', endpoint),
    copyRow(ui, 'Claude Code', `claude mcp add --transport http fishtape ${endpoint} --header "Authorization: Bearer ft_live_YOUR_KEY"`),
    copyRow(ui, 'Claude Desktop (claude_desktop_config.json)', JSON.stringify({ mcpServers: { fishtape: { command: 'npx', args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${FISHTAPE_KEY}'], env: { FISHTAPE_KEY: 'Bearer ft_live_YOUR_KEY' } } } }, null, 2)),
    h('p', { class: 'muted ai-p' }, 'Other MCP clients: Streamable HTTP transport, POST only, header Authorization: Bearer <key>. Full guide: docs/ai/mcp.md.')));

  if (status.ok && status.canManage) host.append(settingsCard(ui, status));
  return host;
}

function settingsCard(ui, status) {
  const { h } = ui;
  const cap = h('input', { class: 'input', type: 'number', min: '0', step: '1', value: String(Math.round(status.cap.monthlyCapCents / 100)), 'aria-label': 'Monthly cap in US dollars' });
  const bg = h('input', { type: 'checkbox', checked: status.settings.backgroundEnabled });
  const bgAi = h('input', { type: 'checkbox', checked: status.settings.backgroundAiDrafts });
  const save = async () => {
    try {
      await api('/api/v1/ai/settings', { method: 'PUT', body: { monthlyCapCents: Math.max(0, Math.round(Number(cap.value) * 100) || 0), backgroundEnabled: bg.checked, backgroundAiDrafts: bgAi.checked } });
      statusCache = null;
      ui.toast('AI settings saved', 'success');
    } catch (e) { ui.toast(e.message, 'error'); }
  };
  return h('div', { class: 'card stack' },
    h('h3', null, 'AI spending and background checks'),
    h('p', { class: 'muted ai-p' }, `Calls use your company's Anthropic key and are billed by Anthropic in US dollars. Fishtape estimates the cost of each call and stops AI features for the rest of the month at your cap. This month so far: about ${usd(status.usage.costCents)} over ${status.usage.calls} calls.`),
    h('label', { class: 'field' }, h('span', null, 'Monthly cap (US$)'), cap),
    h('label', { class: 'field check' }, bg, h('span', null, 'Run the daily background checks')),
    h('label', { class: 'field check' }, bgAi, h('span', null, 'Let Claude word overdue-invoice reminders (counts toward the cap)')),
    h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save', { variant: 'primary', onClick: save })));
}

// ---------- "Ask Fishtape" on estimates, invoices and jobs ----------

const ASK_ROUTE = /^#\/(estimates|invoices|jobs)(?:\/([^/?]+))?/;
let askBtn = null;

function screenFromHash() {
  const m = ASK_ROUTE.exec(location.hash || '');
  if (!m) return null;
  const [, collection, id] = m;
  if (!id || id === 'new') return { collection, id: null };
  const rec = globalThis.kelbe?.store?.get?.(collection, decodeURIComponent(id));
  return { collection, id: decodeURIComponent(id), label: rec?.number || rec?.title || null };
}

async function updateAskButton() {
  const s = screenFromHash();
  if (!s) { if (askBtn) askBtn.hidden = true; return; }
  const status = await loadStatus();
  if (!status.ok || !status.features.assistant) { if (askBtn) askBtn.hidden = true; return; }
  if (!askBtn) {
    askBtn = kit.h('button', { type: 'button', class: 'ai-ask no-print', onClick: openAsk }, kit.icon(SPARK, 18), kit.h('span', null, 'Ask Fishtape'));
    document.body.append(askBtn);
  }
  askBtn.hidden = false;
}

async function openAsk() {
  const s = screenFromHash();
  const screen = s?.id ? { collection: s.collection, id: s.id, ...(s.label ? { label: String(s.label).slice(0, 60) } : {}) } : null;
  const status = await loadStatus();
  const nav = (path) => { location.hash = path; };
  const panel = chatPanel(kit, { mode: 'assistant', status, screen, nav });
  kit.openSheet({ title: screen?.label ? `Ask Fishtape about ${screen.label}` : 'Ask Fishtape', wide: true, body: panel.el, onClose: panel.cleanup });
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('hashchange', () => { updateAskButton(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => updateAskButton()); else setTimeout(updateAskButton, 0);
}

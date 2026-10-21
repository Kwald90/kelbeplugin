// Field tickets (docs/releases/r1-get-paid.md 4.1; docs/field/tickets.md): signed extra-work and T&M
// tickets taken on the phone, offline, with no money on them.
//   #/tickets                 the list (crew: their own; office: everyone's, stale drafts, settings)
//   #/tickets/new?jobId=      a new draft for a job (labour prefilled from today's time)
//   #/tickets/:id             write it, get it signed ("Customer won't sign" records a refusal); the office
//                             sends a copy or a written notice, records an email acceptance, prices it
//   #/tickets/batch?jobId=    the super signs several of the job's drafts at once
//   #/tickets/settings        the agreement text, location, stale days, notices, T&M billing source
// The server numbers tickets (T-1001...) on the first sync; until then the screen shows "T-pending a3f9".
import { newTicket, prefillLabour, ticketProblems, ticketLabel, ticketToChangeOrder, staleDrafts, batchCandidates, agreementTextFor, PRICING_BASES, TICKET_KINDS,
  MAX_PHOTOS, PHOTO_MAX_BYTES, MAX_BATCH, ticketSummary } from '../lib/tickets.js';
import { buildSignature, signatureSheet, emailAcceptanceSheet, SIGNING_NOTICE, queueSignatureFirst } from '../lib/esign.js';
import { jobBillingMode } from '../lib/tm.js';

const STATUS_TABS = ['all', 'draft', 'signed', 'refused', 'priced', 'billed', 'void'];

function loadCss() {
  if (typeof document === 'undefined' || document.querySelector('link[href$="css/tickets.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = 'css/tickets.css';
  document.head.append(link);
}

export default {
  id: 'tickets',
  title: 'Field tickets',
  icon: 'pen',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    loadCss();
    const [sub] = ctx.params;
    if (sub === 'new') { createNew(ctx); return; }
    if (sub === 'batch') return batchView(root, ctx);
    if (sub === 'settings') return settingsView(root, ctx);
    if (sub) return detailView(root, ctx, sub);
    return listView(root, ctx);
  },
};

const office = (auth) => auth.can('invoices') && (auth.seesMoney?.() ?? true);
const today = (ui) => ui.today();

// ---------- list ----------
function listView(root, ctx) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  let tab = ctx.query.status || 'all';
  let jobId = ctx.query.jobId || '';
  const host = h('div', { class: 'stack' });
  const draw = () => {
    ui.clear(host);
    const all = store.list('fieldTickets').sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const jobs = new Map(store.list('jobs').map((j) => [j.id, j]));
    const stale = office(auth) ? staleDrafts(all, { asOf: today(ui), days: store.settings().tickets?.draftStaleDays ?? 3 }) : [];
    const rows = all.filter((t) => (tab === 'all' || t.status === tab) && (!jobId || t.jobId === jobId));
    const jobPick = h('select', { class: 'input tk-jobpick', 'aria-label': 'Job', onChange: (e) => { jobId = e.target.value; draw(); } },
      h('option', { value: '' }, 'All jobs'), [...jobs.values()].sort((a, b) => String(b.number).localeCompare(String(a.number))).map((j) => h('option', { value: j.id, selected: j.id === jobId }, `${j.number} · ${j.title}`)));
    h(host, null,
      stale.length ? h('div', { class: 'card tk-stale', dataset: { stale: String(stale.length) } },
        h('strong', null, `${stale.length} unsigned ticket${stale.length === 1 ? '' : 's'} older than ${store.settings().tickets?.draftStaleDays ?? 3} days`),
        h('p', { class: 'muted' }, 'Nothing is sent on its own. Open one to send it to the general contractor as written notice of the extra work.'),
        h('div', { class: 'list' }, stale.slice(0, 10).map((t) => h('a', { class: 'list-row click', href: `#/tickets/${t.id}` }, h('span', { class: 'grow' }, `${ticketLabel(t)} · ${jobs.get(t.jobId)?.number || ''} · ${t.title || 'Untitled'}`), ui.fmtDate(t.date))))) : null,
      h('div', { class: 'row' }, ui.tabs(STATUS_TABS.map((s) => ({ id: s, label: s === 'all' ? `All ${all.length}` : `${s} ${all.filter((t) => t.status === s).length}` })), tab, (t) => { tab = t; draw(); }),
        h('span', { class: 'grow' }), jobPick),
      ui.table({
        columns: [
          { key: 'n', label: 'Ticket', render: (t) => h('span', { class: 'mono' }, ticketLabel(t)), sort: (t) => t.number || '' },
          { key: 'd', label: 'Day', render: (t) => ui.fmtDate(t.date), sort: (t) => t.date || '' },
          { key: 'j', label: 'Job', render: (t) => jobs.get(t.jobId)?.number || '—', sort: (t) => jobs.get(t.jobId)?.number || '' },
          { key: 'w', label: 'Work', render: (t) => t.title || '—' },
          { key: 'k', label: 'Kind', render: (t) => (t.kind === 'tm' ? 'T&M' : 'Extra') },
          { key: 's', label: 'Status', render: (t) => h('span', { class: 'row-inline' }, ui.statusBadge(t.status), t.notice ? ui.badge('notice sent', 'info') : null), sort: (t) => t.status },
        ],
        rows, onRowClick: (t) => nav(`#/tickets/${t.id}`),
        empty: ui.empty({ icon: 'pen', title: all.length ? 'Nothing here' : 'No field tickets yet', text: 'Extra work and T&M signed on site, on the phone, even offline.',
          action: ui.button('New ticket', { variant: 'primary', icon: 'plus', href: '#/tickets/new' }) }),
      }));
  };
  root.append(ui.page({
    title: 'Field tickets', subtitle: 'Extra work and T&M signed on site',
    actions: [office(auth) ? ui.button('Settings', { icon: 'settings', href: '#/tickets/settings' }) : null, ui.button('New ticket', { variant: 'primary', icon: 'plus', href: `#/tickets/new${jobId ? `?jobId=${jobId}` : ''}` })].filter(Boolean),
  }, host));
  draw();
  const offs = ['fieldTickets', 'jobs'].map((c) => store.on(c, draw));
  return () => offs.forEach((f) => f());
}

// ---------- new ----------
function createNew(ctx) {
  const { store, ui, auth, query } = ctx;
  const me = auth.current();
  if (!me.id) { ui.toast('Your account is not linked to an employee record, so you cannot write tickets. Ask an owner to link it.', 'error', 6000); history.back(); return; }
  const open = store.list('timeEntries', (e) => e.employeeId === me.id && !e.clockOut && e.jobId)[0];
  const job = store.get('jobs', query.jobId || open?.jobId || '') || null;
  const t = newTicket({ job, employee: { id: me.id }, settings: store.settings(), date: today(ui) });
  if (job) {
    // Today's hours on the job, the open entry counted to now (a foreman sees the crew's).
    t.labour = prefillLabour({ jobId: job.id, day: today(ui), timeEntries: store.list('timeEntries'), employees: store.list('employees'), employeeId: me.id, crew: auth.can('time-approve'), dayOf: ui.localDay });
  }
  const created = store.add('fieldTickets', t);
  location.replace(`#/tickets/${created.id}`);
}

// ---------- detail ----------
function detailView(root, ctx, id) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const host = h('div');
  const settings = store.settings();
  let busy = false;

  const draw = () => {
    ui.clear(host);
    const t = store.get('fieldTickets', id);
    if (!t) { host.append(ui.page({ title: 'Ticket not found' }, ui.empty({ icon: 'pen', title: 'This ticket is not on this device', action: ui.button('All tickets', { href: '#/tickets' }) }))); return; }
    const job = t.jobId ? store.get('jobs', t.jobId) : null;
    const draft = t.status === 'draft';
    const mine = t.employeeId === auth.current().id;
    const editable = draft && (mine || auth.isManager());
    const write = (patch, summary) => store.update('fieldTickets', id, patch, summary ? { summary } : { silent: true });
    const field = (f, onVal) => {
      const el = ui.field(f);
      const c = el.querySelector('[name]');
      if (!editable) c.disabled = true;
      c.addEventListener(c.tagName === 'SELECT' ? 'change' : 'input', () => onVal(ui.readForm(el)[f.name]));
      return el;
    };
    const jobs = store.list('jobs', (j) => !['invoiced', 'cancelled'].includes(j.status)).sort((a, b) => String(b.number).localeCompare(String(a.number)));
    const head = h('div', { class: 'form-grid' },
      field({ label: 'Job', name: 'jobId', type: 'select', value: t.jobId || '', options: ui.recordOptions(jobs, (j) => `${j.number} · ${j.title}`, '— pick the job —') }, (v) => {
        const j = store.get('jobs', v);
        write({ jobId: v || null, clientId: j?.clientId || null, kind: jobBillingMode(j) === 'tm' ? 'tm' : 'extra' });
        draw();
      }),
      field({ label: 'Kind', name: 'kind', type: 'select', value: t.kind || 'extra', options: TICKET_KINDS.map((k) => ({ value: k.id, label: k.label })) }, (v) => write({ kind: v })),
      field({ label: 'Day', name: 'date', type: 'date', value: t.date }, (v) => write({ date: v })),
      field({ label: 'Who asked for it', name: 'requestedBy', value: t.requestedBy || '', placeholder: 'e.g. Pat, site super' }, (v) => write({ requestedBy: v })),
      field({ label: 'Work done', name: 'title', value: t.title || '', span: true, placeholder: 'Short title, e.g. Moved two pot lights' }, (v) => write({ title: v })),
      field({ label: 'Details', name: 'description', type: 'textarea', value: t.description || '', span: true, rows: 3 }, (v) => write({ description: v })),
      field({ label: 'Pricing', name: 'pricingBasis', type: 'select', value: t.pricingBasis || 'contract-rates', options: PRICING_BASES.map((p) => ({ value: p.id, label: p.label })) }, (v) => {
        write({ pricingBasis: v, agreementText: agreementTextFor(settings, { pricingBasis: v, rateSheetRef: t.rateSheetRef }) }); draw();
      }),
      t.pricingBasis !== 'quote-to-follow' ? field({ label: 'Rate sheet', name: 'rateSheetRef', value: t.rateSheetRef || '', placeholder: 'e.g. rates in contract 24-117' }, (v) => {
        write({ rateSheetRef: v, agreementText: agreementTextFor(settings, { pricingBasis: t.pricingBasis, rateSheetRef: v }) });
      }) : null);

    // Labour, material and equipment rows: quantities only, never prices.
    const rows = (key, cols, blank) => {
      const list = (t[key] || []).map((r) => ({ ...r }));
      const box = h('div', { class: 'tk-rows', dataset: { rows: key } });
      const save = () => write({ [key]: list });
      const drawRows = () => {
        ui.clear(box);
        list.forEach((r, i) => box.append(h('div', { class: 'tk-row' },
          cols.map((c) => h('input', { class: ['input', c.num ? 'num' : null], type: c.num ? 'number' : 'text', step: c.step || null, min: c.num ? '0' : null, value: r[c.key] ?? '', placeholder: c.label, 'aria-label': c.label, disabled: !editable,
            onInput: (e) => { r[c.key] = c.num ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value; save(); } })),
          editable ? ui.button('', { size: 'sm', variant: 'ghost danger', icon: 'trash', title: 'Remove', onClick: () => { list.splice(i, 1); save(); drawRows(); } }) : null)));
        if (!list.length) box.append(h('p', { class: 'muted' }, 'None.'));
      };
      drawRows();
      return { box, add: (r) => { list.push(r || { ...blank }); save(); drawRows(); } };
    };
    const labour = rows('labour', [{ key: 'name', label: 'Name' }, { key: 'hours', label: 'Hours', num: true, step: '0.25' }], { name: '', hours: 0 });
    const materials = rows('materials', [{ key: 'description', label: 'Material' }, { key: 'qty', label: 'Qty', num: true, step: '1' }, { key: 'unit', label: 'Unit' }], { description: '', qty: 1, unit: 'ea' });
    const equipment = rows('equipment', [{ key: 'description', label: 'Equipment' }, { key: 'qty', label: 'Qty', num: true, step: '0.5' }, { key: 'unit', label: 'hour or day' }], { description: '', qty: 1, unit: 'hour' });
    const prefill = () => {
      if (!t.jobId) { ui.toast('Pick the job first', 'error'); return; }
      write({ labour: prefillLabour({ jobId: t.jobId, day: t.date, timeEntries: store.list('timeEntries'), employees: store.list('employees'), employeeId: auth.current().id, crew: auth.can('time-approve'), dayOf: ui.localDay }) });
      draw();
    };
    // Van stock: the item comes off the van onto the job as a stock move with the ticket id
    // (people with the inventory permission; otherwise the office posts it from the ticket).
    const vanItem = () => {
      const me = store.get('employees', auth.current().id);
      const truck = me?.defaultEquipmentId ? store.get('equipment', me.defaultEquipmentId) : null;
      const van = truck?.locationId || null;
      const items = store.list('items', (i) => (van ? Number(i.stock?.[van]) > 0 : true)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 300);
      if (!items.length) { ui.toast(van ? 'Nothing in your van\'s stock list' : 'No items in the price book', 'info'); return; }
      ui.formSheet({
        title: van ? 'From your van' : 'From the price book', submitLabel: 'Add',
        fields: [
          { label: 'Item', name: 'itemId', type: 'select', value: items[0].id, span: true, options: items.map((i) => ({ value: i.id, label: `${i.name}${van ? ` (${i.stock[van]} ${i.unit || ''} in the van)` : ''}` })) },
          { label: 'Qty', name: 'qty', type: 'number', step: '1', min: '0', value: 1, required: true },
        ],
        onSubmit(v) {
          const it = store.get('items', v.itemId);
          if (!(Number(v.qty) > 0)) { ui.toast('Enter a quantity', 'error'); return false; }
          let stockMoveId = null;
          if (van && auth.can('inventory')) {
            const m = store.add('stockMoves', { itemId: it.id, qty: Number(v.qty), fromLocationId: van, toLocationId: null, jobId: t.jobId, date: t.date, use: 'job', ticketId: id, costCodeId: t.costCodeId || null, note: `Field ticket ${ticketLabel(t)}` });
            stockMoveId = m.id;
          }
          materials.add({ itemId: it.id, description: it.name, qty: Number(v.qty), unit: it.unit || 'ea', ...(van ? { fromLocationId: van } : {}), ...(stockMoveId ? { stockMoveId } : {}) });
        },
      });
    };
    const fromRequests = () => {
      const reqs = store.list('materialRequests', (r) => r.jobId === t.jobId && !['cancelled'].includes(r.status));
      if (!reqs.length) { ui.toast('No material requests on this job', 'info'); return; }
      ui.formSheet({
        title: 'From material requests', submitLabel: 'Add',
        fields: [{ label: 'Request', name: 'rid', type: 'select', value: reqs[0].id, span: true, options: reqs.map((r) => ({ value: r.id, label: `${r.qty ?? ''} ${r.unit || ''} ${store.get('items', r.itemId)?.name || r.description || 'Material'}` })) }],
        onSubmit(v) { const r = store.get('materialRequests', v.rid); materials.add({ itemId: r.itemId || null, description: store.get('items', r.itemId)?.name || r.description || 'Material', qty: Number(r.qty) || 1, unit: r.unit || 'ea' }); },
      });
    };
    const fromEquipment = () => {
      const eq = store.list('equipment', (e) => e.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name)));
      if (!eq.length) { equipment.add(); return; }
      // A truck already on today's clock-in is charged by the clock (6.1): it is shown, not charged again.
      const onClock = new Set(store.list('timeEntries', (e) => e.jobId === t.jobId && ui.localDay(e.clockIn) === t.date && e.equipmentId).map((e) => e.equipmentId));
      ui.formSheet({
        title: 'Equipment', submitLabel: 'Add',
        fields: [
          { label: 'Equipment', name: 'equipmentId', type: 'select', value: eq[0].id, span: true, options: eq.map((e) => ({ value: e.id, label: `${e.name}${onClock.has(e.id) ? ' (on today\'s clock-in: not charged again)' : ''}` })) },
          { label: 'Qty', name: 'qty', type: 'number', step: '0.5', min: '0', value: 1 },
          { label: 'Unit', name: 'unit', type: 'select', value: 'hour', options: ['hour', 'day'] },
        ],
        onSubmit(v) {
          const e = store.get('equipment', v.equipmentId);
          if (onClock.has(e.id)) { ui.toast(`${e.name} is on today's clock-in and is charged there.`, 'info', 4000); return; }
          equipment.add({ equipmentId: e.id, description: e.name, qty: Number(v.qty) || 1, unit: v.unit });
        },
      });
    };
    // Photos (at most 4, each 250 KB or less, downscaled on the phone).
    const photoHost = h('div', { class: 'tk-photos' });
    const drawPhotos = () => {
      ui.clear(photoHost);
      const photos = (store.get('fieldTickets', id)?.photos || []);
      photos.forEach((p, i) => photoHost.append(h('figure', { class: 'tk-photo' }, h('img', { src: p.dataUrl, alt: `Photo ${i + 1}` }),
        editable ? h('button', { type: 'button', class: 'tk-photo-x', 'aria-label': `Remove photo ${i + 1}`, onClick: () => { write({ photos: photos.filter((_, j) => j !== i) }); drawPhotos(); } }, '×') : null)));
      if (editable && photos.length < MAX_PHOTOS) photoHost.append(ui.button('Add photo', { size: 'sm', icon: 'camera', onClick: addPhoto }));
    };
    const addPhoto = async () => {
      const { pickImages, downscaleImage } = await import('../lib/safety-capture.js');
      const cur = store.get('fieldTickets', id)?.photos || [];
      const files = await pickImages({ multiple: MAX_PHOTOS - cur.length > 1 });
      const next = [...cur];
      for (const f of files.slice(0, MAX_PHOTOS - cur.length)) {
        try {
          const p = await downscaleImage(f, PHOTO_MAX_BYTES);
          next.push({ id: `ph-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, dataUrl: p.dataUrl, takenAt: new Date().toISOString(), width: p.width, height: p.height });
        } catch { ui.toast(`Couldn't read ${f.name}`, 'error'); }
      }
      write({ photos: next }, 'Photo added');
      drawPhotos();
    };
    drawPhotos();

    // ---- signing ----
    const sign = () => {
      const cur = store.get('fieldTickets', id);
      const problems = ticketProblems(cur);
      if (problems.length) { ui.toast(problems[0], 'error', 4000); return; }
      signatureSheet(ui, {
        title: `Sign ${ticketLabel(cur)}`, job, captureLocation: settings.tickets?.captureLocation !== false, askEmail: true,
        summary: ticketSheetSummary(ui, cur, job),
        agreementText: cur.agreementText,
        onSigned: async (s) => {
          if (busy) return false;
          busy = true;
          try {
            const fresh = store.get('fieldTickets', id);
            const sig = await buildSignature({ docType: 'fieldTicket', doc: fresh, jobId: fresh.jobId, clientId: fresh.clientId || null, ...s,
              capturedBy: { employeeId: auth.current().id || null, name: auth.who().name }, device: navigator.userAgent.slice(0, 120) });
            // The signature first, the ticket second, in the same tick (2.10).
            store.add('signatures', sig);
            store.update('fieldTickets', id, { status: 'signed', signatureId: sig.id, signedAt: sig.signedAt, signerName: sig.signerName, ...(s.loc ? { loc: s.loc } : {}) }, { summary: `${ticketLabel(fresh)} signed` });
            queueSignatureFirst(store, sig.id, [{ coll: 'fieldTickets', id }]);
            ui.toast(`Signed by ${sig.signerName}. It syncs when you're online.`, 'success', 4000);
          } finally { busy = false; }
          draw();
        },
        onRefused: async ({ by }) => {
          const reason = await ui.promptDialog('What did they say? (optional)', { title: 'Customer won\'t sign', okLabel: 'Record refusal' });
          if (reason === null) return false;
          store.update('fieldTickets', id, { status: 'refused', refusal: { at: new Date().toISOString(), by: by || store.get('fieldTickets', id).requestedBy || null, reason: reason || null } }, { summary: `${ticketLabel(t)} refused` });
          ui.toast(settings.tickets?.noticeOnRefusal !== false ? 'Refusal recorded. The office sends the written notice once it syncs.' : 'Refusal recorded.', 'info', 5000);
          draw();
        },
        refuseLabel: 'Customer won\'t sign',
      });
    };
    const byEmail = async () => {
      const r = await emailAcceptanceSheet(ui, { title: `${ticketLabel(t)}: accepted by email` });
      if (!r) return;
      const fresh = store.get('fieldTickets', id);
      const sig = await buildSignature({ docType: 'fieldTicket', doc: fresh, method: 'email-reply', signerName: r.signerName, signerEmail: r.signerEmail, evidence: r.evidence,
        jobId: fresh.jobId, clientId: fresh.clientId || null, capturedBy: { employeeId: auth.current().id || null, name: auth.who().name } });
      store.add('signatures', sig);
      store.update('fieldTickets', id, { status: 'signed', signatureId: sig.id, signedAt: sig.signedAt, signerName: sig.signerName }, { summary: `${ticketLabel(fresh)} accepted by email` });
      queueSignatureFirst(store, sig.id, [{ coll: 'fieldTickets', id }]);
      draw();
    };
    const send = async (kind) => {
      try {
        const r = await ctx.app.api.post(`/api/v1/tickets/${encodeURIComponent(id)}/send`, { kind });
        ui.toast(kind === 'copy' ? `Copy sent to ${r.to}` : `Written notice queued to ${r.to}`, 'success', 5000);
      } catch (e) {
        ui.toast(e.code === 'offline' ? 'Sending needs a connection.' : e.code === 'not_connected' ? `${e.message}` : e.message || 'Could not send', 'error', 6000);
        if (e.code === 'not_connected' || e.code === 'feature_not_in_plan') printTicket(ui, store.get('fieldTickets', id), job, settings, kind);
      }
    };
    const price = () => {
      let co;
      try { co = ticketToChangeOrder(t, { job, items: store.list('items'), equipment: store.list('equipment'), employees: store.list('employees'), settings, today: today(ui), id: `co-${Date.now().toString(36)}` }); } catch (e) { ui.toast(e.message, 'error', 5000); return; }
      const cur = store.get('jobs', job.id);
      store.update('jobs', job.id, { changeOrders: [...(cur.changeOrders || []), co] }, { summary: `${job.number}: ${ticketLabel(t)} priced` });
      store.update('fieldTickets', id, { status: 'priced', changeOrderId: co.id, office: { pricedAt: new Date().toISOString(), pricedBy: auth.who().name, note: null } }, { summary: `${ticketLabel(t)} priced` });
      ui.toast('Priced as a pending change order. Check it and get it signed on the job.', 'success', 5000);
      nav(`#/jobs/${job.id}?tab=changes`);
    };
    // A crew member without the inventory permission listed van stock: the office moves it (the moves
    // carry the ticket id; the signed ticket itself never changes).
    const postMoves = () => {
      const cur = store.get('fieldTickets', id);
      const done = new Set(store.list('stockMoves', (m) => m.ticketId === id).map((m) => m.itemId));
      let n = 0;
      for (const m of cur.materials || []) {
        if (m.stockMoveId || !m.itemId || !m.fromLocationId || done.has(m.itemId)) continue;
        store.add('stockMoves', { itemId: m.itemId, qty: Number(m.qty), fromLocationId: m.fromLocationId, toLocationId: null, jobId: cur.jobId, date: cur.date, use: 'job', ticketId: id, note: `Field ticket ${ticketLabel(cur)}` });
        n++;
      }
      ui.toast(n ? `${n} van stock move${n === 1 ? '' : 's'} recorded on the job` : 'Already moved', 'success');
    };
    const voidIt = async () => {
      const ok = await ui.confirmDialog(`Void ${ticketLabel(t)}? It stays on record${t.signatureId ? ' with its signature' : ''}.`, { okLabel: 'Void' });
      if (ok) { store.update('fieldTickets', id, { status: 'void' }, { summary: `${ticketLabel(t)} void` }); draw(); }
    };
    const unposted = (t.materials || []).some((m) => m.itemId && m.fromLocationId && !m.stockMoveId);
    const sig = t.signatureId ? store.get('signatures', t.signatureId) : null;
    const isOffice = office(auth);
    host.append(ui.page({
      title: `${ticketLabel(t)}${t.title ? ` · ${t.title}` : ''}`,
      subtitle: h('span', null, h('a', { href: '#/tickets' }, 'Field tickets'), job ? [' / ', h('a', { href: `#/jobs/${job.id}` }, `${job.number} ${job.title}`)] : null),
      actions: [ui.button('Print', { icon: 'printer', onClick: () => printTicket(ui, store.get('fieldTickets', id), job, settings) })],
    },
    h('div', { class: 'doc-layout' },
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, head),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Labour'), editable ? [ui.button('From today\'s time', { size: 'sm', onClick: prefill }), ui.button('Add', { size: 'sm', variant: 'ghost', icon: 'plus', onClick: () => labour.add() })] : null), labour.box),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Material'), editable ? [ui.button('From the van', { size: 'sm', onClick: vanItem }), ui.button('From requests', { size: 'sm', variant: 'ghost', onClick: fromRequests }), ui.button('Add', { size: 'sm', variant: 'ghost', icon: 'plus', onClick: () => materials.add() })] : null), materials.box),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Equipment'), editable ? ui.button('Add', { size: 'sm', variant: 'ghost', icon: 'plus', onClick: fromEquipment }) : null), equipment.box),
        h('div', { class: 'card' }, h('h3', null, 'Photos'), photoHost),
        h('div', { class: 'card tk-agree' }, h('h3', null, 'What the customer agrees to'), h('p', null, t.agreementText || ''))),
      h('aside', { class: 'doc-side stack' },
        h('div', { class: 'card stack' },
          h('div', { class: 'row' }, h('strong', { class: 'grow' }, 'Status'), ui.statusBadge(t.status)),
          t.number ? null : h('p', { class: 'muted' }, 'The number is given when it syncs.'),
          sig ? h('div', { class: 'tk-signed', dataset: { signedBy: sig.signerName } }, sig.dataUrl ? h('img', { src: sig.dataUrl, alt: `Signature of ${sig.signerName}` }) : null,
            h('div', null, `Signed by ${sig.signerName}${sig.signerTitle ? `, ${sig.signerTitle}` : ''}`), h('div', { class: 'muted' }, `${ui.fmtDateTime(sig.signedAt)}${sig.method === 'email-reply' ? ' · accepted by email' : ''}${sig.loc ? ' · location recorded' : ''}`),
            sig.status === 'unverified' ? ui.badge('unverified: check it', 'warning') : null) : null,
          t.refusal ? h('div', { class: 'tk-refused' }, `Refused by ${t.refusal.by || 'the customer'} ${ui.fmtDateTime(t.refusal.at)}${t.refusal.reason ? `: ${t.refusal.reason}` : ''}`) : null,
          t.notice ? h('div', { class: 'muted' }, `Written notice ${t.notice.kind === 'unsigned' ? '(unsigned)' : ''} queued ${ui.fmtDateTime(t.notice.queuedAt)} to ${t.notice.to}`) : null,
          editable ? h('div', { class: 'stack' },
            ui.button('Get it signed', { variant: 'primary', icon: 'pen', onClick: sign }),
            h('p', { class: 'muted tk-hint' }, 'Super isn\'t here? Leave it as a draft and get it signed later, or sign several together.')) : null,
          isOffice && draft ? ui.button('Customer accepted by email', { onClick: byEmail }) : null,
          isOffice && ['draft', 'refused'].includes(t.status) ? ui.button('Send as written notice', { onClick: () => send('notice') }) : null,
          isOffice && sig?.signerEmail ? ui.button('Send copy now', { variant: 'ghost', onClick: () => send('copy') }) : null,
          isOffice && job && jobBillingMode(job) !== 'tm' && job.kind !== 'service' && ['signed', 'refused'].includes(t.status) ? ui.button('Price as change order', { onClick: price }) : null,
          isOffice && unposted && auth.can('inventory') ? ui.button('Move the van stock to the job', { variant: 'ghost', onClick: postMoves }) : null,
          isOffice && t.status !== 'void' && !(t.status === 'billed') ? ui.button('Void', { variant: 'ghost danger', onClick: voidIt }) : null,
          draft && mine && !t.number ? ui.button('Delete draft', { variant: 'ghost danger', onClick: async () => { if (await ui.confirmDialog('Delete this draft?', { okLabel: 'Delete' })) { store.remove('fieldTickets', id); nav('#/tickets'); } } }) : null),
        h('p', { class: 'muted tk-hint' }, SIGNING_NOTICE)))));
  };
  root.append(host);
  draw();
  const off = store.on('fieldTickets', (e) => { if (e?.record?.id === id && e.remote) draw(); });
  return off;
}

/** What the signer sees: the work, hours and quantities, never a price. */
function ticketSheetSummary(ui, t, job) {
  const { h } = ui;
  return h('div', { class: 'stack tk-summary' },
    h('div', { class: 'title' }, `${ticketLabel(t)} · ${t.title || ''}`), h('div', { class: 'muted' }, `${job?.number || ''} ${job?.title || ''} · ${ui.fmtDate(t.date)}`),
    t.description ? h('p', null, t.description) : null,
    (t.labour || []).length ? h('ul', { class: 'es-lines' }, t.labour.map((l) => h('li', null, `${l.name || 'Crew'}: ${l.hours} h${l.travel ? ' travel' : ''}`))) : null,
    (t.materials || []).length ? h('ul', { class: 'es-lines' }, t.materials.map((m) => h('li', null, `${m.qty} ${m.unit || ''} ${m.description || ''}`))) : null,
    (t.equipment || []).length ? h('ul', { class: 'es-lines' }, t.equipment.map((q) => h('li', null, `${q.description || ''}: ${q.qty} ${q.unit || ''}`))) : null,
    (t.photos || []).length ? h('div', { class: 'tk-photos' }, t.photos.map((p, i) => h('img', { class: 'tk-thumb', src: p.dataUrl, alt: `Photo ${i + 1}` }))) : null);
}

/** Print the ticket (or the written notice) when email is not on the plan. No prices. */
function printTicket(ui, t, job, settings, kind = null) {
  const { h } = ui;
  import('../lib/doc-view.js').then(({ printNode }) => printNode(h('div', { class: 'doc-sheet' },
    h('div', { class: 'doc-top' }, h('div', { class: 'doc-brand' }, settings.company?.name || ''), h('div', { class: 'doc-title' }, h('div', { class: 'doc-kind' }, kind === 'notice' ? 'Written notice of extra work' : 'Field ticket'), h('div', { class: 'doc-num' }, ticketLabel(t)))),
    h('p', null, `${job?.number || ''} ${job?.title || ''} · ${t.date}`), h('p', { class: 'doc-strong' }, t.title || ''), t.description ? h('p', null, t.description) : null,
    h('table', { class: 'doc-lines' }, h('tbody', null,
      (t.labour || []).map((l) => h('tr', null, h('td', null, `Labour: ${l.name || 'Crew'}`), h('td', { class: 'right' }, `${l.hours} h`))),
      (t.materials || []).map((m) => h('tr', null, h('td', null, `Material: ${m.description || ''}`), h('td', { class: 'right' }, `${m.qty} ${m.unit || ''}`))),
      (t.equipment || []).map((q) => h('tr', null, h('td', null, `Equipment: ${q.description || ''}`), h('td', { class: 'right' }, `${q.qty} ${q.unit || ''}`))))),
    h('p', null, t.agreementText || ''),
    t.signerName ? h('p', null, `Signed by ${t.signerName} ${t.signedAt || ''}`) : t.refusal ? h('p', null, `Refused by ${t.refusal.by || 'the customer'} ${t.refusal.at || ''}`) : h('p', null, 'Not signed.'))));
}

// ---------- batch signing (4.1 step 5) ----------
function batchView(root, ctx) {
  const { store, ui, nav, auth } = ctx;
  const { h } = ui;
  const jobId = ctx.query.jobId || '';
  const job = store.get('jobs', jobId);
  const host = h('div', { class: 'stack' });
  if (!job || !(auth.isManager() || office(auth))) {
    root.append(ui.page({ title: 'Sign several tickets' }, ui.empty({ icon: 'pen', title: job ? 'A foreman or the office signs tickets together' : 'Open this from a job', action: ui.button('All tickets', { href: '#/tickets' }) })));
    return;
  }
  const drafts = batchCandidates(store.list('fieldTickets'), jobId);
  const picked = new Set(drafts.map((t) => t.id));
  const draw = () => {
    ui.clear(host);
    host.append(h('p', { class: 'muted' }, `The super signs once for the tickets picked below (at most ${MAX_BATCH}).`),
      h('div', { class: 'list' }, drafts.map((t) => h('label', { class: 'list-row' },
        h('input', { type: 'checkbox', checked: picked.has(t.id), onChange: (e) => { if (e.target.checked) picked.add(t.id); else picked.delete(t.id); } }),
        h('span', { class: 'grow' }, ticketSummary(t)), ticketProblems(t).length ? ui.badge('incomplete', 'warning') : null))),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Get them signed', { variant: 'primary', icon: 'pen', onClick: sign })));
  };
  const sign = () => {
    const tickets = drafts.filter((t) => picked.has(t.id)).map((t) => store.get('fieldTickets', t.id)).filter((t) => t?.status === 'draft');
    if (!tickets.length) { ui.toast('Pick at least one ticket', 'error'); return; }
    const bad = tickets.find((t) => ticketProblems(t).length);
    if (bad) { ui.toast(`${ticketLabel(bad)}: ${ticketProblems(bad)[0]}`, 'error', 5000); return; }
    signatureSheet(ui, {
      title: `Sign ${tickets.length} tickets on ${job.number}`, job, captureLocation: store.settings().tickets?.captureLocation !== false, askEmail: true,
      summary: h('div', { class: 'stack' }, tickets.map((t) => ticketSheetSummary(ui, t, job))),
      agreementText: tickets[0].agreementText,
      onSigned: async (s) => {
        const sig = await buildSignature({ docType: 'ticketBatch', doc: { id: `batch-${Date.now().toString(36)}`, jobId, tickets }, jobId, clientId: job.clientId || null, ...s,
          capturedBy: { employeeId: auth.current().id || null, name: auth.who().name }, device: navigator.userAgent.slice(0, 120) });
        store.add('signatures', sig);
        for (const t of tickets) store.update('fieldTickets', t.id, { status: 'signed', signatureId: sig.id, signedAt: sig.signedAt, signerName: sig.signerName }, { summary: `${ticketLabel(t)} signed (batch)` });
        queueSignatureFirst(store, sig.id, tickets.map((t) => ({ coll: 'fieldTickets', id: t.id })));
        ui.toast(`${tickets.length} tickets signed by ${sig.signerName}`, 'success', 4000);
        nav(`#/jobs/${jobId}?tab=tickets`);
      },
    });
  };
  draw();
  root.append(ui.page({ title: `Sign several tickets · ${job.number}`, subtitle: h('span', null, h('a', { href: '#/tickets' }, 'Field tickets'), ` / ${job.title}`) }, host));
}

// ---------- settings (2.4: Field tickets → Settings, office) ----------
function settingsView(root, ctx) {
  const { store, ui, auth } = ctx;
  const { h } = ui;
  if (!office(auth)) { root.append(ui.page({ title: 'Ticket settings' }, ui.empty({ icon: 'settings', title: 'Ticket settings are for the office' }))); return; }
  const s = store.settings().tickets || {};
  const form = h('form', { class: 'stack', onSubmit: (e) => e.preventDefault() }, ui.formGrid([
    { label: 'What the customer agrees to', name: 'agreementText', type: 'textarea', span: true, rows: 3, value: s.agreementText || 'I confirm the work listed above was requested and done.' },
    { label: 'Record the location with each signature', name: 'captureLocation', type: 'checkbox', value: s.captureLocation !== false, hint: 'The signer is told (privacy).' },
    { label: 'Send written notice when a customer refuses to sign', name: 'noticeOnRefusal', type: 'checkbox', value: s.noticeOnRefusal !== false },
    { label: 'Unsigned tickets are stale after (days)', name: 'draftStaleDays', type: 'number', step: '1', min: '1', value: s.draftStaleDays ?? 3 },
    { label: 'T&M invoices bill hours from', name: 'billFrom', type: 'select', value: s.billFrom || 'time', options: [{ value: 'time', label: 'Time entries (tickets reconciled day by day)' }, { value: 'tickets', label: 'Signed ticket hours' }] },
  ]));
  root.append(ui.page({ title: 'Ticket settings', subtitle: h('span', null, h('a', { href: '#/tickets' }, 'Field tickets'), ' / settings') },
    h('div', { class: 'card' }, form,
      h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Save', { variant: 'primary', onClick: () => {
        const v = ui.readForm(form);
        store.saveSettings({ tickets: { ...s, agreementText: String(v.agreementText || '').slice(0, 1500), captureLocation: Boolean(v.captureLocation), noticeOnRefusal: Boolean(v.noticeOnRefusal), draftStaleDays: Number(v.draftStaleDays) || 3, billFrom: v.billFrom === 'tickets' ? 'tickets' : 'time' } });
        ui.toast('Ticket settings saved', 'success');
      } })))));
}

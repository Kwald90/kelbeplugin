// Material requests (#/materials): anyone on the crew asks for material during the day ("need 50
// two-hole clamps", "3/4 EMT x 20 sticks") from the price book or as free text, with a quantity
// and a job. It works offline (an ordinary synced collection). The waiting requests go to the
// office once a day at the company's time (the server worker, services/materials.js) or straight
// away with "Send now", as one list grouped by job: in the bell, by email and on this page.
// The office marks them ordered or fulfilled, takes them from stock (a stock move onto the job),
// rolls them into a purchase list, and sees what is already in the vans. Crew never see prices.
import { STATUS_LABEL, requestSettings, nextSendAt, fmtSendAt, groupByJob, purchaseList, stockByLocation, stockHint, matchItems, requestName, qtyText } from '../lib/materials.js';
import { switchOn } from '../lib/modules.js';
import { applyMove } from './inventory.js';
import { uid } from '../store.js';

const TABS = [
  { id: 'requested', label: 'Waiting to send' }, { id: 'sent', label: 'To order' },
  { id: 'ordered', label: 'Ordered' }, { id: 'done', label: 'Done' },
];
const ACTIVE_JOB = new Set(['scheduled', 'in-progress', 'on-hold']);
const statusOf = (r) => r.status || 'requested';
const inTab = (tab, r) => (tab === 'done' ? ['fulfilled', 'cancelled'].includes(statusOf(r)) : statusOf(r) === tab);

export default {
  id: 'materials',
  title: 'Material requests',
  icon: 'truck',
  group: 'work',
  perm: 'jobs',
  render(root, ctx) {
    const { store, ui, auth, app } = ctx;
    const { h } = ui;
    const me = auth.current();
    const manager = auth.isManager();
    // Office and managers with money permissions see costs; the crew never do.
    const money = auth.seesMoney?.() ?? (auth.can('invoices') || auth.can('estimates'));
    const stock = () => switchOn(store.settings(), 'inventory') && auth.can('inventory');
    let tab = ctx.query.batch ? 'sent' : 'requested';
    let batch = ctx.query.batch || null;
    const selected = new Set();
    let lastBatch = null;

    const items = () => new Map(store.list('items').map((i) => [i.id, i]));
    const jobs = () => store.list('jobs');
    const employees = () => new Map(store.list('employees').map((e) => [e.id, e]));
    const mine = (r) => r.employeeId && r.employeeId === me.id;

    // ---- the quick add form (everyone) ----------------------------------------------------
    let picked = null; // a price-book item
    const activeJobs = () => jobs().filter((j) => ACTIVE_JOB.has(j.status)).sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
    const defaultJob = () => {
      if (ctx.query.jobId) return ctx.query.jobId;
      const clocked = store.list('timeEntries', (t) => t.employeeId === me.id && !t.clockOut)[0];
      if (clocked?.jobId) return clocked.jobId;
      const today = store.list('schedule', (s) => s.employeeId === me.id && s.date === ui.today())[0];
      if (today?.jobId) return today.jobId;
      return activeJobs().find((j) => (j.crewIds || []).includes(me.id))?.id || '';
    };
    const what = h('input', { class: 'input', name: 'what', placeholder: 'What do you need? e.g. two-hole clamps 3/4', autocomplete: 'off', 'aria-label': 'What do you need' });
    const qty = h('input', { class: 'input', name: 'qty', type: 'number', inputmode: 'decimal', min: '0', step: 'any', value: '1', 'aria-label': 'Quantity' });
    const unit = h('input', { class: 'input', name: 'unit', placeholder: 'ea, sticks, ft', value: '', 'aria-label': 'Unit' });
    const jobSel = h('select', { class: 'input', name: 'jobId', 'aria-label': 'Job' });
    const urgent = h('input', { type: 'checkbox', name: 'urgent' });
    const note = h('input', { class: 'input', name: 'note', placeholder: 'Note (optional): brand, length, where to drop it', 'aria-label': 'Note' });
    const picks = h('div', { class: 'mr-picks', 'aria-label': 'From the price book' });
    const fillJobs = () => {
      const keep = jobSel.value || defaultJob();
      ui.clear(jobSel).append(h('option', { value: '' }, 'No job (shop)'), ...activeJobs().map((j) => h('option', { value: j.id, selected: j.id === keep }, `${j.number} · ${j.title}`)));
    };
    const drawPicks = () => {
      ui.clear(picks);
      const list = matchItems(what.value, store.list('items'), 6);
      if (picked && !list.some((i) => i.id === picked.id)) list.unshift(picked);
      for (const it of list) {
        picks.append(h('button', { type: 'button', class: 'mr-pick', 'aria-pressed': String(picked?.id === it.id), dataset: { item: it.id },
          onClick: () => { picked = picked?.id === it.id ? null : it; if (picked) { what.value = it.name; if (!unit.value || unit.dataset.auto) { unit.value = it.unit || 'ea'; unit.dataset.auto = '1'; } } drawPicks(); } }, it.name));
      }
    };
    what.addEventListener('input', () => { if (picked && what.value !== picked.name) picked = null; drawPicks(); });
    unit.addEventListener('input', () => { delete unit.dataset.auto; });
    const add = () => {
      const text = what.value.trim();
      const n = Number(qty.value);
      if (!text) { ui.toast('Say what you need', 'error'); what.focus(); return; }
      if (!(n > 0)) { ui.toast('Enter how many', 'error'); qty.focus(); return; }
      if (auth.synced && !me.id && !manager) { ui.toast('Your account is not linked to an employee record. Ask the office.', 'error', 4000); return; }
      const rec = store.add('materialRequests', {
        jobId: jobSel.value || null, itemId: picked?.id || null, description: picked ? picked.name : text, qty: n, unit: unit.value.trim() || picked?.unit || 'ea',
        note: note.value.trim(), urgent: urgent.checked, employeeId: me.id || null, status: 'requested',
      });
      const rs = requestSettings(store.settings());
      ui.toast(rec.urgent ? 'Added as urgent. Tap Send now if it can’t wait.' : `Added. It goes to the office at ${fmtSendAt(rs.sendAt)}.`, 'success', 3200);
      what.value = ''; qty.value = '1'; unit.value = ''; note.value = ''; urgent.checked = false; picked = null;
      drawPicks(); what.focus();
    };
    const form = h('form', { class: 'card mr-quick', onSubmit: (e) => { e.preventDefault(); add(); } },
      h('h3', { style: { margin: 0 } }, 'Need something?'),
      h('label', { class: 'field' }, h('span', null, 'Material'), what), picks,
      h('div', { class: 'form-grid' },
        h('label', { class: 'field' }, h('span', null, 'How many'), qty),
        h('label', { class: 'field' }, h('span', null, 'Unit'), unit),
        h('label', { class: 'field span-2' }, h('span', null, 'Job'), jobSel),
        h('label', { class: 'field span-2' }, h('span', null, 'Note'), note),
        h('label', { class: 'field check' }, urgent, h('span', null, 'Urgent'))),
      h('div', { class: 'row' }, h('span', { class: 'grow' }), ui.button('Add request', { variant: 'primary', icon: 'plus', type: 'submit' })),
      h('button', { type: 'submit', hidden: true }));

    // ---- send now --------------------------------------------------------------------------
    const sendNow = async (btn) => {
      const waiting = store.count('materialRequests', (r) => statusOf(r) === 'requested');
      if (!waiting) { ui.toast('Nothing is waiting to send'); return; }
      if (btn) btn.disabled = true;
      try {
        if (app?.sync && auth.synced) {
          await app.sync.syncNow();
          if (app.sync.status().waiting) throw new Error('Some requests have not reached the server yet. Check your connection and try again.');
          const r = await app.api.post('/api/v1/material-requests/send', {});
          await app.sync.syncNow().catch(() => {});
          ui.toast(r.count ? `Sent ${r.count} request${r.count === 1 ? '' : 's'} for ${r.jobs} job${r.jobs === 1 ? '' : 's'} to the office${r.emailed ? ' (and by email)' : ''}` : 'Nothing was waiting on the server', 'success', 4000);
          lastBatch = r.count ? { at: new Date().toISOString(), count: r.count } : lastBatch;
        } else {
          // The demo has no server: mark them sent on this device.
          const id = uid(), at = new Date().toISOString();
          for (const r of store.list('materialRequests', (x) => statusOf(x) === 'requested')) store.update('materialRequests', r.id, { status: 'sent', sentAt: at, batchId: id }, { silent: true });
          ui.toast(`Demo: ${waiting} request${waiting === 1 ? '' : 's'} marked sent. Signed in, the office gets them in the bell and by email.`, 'success', 4500);
        }
      } catch (e) {
        ui.toast(e.message || 'Could not send. Try again when you have a connection.', 'error', 4500);
      } finally { if (btn) btn.disabled = false; }
      draw();
    };

    // ---- office actions ---------------------------------------------------------------------
    const set = (r, patch, summary) => store.update('materialRequests', r.id, { ...patch, handledBy: me.id || null }, { summary });
    const markOrdered = (list) => { const at = new Date().toISOString(); for (const r of list) set(r, { status: 'ordered', orderedAt: at }, `ordered ${requestName(r, items())}`); ui.toast(`${list.length} marked ordered`, 'success'); };
    const markFulfilled = (list) => { const at = new Date().toISOString(); for (const r of list) set(r, { status: 'fulfilled', fulfilledAt: at }, `fulfilled ${requestName(r, items())}`); ui.toast(`${list.length} marked fulfilled`, 'success'); };
    const fromStock = (r) => {
      const it = store.get('items', r.itemId);
      const locs = store.list('locations').sort((a, b) => a.name.localeCompare(b.name));
      const where = stockByLocation(it, locs);
      if (!it || !locs.length) { ui.toast('Pick a price-book item and add a location first', 'error'); return; }
      ui.formSheet({
        title: `From stock: ${it.name}`, submitLabel: 'Take from stock',
        fields: [
          { label: 'From', name: 'fromLocationId', type: 'select', value: where[0]?.locationId || locs[0].id, options: locs.map((l) => ({ value: l.id, label: `${l.name} (${Number(it.stock?.[l.id]) || 0} ${it.unit || ''})` })), span: true },
          { label: 'Quantity', name: 'qty', type: 'number', step: 'any', min: '0', value: r.qty, required: true },
        ],
        onSubmit: (v) => {
          const res = applyMove(store, { type: 'use', itemId: it.id, fromLocationId: v.fromLocationId, qty: v.qty, jobId: r.jobId, date: ui.today(), note: `Material request: ${qtyText(r)} ${requestName(r, items())}` });
          if (res.error) { ui.toast(res.error, 'error'); return false; }
          set(r, { status: 'fulfilled', fulfilledAt: new Date().toISOString(), stockMoveId: res.move.id, fromLocationId: v.fromLocationId }, `from stock ${it.name}`);
          ui.toast(res.warning || `Taken from ${store.get('locations', v.fromLocationId)?.name} onto the job`, res.warning ? 'info' : 'success', 3500);
        },
      });
    };
    const setCost = async (r) => {
      const v = await ui.promptDialog(`Cost per ${r.unit || 'unit'} for ${requestName(r, items())}`, { title: 'Set cost', value: r.costCents != null ? ui.centsToInput(r.costCents) : '' });
      if (v == null) return;
      set(r, { costCents: v.trim() === '' ? null : ui.parseMoney(v) }, 'cost');
    };
    const openPurchaseList = (list) => {
      const rows = purchaseList(list, { items: items(), jobs: jobs() });
      const text = rows.map((x) => `${qtyText(x)}  ${x.description}  (${x.jobs.join(', ')})`).join('\n');
      const csv = [['Qty', 'Unit', 'Item', 'Jobs', ...(money ? ['Cost each'] : [])].join(','),
        ...rows.map((x) => [x.qty, x.unit, `"${x.description.replace(/"/g, '""')}"`, `"${x.jobs.join(' ')}"`, ...(money ? [x.costCents != null ? ui.centsToInput(x.costCents) : ''] : [])].join(','))].join('\n');
      const sheet = ui.openSheet({
        title: `Purchase list · ${rows.length} line${rows.length === 1 ? '' : 's'}`, wide: true,
        body: h('div', { class: 'stack' }, h('p', { class: 'muted', style: { margin: 0 } }, 'Same items added up across jobs. Copy it into an email or your supplier’s order form.'),
          ui.table({
            columns: [
              { key: 'q', label: 'Qty', align: 'right', render: (x) => qtyText(x) },
              { key: 'd', label: 'Item', render: (x) => x.description },
              { key: 'j', label: 'Jobs', render: (x) => x.jobs.join(', ') },
              money ? { key: 'c', label: 'Cost each', align: 'right', render: (x) => (x.costCents != null ? ui.fmtMoney(x.costCents) : '—') } : null,
            ].filter(Boolean),
            rows,
          })),
        actions: [
          ui.button('Copy', { icon: 'copy', onClick: async () => { try { await navigator.clipboard.writeText(text); ui.toast('Copied', 'success'); } catch { ui.toast('Copying is blocked here; use the CSV', 'error'); } } }),
          ui.button('CSV', { icon: 'download', onClick: () => { ui.download(`purchase-list-${ui.today()}.csv`, csv, 'text/csv'); store.log('export', 'Material purchase list', 'materialRequests'); } }),
          h('span', { class: 'grow' }),
          list.some((r) => statusOf(r) === 'sent') ? ui.button('Mark these ordered', { variant: 'primary', icon: 'check', onClick: () => { markOrdered(list.filter((r) => statusOf(r) === 'sent')); sheet.close(); } }) : null,
        ].filter(Boolean),
      });
    };

    // ---- drawing ------------------------------------------------------------------------------
    const host = h('div', { class: 'stack' });
    const schedHost = h('div');
    const drawSchedule = () => {
      const rs = requestSettings(store.settings());
      const next = nextSendAt(new Date(), rs);
      const waiting = store.count('materialRequests', (r) => statusOf(r) === 'requested');
      const when = next.at.toLocaleString('en-CA', { timeZone: rs.timeZone, weekday: next.day === new Date().toLocaleDateString('en-CA', { timeZone: rs.timeZone }) ? undefined : 'short', hour: 'numeric', minute: '2-digit' });
      const btn = ui.button(manager ? 'Send now' : 'Send now (urgent)', { variant: waiting ? 'primary' : 'secondary', icon: 'send', onClick: () => sendNow(btn), disabled: !waiting });
      ui.clear(schedHost).append(h('div', { class: 'card mr-sched' }, ui.icon('clock', 20),
        h('div', { class: 'grow' }, h('strong', null, waiting ? `${waiting} waiting to go to the office` : 'Nothing waiting'),
          h('div', { class: 'muted' }, `The list goes out at ${fmtSendAt(rs.sendAt)} (${rs.timeZone.replace('America/', '').replace(/_/g, ' ')} time). Next: ${when}.${lastBatch ? ` Last sent ${ui.fmtDateTime(lastBatch.at)} (${lastBatch.count}).` : ''}`)),
        btn));
    };

    const row = (r, { office }) => {
      const it = r.itemId ? items().get(r.itemId) : null;
      const who = employees().get(r.employeeId)?.name;
      const hint = office && stock() && it ? stockHint(it, store.list('locations')) : null;
      const st = statusOf(r);
      const actions = [];
      if (office) {
        if (st === 'requested' || st === 'sent') actions.push(ui.button('Ordered', { size: 'sm', icon: 'check', onClick: () => markOrdered([r]) }));
        if (['requested', 'sent', 'ordered'].includes(st)) actions.push(ui.button('Fulfilled', { size: 'sm', onClick: () => markFulfilled([r]) }));
        if (['requested', 'sent', 'ordered'].includes(st) && stock() && it) actions.push(ui.button('From stock', { size: 'sm', icon: 'box', onClick: () => fromStock(r) }));
        if (money && !it && st !== 'cancelled') actions.push(ui.button(r.costCents != null ? ui.fmtMoney(r.costCents) : 'Cost…', { size: 'sm', variant: 'ghost', onClick: () => setCost(r) }));
      } else if (st === 'requested' && mine(r)) {
        actions.push(ui.button('Cancel', { size: 'sm', variant: 'ghost danger', onClick: async () => {
          if (!(await ui.confirmDialog(`Cancel ${qtyText(r)} ${requestName(r, items())}?`, { okLabel: 'Cancel request', title: 'Cancel request' }))) return;
          store.update('materialRequests', r.id, { status: 'cancelled', cancelledAt: new Date().toISOString() });
        } }));
      }
      return h('div', { class: 'list-row mr-row', dataset: { request: r.id } },
        office ? h('input', { type: 'checkbox', class: 'mr-check', 'aria-label': 'Select', checked: selected.has(r.id), onChange: (e) => { if (e.target.checked) selected.add(r.id); else selected.delete(r.id); drawBulk(); } }) : null,
        h('span', { class: 'qty num' }, qtyText(r)),
        h('div', { class: 'grow' },
          h('div', { class: 'title' }, requestName(r, items()), r.urgent ? h('span', { class: 'mr-urgent' }, ' · urgent') : null),
          h('div', { class: 'meta' }, [who, r.note ? `“${r.note}”` : null, ui.fmtDateTime(r.createdAt), office ? null : STATUS_LABEL[st]].filter(Boolean).join(' · ')),
          hint ? h('div', { class: 'mr-stock' }, hint) : null,
          office && money && it?.costCents != null ? h('div', { class: 'meta' }, `${ui.fmtMoney(it.costCents)} each at cost`) : null),
        h('div', { class: 'mr-actions' }, actions));
    };

    const bulkHost = h('div');
    let current = [];
    const drawBulk = () => {
      const list = selected.size ? current.filter((r) => selected.has(r.id)) : current;
      ui.clear(bulkHost);
      if (!manager || !list.length || tab === 'done') return;
      bulkHost.append(h('div', { class: 'row' },
        h('span', { class: 'muted grow' }, selected.size ? `${list.length} selected` : `All ${list.length} in this list`),
        tab !== 'ordered' ? ui.button('Mark ordered', { size: 'sm', icon: 'check', onClick: () => { markOrdered(list); selected.clear(); } }) : null,
        ui.button('Mark fulfilled', { size: 'sm', onClick: () => { markFulfilled(list); selected.clear(); } }),
        ui.button('Purchase list', { size: 'sm', icon: 'list', onClick: () => openPurchaseList(list) })));
    };

    const draw = () => {
      ui.clear(host);
      fillJobs();
      drawSchedule();
      const all = store.list('materialRequests');
      if (!manager) {
        const own = all.filter((r) => mine(r) || !r.employeeId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        host.append(...ui.section('Your requests'), own.length
          ? h('div', { class: 'list card flat', style: { padding: 0 } }, own.slice(0, 50).map((r) => row(r, { office: false })))
          : ui.empty({ icon: 'truck', title: 'No requests yet', text: 'Add what you need above. It goes to the office with everyone else’s at the end of the day.' }));
        return;
      }
      const counts = Object.fromEntries(TABS.map((t) => [t.id, all.filter((r) => inTab(t.id, r)).length]));
      host.append(h('div', { class: 'row' }, ui.tabs(TABS.map((t) => ({ id: t.id, label: `${t.label} ${counts[t.id] || ''}`.trim() })), tab, (t) => { tab = t; batch = null; selected.clear(); draw(); })));
      current = all.filter((r) => inTab(tab, r) && (!batch || r.batchId === batch));
      if (batch) host.append(h('div', { class: 'row muted' }, ui.icon('info', 16), h('span', { class: 'grow' }, `The list sent ${ui.fmtDateTime(current[0]?.sentAt)}.`), ui.button('Show all', { size: 'sm', variant: 'ghost', onClick: () => { batch = null; draw(); } })));
      for (const id of [...selected]) if (!current.some((r) => r.id === id)) selected.delete(id);
      host.append(bulkHost);
      drawBulk();
      if (!current.length) {
        host.append(ui.empty({ icon: 'truck', title: tab === 'requested' ? 'Nothing waiting' : tab === 'sent' ? 'Nothing to order' : tab === 'ordered' ? 'Nothing on order' : 'Nothing done yet',
          text: tab === 'requested' ? 'Requests from the crew collect here until the daily send.' : 'Requests move here as the office handles them.' }));
        return;
      }
      for (const g of groupByJob(current, jobs())) {
        host.append(h('section', { class: 'mr-job', dataset: { job: g.jobId || '' } },
          h('div', { class: 'mr-job-head' }, h('h3', null, g.jobId ? h('a', { href: `#/jobs/${g.jobId}` }, g.label) : g.label), g.address ? h('span', { class: 'muted' }, g.address) : null,
            h('span', { class: 'grow' }), h('span', { class: 'muted' }, `${g.requests.length} item${g.requests.length === 1 ? '' : 's'}`)),
          h('div', { class: 'list card flat', style: { padding: 0 } }, g.requests.map((r) => row(r, { office: true })))));
      }
    };

    root.append(ui.page({ title: 'Material requests', subtitle: manager ? 'What the crew need, grouped by job' : 'Ask for material; the office gets one list a day' },
      form, schedHost, host));
    fillJobs(); drawPicks(); draw();
    if (ctx.query.new) setTimeout(() => what.focus(), 50);
    if (manager && auth.synced && app?.api) {
      app.api.get('/api/v1/material-requests/schedule').then((r) => { if (r.lastBatch) { lastBatch = { at: r.lastBatch.at, count: r.lastBatch.count }; drawSchedule(); } }).catch(() => { /* offline: the local schedule stands */ });
    }
    // Redraw on changes, but not under an open sheet or while typing in the form.
    let t = null;
    const off = store.on('*', (e) => {
      if (!['materialRequests', 'items', 'jobs', 'locations', 'settings'].includes(e.coll)) return;
      clearTimeout(t);
      t = setTimeout(() => { if (!document.querySelector('.sheet, .dialog')) draw(); }, 120);
    });
    const tick = setInterval(drawSchedule, 60_000);
    return () => { off(); clearTimeout(t); clearInterval(tick); };
  },
};
